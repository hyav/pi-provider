import { deriveCredentialType } from "./credential-type.ts";
import { isValidTimeoutMs, withDeadline } from "./deadline.ts";
import { isProviderDataError, ProviderDataError } from "./errors.ts";
import type {
	StatusAdapter,
	StatusAmountEntry,
	StatusEntry,
	StatusSnapshot,
	StatusTextEntry,
	StatusWindowEntry,
} from "./types.ts";

export interface StatusContextLike {
	model?: { provider?: string };
	modelRegistry: {
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
	};
	/** Optional credential identity used to isolate cached account data. */
	getCredentialKey?: () => Promise<string | undefined>;
	/** Optional non-secret credential metadata for provider-specific account labels. */
	getCredentialMetadata?: () => unknown;
}

export interface StatusErrorState {
	code: string;
	httpStatus?: number;
	retryAt?: number;
}

export interface StatusDiagnostics {
	snapshot?: StatusSnapshot;
	pending: boolean;
	lastError?: StatusErrorState;
}

export type StatusUpdateResult = "cached" | "refreshed" | "failed" | "skipped";

interface PendingStatus {
	promise: Promise<StatusSnapshot>;
	generation: number;
	cancel: () => void;
}

interface StatusState {
	snapshot?: StatusSnapshot;
	pending?: PendingStatus;
	lastError?: StatusErrorState;
	credentialKey?: string;
	credentialKeyKnown: boolean;
	generation: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorNamed(error: unknown, name: string): boolean {
	return error !== null && typeof error === "object" && "name" in error && error.name === name;
}

const MAX_STATUS_ENTRIES = 128;
const MAX_STATUS_TEXT_LENGTH = 1_024;

function hasSafeText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim() !== "" &&
		value.length <= MAX_STATUS_TEXT_LENGTH &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

function optionalFiniteNumber(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new ProviderDataError("Status adapter returned an invalid snapshot", "badjson");
}

function normalizeTextEntry(value: Record<string, unknown>): StatusTextEntry {
	if (!hasSafeText(value.id) || !hasSafeText(value.label) || !hasSafeText(value.value)) {
		throw new ProviderDataError("Status adapter returned an invalid text entry", "badjson");
	}
	return {
		kind: "text",
		id: value.id.trim(),
		label: value.label.trim(),
		value: value.value.trim(),
	};
}

function normalizeAmountEntry(value: Record<string, unknown>): StatusAmountEntry {
	if (!hasSafeText(value.id) || !hasSafeText(value.label) || !hasSafeText(value.unit)) {
		throw new ProviderDataError("Status adapter returned an invalid amount entry", "badjson");
	}
	if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
		throw new ProviderDataError("Status adapter returned an invalid amount entry", "badjson");
	}
	return {
		kind: "amount",
		id: value.id.trim(),
		label: value.label.trim(),
		value: value.value,
		unit: value.unit.trim(),
	};
}

