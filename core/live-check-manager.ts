import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isValidTimeoutMs, withDeadline } from "./deadline.ts";
import { parseRetryAfter } from "./retry-after.ts";

type LiveCheckModel = NonNullable<ExtensionContext["model"]>;
type ModelRegistry = ExtensionContext["modelRegistry"];
type LiveCheckProvider = NonNullable<ReturnType<ModelRegistry["getProvider"]>>;
type LiveCheckContext = Parameters<LiveCheckProvider["streamSimple"]>[1];
type LiveCheckOptions = NonNullable<Parameters<LiveCheckProvider["streamSimple"]>[2]>;
type LiveCheckPayloadTransform = NonNullable<LiveCheckOptions["onPayload"]>;

export interface LiveCheckContextLike {
	model: LiveCheckModel;
	modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders" | "getProvider">;
	onPayload?: LiveCheckPayloadTransform;
}

export const LIVE_CHECK_SCOPE = "provider-stream" as const;

export interface LiveCheckSnapshot {
	/** Scope of the built-in live check; optional for compatibility with older snapshots. */
	scope?: typeof LIVE_CHECK_SCOPE;
	provider: string;
	model: string;
	checkedAt: number;
	latencyMs: number;
	httpStatus?: number;
}

export interface LiveCheckErrorState {
	code: string;
	httpStatus?: number;
	retryAt?: number;
}

export interface LiveCheckDiagnostics {
	snapshot?: LiveCheckSnapshot;
	pending: boolean;
	lastError?: LiveCheckErrorState;
}

export type LiveCheckResult = "verified" | "failed" | "skipped";

interface PendingLiveCheck {
	promise: Promise<LiveCheckSnapshot>;
	generation: number;
	cancel: () => void;
}

interface LiveCheckState {
	snapshot?: LiveCheckSnapshot;
	pending?: PendingLiveCheck;
	lastError?: LiveCheckErrorState;
	generation: number;
}

class LiveCheckFailure extends Error {
	override readonly name = "LiveCheckFailure";

	constructor(
		readonly code: string,
		message: string,
		readonly httpStatus?: number,
		readonly retryAt?: number,
	) {
		super(message);
	}
}

function isErrorNamed(error: unknown, name: string): boolean {
	return error !== null && typeof error === "object" && "name" in error && error.name === name;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function errorCode(error: unknown, httpStatus: number | undefined, retryAt: number | undefined): LiveCheckErrorState {
	if (error instanceof LiveCheckFailure) {
		const status = error.httpStatus ?? httpStatus;
		return {
			code: error.code,
			...(status !== undefined ? { httpStatus: status } : {}),
			...((error.retryAt ?? retryAt) ? { retryAt: error.retryAt ?? retryAt } : {}),
		};
	}
	if (isErrorNamed(error, "TimeoutError")) {
		return { code: "timeout", ...(httpStatus !== undefined ? { httpStatus } : {}), ...(retryAt ? { retryAt } : {}) };
	}
	if (isErrorNamed(error, "AbortError")) {
		return {
			code: "cancelled",
			...(httpStatus !== undefined ? { httpStatus } : {}),
			...(retryAt ? { retryAt } : {}),
		};
	}
	if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
		return { code: error.code, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(retryAt ? { retryAt } : {}) };
	}
	return { code: httpStatus !== undefined ? `http${httpStatus}` : "upstream", ...(retryAt ? { retryAt } : {}) };
}

function cloneSnapshot(snapshot: LiveCheckSnapshot): LiveCheckSnapshot {
	return { ...snapshot };
}

export function getLiveCheckKey(provider: string, model: string): string {
	return JSON.stringify([provider, model]);
}

export class LiveCheckManager {
	private readonly states = new Map<string, LiveCheckState>();
	private readonly requestTimeoutMs: number;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly now: () => number;

	constructor(requestTimeoutMs: number, now: () => number);
	constructor(requestTimeoutMs: number, fetchFn: typeof globalThis.fetch, now: () => number);
	constructor(requestTimeoutMs: number, fetchOrNow: typeof globalThis.fetch | (() => number), now?: () => number) {
		this.requestTimeoutMs = requestTimeoutMs;
		if (now) {
			this.fetchFn = fetchOrNow as typeof globalThis.fetch;
			this.now = now;
		} else {
			this.fetchFn = globalThis.fetch;
			this.now = fetchOrNow as () => number;
		}
	}

