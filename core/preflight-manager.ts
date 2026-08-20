import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deriveCredentialType } from "./credential-type.ts";
import { isValidTimeoutMs, withDeadline } from "./deadline.ts";
import { isProviderDataError, ProviderDataError } from "./errors.ts";

export type PreflightModel = NonNullable<ExtensionContext["model"]>;

type ModelRegistry = ExtensionContext["modelRegistry"];

export interface PreflightContext {
	fetch: typeof globalThis.fetch;
	getApiKey: () => Promise<string | undefined>;
	signal?: AbortSignal;
	now: () => number;
	model: PreflightModel;
	/** Optional non-secret credential metadata for provider-specific account labels. */
	getCredentialMetadata?: () => unknown;
	/** Optional non-secret credential type ("oauth" vs "api_key") for providers with dual auth modes. */
	getCredentialType?: () => Promise<string | undefined>;
}

export interface PreflightSnapshot {
	passed: boolean;
	checks: string[];
	updatedAt: number;
	httpStatus?: number;
}

export interface PreflightAdapter {
	id: string;
	providerId: string;
	name: string;
	cacheTtlMs: number;
	requestTimeoutMs: number;
	fetch(context: PreflightContext): Promise<PreflightSnapshot>;
}

export interface PreflightContextLike {
	model: PreflightModel;
	modelRegistry: Pick<ModelRegistry, "getApiKeyForProvider">;
	/** Optional non-secret credential metadata for provider-specific account labels. */
	getCredentialMetadata?: () => unknown;
}

export interface PreflightErrorState {
	code: string;
	retryAt?: number;
	httpStatus?: number;
}

export interface PreflightDiagnostics {
	snapshot?: PreflightSnapshot;
	pending: boolean;
	lastError?: PreflightErrorState;
}

export type PreflightUpdateResult = "cached" | "refreshed" | "failed" | "skipped";

interface PendingPreflight {
	promise: Promise<PreflightSnapshot>;
	generation: number;
	cancel: () => void;
}

interface PreflightState {
	snapshot?: PreflightSnapshot;
	pending?: PendingPreflight;
	lastError?: PreflightErrorState;
	generation: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorNamed(error: unknown, name: string): boolean {
	return error !== null && typeof error === "object" && "name" in error && error.name === name;
}

const MAX_PREFLIGHT_CHECKS = 32;
const MAX_PREFLIGHT_TEXT_LENGTH = 256;

function hasSafeText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim() !== "" &&
		value.length <= MAX_PREFLIGHT_TEXT_LENGTH &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function normalizePreflightSnapshot(value: unknown): PreflightSnapshot {
	if (!isRecord(value) || typeof value.passed !== "boolean" || !Array.isArray(value.checks)) {
		throw new ProviderDataError("Preflight adapter returned an invalid snapshot", "badjson");
	}
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
		throw new ProviderDataError("Preflight adapter returned an invalid snapshot", "badjson");
	}
	if (value.checks.length > MAX_PREFLIGHT_CHECKS) {
		throw new ProviderDataError("Preflight adapter returned too many checks", "badjson");
	}
	const checks = value.checks.map((check) => {
		if (!hasSafeText(check)) throw new ProviderDataError("Preflight adapter returned an invalid check", "badjson");
		return check.trim();
	});
	if (new Set(checks).size !== checks.length) {
		throw new ProviderDataError("Preflight adapter returned duplicate checks", "badjson");
	}
	if (value.httpStatus !== undefined) {
		if (
			typeof value.httpStatus !== "number" ||
			!Number.isInteger(value.httpStatus) ||
			value.httpStatus < 100 ||
			value.httpStatus > 599
		) {
			throw new ProviderDataError("Preflight adapter returned an invalid HTTP status", "badjson");
		}
	}
	return {
		passed: value.passed,
		checks,
		updatedAt: value.updatedAt,
		...(value.httpStatus !== undefined ? { httpStatus: value.httpStatus } : {}),
	};
}

function cloneSnapshot(snapshot: PreflightSnapshot): PreflightSnapshot {
	return { ...snapshot, checks: [...snapshot.checks] };
}

function errorState(error: unknown): PreflightErrorState {
	const dataError = isProviderDataError(error) ? error : undefined;
	if (dataError) {
		return {
			code: dataError.code,
			...(dataError.httpStatus !== undefined ? { httpStatus: dataError.httpStatus } : {}),
			...(dataError.retryAt !== undefined && Number.isFinite(dataError.retryAt)
				? { retryAt: dataError.retryAt }
				: {}),
		};
	}
	if (isErrorNamed(error, "TimeoutError")) return { code: "timeout" };
	if (isErrorNamed(error, "AbortError")) return { code: "cancelled" };
	if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
		return { code: error.code };
	}
	return { code: "fetch" };
}

export function getPreflightKey(provider: string, model: string): string {
	return JSON.stringify([provider, model]);
}

export class PreflightManager {
	private readonly states = new Map<string, PreflightState>();

	constructor(
		private readonly adapters: PreflightAdapter[],
		private readonly fetchFn: typeof globalThis.fetch,
		private readonly now: () => number,
	) {}

	async update(ctx: PreflightContextLike, options: { force?: boolean } = {}): Promise<PreflightUpdateResult> {
		const adapter = this.adapters.find(({ providerId }) => providerId === ctx.model.provider);
		if (!adapter) return "skipped";

		const state = this.getState(getPreflightKey(adapter.providerId, ctx.model.id));
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
						now: this.now,
						signal,
						model: ctx.model,
						...(ctx.getCredentialMetadata === undefined
							? {}
							: {
									getCredentialMetadata: ctx.getCredentialMetadata,
									getCredentialType: async () => deriveCredentialType(ctx.getCredentialMetadata?.()),
								}),
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
			const snapshot = normalizePreflightSnapshot(await activePending.promise);
			if (state.generation !== generation) return "skipped";
			state.snapshot = snapshot;
			state.lastError = undefined;
			return "refreshed";
		} catch (error) {
			if (state.generation !== generation || isErrorNamed(error, "AbortError")) return "skipped";
			state.lastError = errorState(error);
			if (state.lastError.code === "timeout") {
				state.generation++;
				if (state.pending === activePending) state.pending = undefined;
			}
			return "failed";
		} finally {
			if (state.generation === generation && state.pending === activePending) state.pending = undefined;
		}
	}

	async refresh(ctx: PreflightContextLike): Promise<PreflightUpdateResult> {
		return await this.update(ctx, { force: true });
	}

	cancelAll(): void {
		for (const state of this.states.values()) {
			state.generation++;
			state.pending?.cancel();
			state.pending = undefined;
		}
	}

	clear(): void {
		this.cancelAll();
		this.states.clear();
	}

	getDiagnostics(provider: string, model: string): PreflightDiagnostics {
		const state = this.states.get(getPreflightKey(provider, model));
		return {
			snapshot: state?.snapshot ? cloneSnapshot(state.snapshot) : undefined,
			pending: state?.pending !== undefined,
			lastError: state?.lastError ? { ...state.lastError } : undefined,
		};
	}

	private getState(key: string): PreflightState {
		const existing = this.states.get(key);
		if (existing) return existing;
		const state: PreflightState = { generation: 0 };
		this.states.set(key, state);
		return state;
	}
}