function normalizeWindowEntry(value: Record<string, unknown>): StatusWindowEntry {
	if (!hasSafeText(value.id) || !hasSafeText(value.label)) {
		throw new ProviderDataError("Status adapter returned an invalid window entry", "badjson");
	}
	if (
		typeof value.remainingPercent !== "number" ||
		!Number.isFinite(value.remainingPercent) ||
		value.remainingPercent < 0 ||
		value.remainingPercent > 100
	) {
		throw new ProviderDataError("Status adapter returned an invalid window entry", "badjson");
	}
	const resetAt = optionalFiniteNumber(value.resetAt);
	if (resetAt !== undefined && resetAt < 0) {
		throw new ProviderDataError("Status adapter returned an invalid window entry", "badjson");
	}
	return {
		kind: "window",
		id: value.id.trim(),
		label: value.label.trim(),
		remainingPercent: value.remainingPercent,
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

function normalizeEntry(value: unknown): StatusEntry {
	if (!isRecord(value) || typeof value.kind !== "string") {
		throw new ProviderDataError("Status adapter returned an invalid entry", "badjson");
	}
	switch (value.kind) {
		case "text":
			return normalizeTextEntry(value);
		case "amount":
			return normalizeAmountEntry(value);
		case "window":
			return normalizeWindowEntry(value);
		default:
			throw new ProviderDataError("Status adapter returned an unknown entry kind", "badjson");
	}
}

function cloneEntry(entry: StatusEntry): StatusEntry {
	return { ...entry };
}

export function normalizeStatusSnapshot(value: unknown): StatusSnapshot {
	if (!isRecord(value) || !Array.isArray(value.entries)) {
		throw new ProviderDataError("Status adapter returned an invalid snapshot", "badjson");
	}
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
		throw new ProviderDataError("Status adapter returned an invalid snapshot", "badjson");
	}
	if (value.entries.length > MAX_STATUS_ENTRIES) {
		throw new ProviderDataError("Status adapter returned too many entries", "badjson");
	}
	const ids = new Set<string>();
	const entries = value.entries.map((entry) => {
		const normalized = normalizeEntry(entry);
		if (ids.has(normalized.id)) {
			throw new ProviderDataError("Status adapter returned duplicate entry IDs", "badjson");
		}
		ids.add(normalized.id);
		return normalized;
	});
	return { entries, updatedAt: value.updatedAt };
}

function cloneSnapshot(snapshot: StatusSnapshot): StatusSnapshot {
	return { updatedAt: snapshot.updatedAt, entries: snapshot.entries.map(cloneEntry) };
}

export class StatusManager {
	private readonly states = new Map<string, StatusState>();

	constructor(
		private readonly adapters: StatusAdapter[],
		private readonly fetchFn: typeof globalThis.fetch,
		private readonly now: () => number,
	) {}

	async update(ctx: StatusContextLike, options: { force?: boolean } = {}): Promise<StatusUpdateResult> {
		const adapter = this.adapters.find(({ providerId }) => providerId === ctx.model?.provider);
		if (!adapter) return "skipped";

		const state = this.getState(adapter.providerId);
		let credentialKey: string | undefined;
		let credentialKeyKnown = false;
		if (options.force && ctx.getCredentialKey) {
			try {
				credentialKey = await ctx.getCredentialKey();
				credentialKeyKnown = true;
			} catch {
				// The adapter remains responsible for reporting credential resolution failures.
			}
		}
		if (credentialKeyKnown && state.credentialKeyKnown && state.credentialKey !== credentialKey) {
			state.generation++;
			state.pending?.cancel();
			state.pending = undefined;
			state.snapshot = undefined;
			state.lastError = undefined;
		}
		const now = this.now();
		const snapshotAge = state.snapshot ? now - state.snapshot.updatedAt : undefined;
		if (!options.force && snapshotAge !== undefined && snapshotAge >= 0 && snapshotAge < adapter.cacheTtlMs) {
			return "cached";
		}
		const retryAt = state.lastError?.retryAt;
		if (retryAt !== undefined && Number.isFinite(retryAt) && now < retryAt) return "skipped";
		if (!isValidTimeoutMs(adapter.requestTimeoutMs)) {
			state.lastError = { code: "config" };
			return "failed";
		}

		let pending = state.pending;
		if (!pending) {
			const cancellation = new AbortController();
			const generation = ++state.generation;
			const promise = withDeadline(
				(signal) =>
					adapter.fetch({
						fetch: this.fetchFn,
						getApiKey: () => ctx.modelRegistry.getApiKeyForProvider(adapter.providerId),
						...(ctx.getCredentialMetadata === undefined
							? {}
							: {
									getCredentialMetadata: ctx.getCredentialMetadata,
									getCredentialType: async () => deriveCredentialType(ctx.getCredentialMetadata?.()),
								}),
						now: this.now,
						signal,
					}),
				adapter.requestTimeoutMs,
				cancellation.signal,
			);
			pending = {
				promise,
				generation,
				cancel: () => cancellation.abort(),
			};
			state.pending = pending;
		}
		const activePending = pending;
		const { generation } = activePending;

		try {
			const snapshot = normalizeStatusSnapshot(await activePending.promise);
			if (state.generation !== generation) return "skipped";
			state.snapshot = snapshot;
			state.lastError = undefined;
			if (credentialKeyKnown) {
				state.credentialKey = credentialKey;
				state.credentialKeyKnown = true;
			}
			return "refreshed";
		} catch (error) {
			if (state.generation !== generation || isErrorNamed(error, "AbortError")) return "skipped";
			const dataError = isProviderDataError(error) ? error : undefined;
			const code = dataError?.code ?? (isErrorNamed(error, "TimeoutError") ? "timeout" : "fetch");
			const retryAt =
				dataError?.retryAt !== undefined && Number.isFinite(dataError.retryAt) ? dataError.retryAt : undefined;
			const httpStatus = dataError?.httpStatus;
			state.lastError = {
				code,
				...(httpStatus !== undefined ? { httpStatus } : {}),
				...(retryAt !== undefined ? { retryAt } : {}),
			};
			if (code === "timeout") {
				state.generation++;
				if (state.pending === activePending) state.pending = undefined;
			}
			return "failed";
		} finally {
			if (state.generation === generation && state.pending === activePending) state.pending = undefined;
		}
	}

	async refresh(ctx: StatusContextLike): Promise<StatusUpdateResult> {
		return await this.update(ctx, { force: true });
	}

	invalidate(provider: string | undefined): void {
		if (!provider) return;
		const state = this.states.get(provider);
		if (!state) return;
		state.generation++;
		state.pending?.cancel();
		state.pending = undefined;
		state.snapshot = undefined;
		state.lastError = undefined;
	}

	cancelAll(): void {
		for (const state of this.states.values()) {
			state.generation++;
			state.pending?.cancel();
			state.pending = undefined;
		}
	}

	clear(provider?: string): void {
		if (provider) {
			this.invalidate(provider);
			this.states.delete(provider);
		} else {
			this.cancelAll();
			this.states.clear();
		}
	}

	getSnapshot(provider: string): StatusSnapshot | undefined {
		const snapshot = this.states.get(provider)?.snapshot;
		return snapshot ? cloneSnapshot(snapshot) : undefined;
	}

	getDiagnostics(provider: string): StatusDiagnostics {
		const state = this.states.get(provider);
		return {
			snapshot: state?.snapshot ? cloneSnapshot(state.snapshot) : undefined,
			pending: state?.pending !== undefined,
			lastError: state?.lastError ? { ...state.lastError } : undefined,
		};
	}

	private getState(provider: string): StatusState {
		const existing = this.states.get(provider);
		if (existing) return existing;
		const state: StatusState = { credentialKeyKnown: false, generation: 0 };
		this.states.set(provider, state);
		return state;
	}
}