	async check(ctx: LiveCheckContextLike): Promise<LiveCheckResult> {
		const key = getLiveCheckKey(ctx.model.provider, ctx.model.id);
		const state = this.getState(key);
		if (!isValidTimeoutMs(this.requestTimeoutMs)) {
			state.lastError = { code: "config" };
			return "failed";
		}
		const retryAt = state.lastError?.retryAt;
		if (retryAt !== undefined && Number.isFinite(retryAt) && this.now() < retryAt) return "skipped";

		let pending = state.pending;
		if (!pending) {
			const cancellation = new AbortController();
			const generation = ++state.generation;
			const promise = withDeadline(
				(signal) => this.execute(ctx, signal),
				this.requestTimeoutMs,
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
			const snapshot = await activePending.promise;
			if (state.generation !== generation) return "skipped";
			state.snapshot = snapshot;
			state.lastError = undefined;
			return "verified";
		} catch (error) {
			if (state.generation !== generation || isErrorNamed(error, "AbortError")) return "skipped";
			state.lastError = errorCode(error, undefined, undefined);
			return "failed";
		} finally {
			if (state.generation === generation && state.pending === activePending) state.pending = undefined;
		}
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

	getDiagnostics(provider: string, model: string): LiveCheckDiagnostics {
		const state = this.states.get(getLiveCheckKey(provider, model));
		return {
			snapshot: state?.snapshot ? cloneSnapshot(state.snapshot) : undefined,
			pending: state?.pending !== undefined,
			lastError: state?.lastError ? { ...state.lastError } : undefined,
		};
	}

	private async execute(ctx: LiveCheckContextLike, signal: AbortSignal): Promise<LiveCheckSnapshot> {
		throwIfAborted(signal);
		const startedAt = this.now();
		const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
		if (!provider) throw new LiveCheckFailure("unsupported", "Provider is not available in Pi");

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		throwIfAborted(signal);
		if (!auth.ok) throw new LiveCheckFailure("auth", auth.error);

		let httpStatus: number | undefined;
		let retryAt: number | undefined;
		const context: LiveCheckContext = {
			systemPrompt: "",
			messages: [{ role: "user", content: "Reply with OK.", timestamp: this.now() }],
		};
		const options: LiveCheckOptions = {
			signal,
			maxTokens: 1,
			maxRetries: 0,
			reasoning: undefined,
			fetch: this.fetchFn,
			...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
			...(auth.headers !== undefined ? { headers: auth.headers } : {}),
			...(auth.env !== undefined ? { env: auth.env } : {}),
			...(ctx.onPayload !== undefined ? { onPayload: ctx.onPayload } : {}),
			onResponse: (response) => {
				httpStatus = response.status;
				const retryAfter = Object.entries(response.headers).find(
					([name]) => name.toLowerCase() === "retry-after",
				)?.[1];
				retryAt = parseRetryAfter(retryAfter ?? null, this.now());
			},
		};
		throwIfAborted(signal);
		const stream = provider.streamSimple(ctx.model, context, options);
		let completed = false;
		for await (const event of stream) {
			if (event.type === "error") {
				throw new LiveCheckFailure(
					"upstream",
					event.error.errorMessage ?? "Live check stream failed",
					httpStatus,
					retryAt,
				);
			}
			if (event.type === "done") completed = true;
		}
		if (!completed) throw new LiveCheckFailure("parse", "Live check stream ended without a result", httpStatus);

		return {
			scope: LIVE_CHECK_SCOPE,
			provider: ctx.model.provider,
			model: ctx.model.id,
			checkedAt: this.now(),
			latencyMs: Math.max(0, this.now() - startedAt),
			...(httpStatus !== undefined ? { httpStatus } : {}),
		};
	}

	private getState(key: string): LiveCheckState {
		const existing = this.states.get(key);
		if (existing) return existing;
		const state: LiveCheckState = { generation: 0 };
		this.states.set(key, state);
		return state;
	}
}
