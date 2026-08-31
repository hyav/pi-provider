import type { ModelCatalogSource, ModelCatalogStatus, ProviderModelDraft, ProviderRefreshContext } from "./types.ts";

export interface ModelCatalogLifecycleOptions {
	initialModels?: ProviderModelDraft[];
	initialSource?: ModelCatalogSource;
	ttlMs: number;
	now?: () => number;
	discover(context: ProviderRefreshContext): Promise<ProviderModelDraft[]>;
	restore(stored: ProviderRefreshContext["stored"]): ProviderModelDraft[] | undefined;
	persist(models: ProviderModelDraft[], checkedAt: number): NonNullable<ProviderRefreshContext["stored"]>;
	onUpdate(models: ProviderModelDraft[]): void;
	errorCode(error: unknown): string;
}

export interface ModelCatalogLifecycle {
	catalog: ModelCatalogStatus;
	getModels(): ProviderModelDraft[];
	refreshModels(context: ProviderRefreshContext): Promise<ProviderModelDraft[]>;
}

function isAbortError(error: unknown): boolean {
	return error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";
}

function isValidTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function publish(
	context: ProviderRefreshContext,
	update: () => void,
	persist?: NonNullable<ProviderRefreshContext["stored"]>,
): Promise<boolean> {
	try {
		return await context.publish({ ...(persist ? { persist } : {}), update });
	} catch {
		if (!persist) return false;
		// Persistence is an optimization. Retry the generation-checked update without it.
		try {
			return await context.publish({ update });
		} catch {
			return false;
		}
	}
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function waitForCaller<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		void request.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

interface ActiveCatalogRefresh {
	request: Promise<ProviderModelDraft[]>;
	publication: Promise<void>;
	waiters: number;
	settled: boolean;
	applied: boolean;
	failureRecorded: boolean;
}

export function createModelCatalogLifecycle(options: ModelCatalogLifecycleOptions): ModelCatalogLifecycle {
	const now = options.now ?? Date.now;
	let models = [...(options.initialModels ?? [])];
	let lastRefreshAt: number | undefined;
	let lastCatalogUpdatedAt: number | undefined;
	let inFlight: ActiveCatalogRefresh | undefined;
	const catalog: ModelCatalogStatus = {
		source: options.initialSource ?? (models.length > 0 ? "static" : "empty"),
		modelCount: models.length,
	};

	const applyModels = (nextModels: ProviderModelDraft[], source: ModelCatalogSource, updatedAt?: number) => {
		models = [...nextModels];
		options.onUpdate(models);
		catalog.source = source;
		catalog.modelCount = models.length;
		catalog.lastError = undefined;
		if (updatedAt !== undefined) {
			catalog.updatedAt = updatedAt;
			lastCatalogUpdatedAt = updatedAt;
		}
	};

	const restoreStored = async (context: ProviderRefreshContext): Promise<void> => {
		const restored = options.restore(context.stored);
		if (!restored) return;
		const checkedAt = isValidTimestamp(context.stored?.checkedAt) ? context.stored.checkedAt : undefined;
		if (lastCatalogUpdatedAt !== undefined && (checkedAt === undefined || checkedAt <= lastCatalogUpdatedAt)) return;
		await publish(context, () => {
			applyModels(restored, "cached", checkedAt);
			if (checkedAt !== undefined) lastRefreshAt = checkedAt;
		});
	};

	const clearSettledRefresh = (active: ActiveCatalogRefresh) => {
		if (inFlight === active && active.settled && active.waiters === 0) inFlight = undefined;
	};

	const recordFailure = (active: ActiveCatalogRefresh, error: unknown) => {
		if (active.failureRecorded || isAbortError(error)) return;
		active.failureRecorded = true;
		lastRefreshAt = now();
		catalog.lastError = options.errorCode(error);
	};

	const startRefresh = (context: ProviderRefreshContext): ActiveCatalogRefresh => {
		const active: ActiveCatalogRefresh = {
			request: Promise.resolve([]),
			publication: Promise.resolve(),
			waiters: 0,
			settled: false,
			applied: false,
			failureRecorded: false,
		};
		const sharedContext = { ...context, signal: new AbortController().signal };
		active.request = Promise.resolve()
			.then(() => options.discover(sharedContext))
			.catch((error: unknown) => {
				recordFailure(active, error);
				throw error;
			})
			.finally(() => {
				active.settled = true;
				clearSettledRefresh(active);
			});
		inFlight = active;
		return active;
	};

	const refreshModels = async (context: ProviderRefreshContext): Promise<ProviderModelDraft[]> => {
		await restoreStored(context);
		if (context.allowNetwork !== true || context.signal.aborted) return [...models];

		const currentTime = now();
		const isFresh =
			lastRefreshAt !== undefined && Math.max(0, currentTime - lastRefreshAt) <= Math.max(0, options.ttlMs);
		if (!context.force && isFresh) return [...models];

		const active = inFlight ?? startRefresh(context);
		active.waiters++;
		try {
			const refreshed = await waitForCaller(active.request, context.signal);
			const attempt = active.publication.then(async () => {
				if (active.applied || context.signal.aborted) return;
				const updatedAt = now();
				await publish(
					context,
					() => {
						applyModels(refreshed, "live", updatedAt);
						lastRefreshAt = updatedAt;
						active.applied = true;
					},
					options.persist(refreshed, updatedAt),
				);
			});
			active.publication = attempt.catch(() => undefined);
			await waitForCaller(attempt, context.signal);
			return [...models];
		} catch (error) {
			if (!context.signal.aborted) recordFailure(active, error);
			throw error;
		} finally {
			active.waiters = Math.max(0, active.waiters - 1);
			clearSettledRefresh(active);
		}
	};

	options.onUpdate(models);
	return { catalog, getModels: () => [...models], refreshModels };
}
