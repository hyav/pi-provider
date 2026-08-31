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

export function createModelCatalogLifecycle(options: ModelCatalogLifecycleOptions): ModelCatalogLifecycle {
	const now = options.now ?? Date.now;
	let models = [...(options.initialModels ?? [])];
	let lastRefreshAt: number | undefined;
	let lastCatalogUpdatedAt: number | undefined;
	let inFlight: { signal: AbortSignal; request: Promise<ProviderModelDraft[]> } | undefined;
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

	const refreshModels = async (context: ProviderRefreshContext): Promise<ProviderModelDraft[]> => {
		await restoreStored(context);
		if (context.allowNetwork !== true || context.signal.aborted) return [...models];

		const currentTime = now();
		const isFresh =
			lastRefreshAt !== undefined && Math.max(0, currentTime - lastRefreshAt) <= Math.max(0, options.ttlMs);
		if (!context.force && isFresh) return [...models];
		if (inFlight?.signal === context.signal) return inFlight.request;

		const request = (async (): Promise<ProviderModelDraft[]> => {
			try {
				const refreshed = await options.discover(context);
				if (context.signal.aborted) {
					throw context.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
				}
				const updatedAt = now();
				await publish(
					context,
					() => {
						applyModels(refreshed, "live", updatedAt);
						lastRefreshAt = updatedAt;
					},
					options.persist(refreshed, updatedAt),
				);
				return [...models];
			} catch (error) {
				if (!context.signal.aborted && !isAbortError(error)) {
					lastRefreshAt = now();
					catalog.lastError = options.errorCode(error);
				}
				throw error;
			}
		})();
		const active = { signal: context.signal, request };
		inFlight = active;
		void request.then(
			() => {
				if (inFlight === active) inFlight = undefined;
			},
			() => {
				if (inFlight === active) inFlight = undefined;
			},
		);
		return request;
	};

	options.onUpdate(models);
	return { catalog, getModels: () => [...models], refreshModels };
}
