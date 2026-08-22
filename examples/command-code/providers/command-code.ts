import type {
	ModelCatalogStatus,
	ProviderAdapter,
	ProviderModelDraft,
	ProviderRefreshContext,
} from "@hyav/pi-provider";
import {
	defineProviderExtension,
	isProviderDataError,
	normalizeProviderModels,
	ProviderDataError,
	parseRetryAfter,
	withDeadline,
} from "@hyav/pi-provider";
import { resolveCommandCodeApiKey, syncCommandCodeEnv } from "./command-code/auth.ts";
import {
	COMMAND_CODE_API_KEY_VAR,
	COMMAND_CODE_BASE_URL,
	COMMAND_CODE_MODEL_CATALOG_TTL_MS,
	COMMAND_CODE_MODELS_URL,
	COMMAND_CODE_PROVIDER_ID,
	COMMAND_CODE_PROVIDER_NAME,
	getCommandCodeFallbackModels,
	getCommandCodeHeaders,
	isRecord,
	normalizeCommandCodeModelId,
	parseCommandCodeModels,
	resolveModelDraft,
} from "./command-code/catalog.ts";

export { resolveCommandCodeApiKey, syncCommandCodeEnv } from "./command-code/auth.ts";
export {
	COMMAND_CODE_ANTHROPIC_BASE_URL,
	COMMAND_CODE_API_KEY_VAR,
	COMMAND_CODE_BASE_URL,
	COMMAND_CODE_MODEL_CATALOG_TTL_MS,
	COMMAND_CODE_MODELS_URL,
	COMMAND_CODE_PROVIDER_ID,
	COMMAND_CODE_PROVIDER_NAME,
	getCommandCodeFallbackModels,
	parseCommandCodeModels,
} from "./command-code/catalog.ts";

function isAbortError(error: unknown): boolean {
	return error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";
}

function catalogErrorCode(error: unknown): string {
	if (isAbortError(error)) return "cancelled";
	if (isProviderDataError(error)) return error.code;
	if (error !== null && typeof error === "object" && "name" in error && error.name === "TimeoutError") {
		return "timeout";
	}
	return "fetch";
}

type CommandCodeModelsStoreEntry = ProviderRefreshContext["stored"];
type CommandCodeStoredModel = NonNullable<CommandCodeModelsStoreEntry>["models"][number] & {
	pricingSource?: ProviderModelDraft["pricingSource"];
};

function isValidTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function draftsFromStoredModels(entry: CommandCodeModelsStoreEntry): ProviderModelDraft[] | undefined {
	if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return undefined;
	const drafts: ProviderModelDraft[] = [];
	const seenIds = new Set<string>();

	for (const stored of entry.models) {
		if (!isRecord(stored) || typeof stored.id !== "string") continue;
		const id = stored.id.trim();
		if (!id) continue;
		const normalizedId = normalizeCommandCodeModelId(id);
		if (seenIds.has(normalizedId)) continue;
		seenIds.add(normalizedId);

		const draft = resolveModelDraft({
			id,
			name: typeof stored.name === "string" ? stored.name : undefined,
			context_length: typeof stored.contextWindow === "number" ? stored.contextWindow : undefined,
		});
		if (draft) drafts.push(draft);
	}

	if (drafts.length === 0) return undefined;
	try {
		normalizeProviderModels(drafts);
		return drafts;
	} catch {
		return undefined;
	}
}

function storedModelsFromDrafts(models: ProviderModelDraft[]): CommandCodeStoredModel[] {
	return normalizeProviderModels(models).map((model) => {
		const source = models.find(({ id }) => id === model.id)?.pricingSource;
		return {
			...model,
			...(source ? { pricingSource: source } : {}),
			api: model.api ?? "openai-completions",
			provider: COMMAND_CODE_PROVIDER_ID,
			baseUrl: model.baseUrl ?? COMMAND_CODE_BASE_URL,
		};
	});
}

async function publishCatalog(
	context: ProviderRefreshContext,
	models: ProviderModelDraft[],
	checkedAt: number,
	update: () => void,
): Promise<boolean> {
	try {
		return await context.publish({
			persist: { models: storedModelsFromDrafts(models), checkedAt },
			update,
		});
	} catch {
		try {
			return await context.publish({ update });
		} catch {
			return false;
		}
	}
}

async function discoverCommandCodeModels(
	fetchFn: typeof globalThis.fetch,
	timeoutMs: number,
	externalSignal?: AbortSignal,
): Promise<ProviderModelDraft[]> {
	return withDeadline(
		async (signal) => {
			const headers: Record<string, string> = {
				Accept: "application/json",
				"Accept-Encoding": "identity",
			};
			const dynamicHeaders = getCommandCodeHeaders();
			if (dynamicHeaders) {
				Object.assign(headers, dynamicHeaders);
			}

			const apiKey = resolveCommandCodeApiKey();
			if (apiKey) {
				headers.Authorization = `Bearer ${apiKey}`;
			}

			const response = await fetchFn(COMMAND_CODE_MODELS_URL, {
				signal,
				headers,
			});

			if (!response.ok) {
				throw new ProviderDataError(
					`Command Code model discovery failed: HTTP ${response.status}`,
					`http${response.status}`,
					parseRetryAfter(response.headers.get("retry-after"), Date.now()),
					response.status,
				);
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new ProviderDataError(
					`Command Code model discovery returned invalid JSON from ${COMMAND_CODE_MODELS_URL}`,
					"badjson",
				);
			}

			const models = parseCommandCodeModels(payload);
			if (models.length === 0) {
				throw new ProviderDataError("Command Code model discovery returned no valid models", "badjson");
			}

			return models;
		},
		timeoutMs,
		externalSignal,
	);
}

export function createCommandCodeAdapter(
	fetchFn: typeof globalThis.fetch,
	discoveryTimeoutMs: number,
	now: () => number = Date.now,
): ProviderAdapter {
	syncCommandCodeEnv();
	let models = getCommandCodeFallbackModels();
	let lastRefreshAt: number | undefined;
	let lastCatalogUpdatedAt: number | undefined;
	let inFlightRefresh: { signal: AbortSignal | undefined; request: Promise<ProviderModelDraft[]> } | undefined;

	const catalog: ModelCatalogStatus = {
		source: "fallback",
		modelCount: models.length,
	};
	let provider: ProviderAdapter["provider"];

	const publishModels = (
		nextModels: ProviderModelDraft[],
		source: ModelCatalogStatus["source"],
		updatedAt?: number,
	) => {
		models = nextModels;
		provider.models = models;
		catalog.source = source;
		catalog.modelCount = models.length;
		catalog.lastError = undefined;
		if (updatedAt !== undefined) {
			catalog.updatedAt = updatedAt;
			lastCatalogUpdatedAt = updatedAt;
		}
	};

	const restoreStoredModels = async (
		context: ProviderRefreshContext,
		entry: CommandCodeModelsStoreEntry,
	): Promise<void> => {
		const restoredModels = draftsFromStoredModels(entry);
		if (!restoredModels) return;

		const checkedAt = isValidTimestamp(entry?.checkedAt) ? entry.checkedAt : undefined;
		if (lastCatalogUpdatedAt !== undefined && checkedAt !== undefined && checkedAt <= lastCatalogUpdatedAt) {
			return;
		}
		if (lastCatalogUpdatedAt !== undefined && checkedAt === undefined) return;

		try {
			await context.publish({
				update: () => {
					publishModels(restoredModels, "live", checkedAt);
					if (checkedAt !== undefined) lastRefreshAt = checkedAt;
				},
			});
		} catch {
			// A stale or cancelled refresh must not replace the current in-memory catalog.
		}
	};

	const isFresh = (timestamp: number | undefined, currentTime: number): boolean =>
		timestamp !== undefined && Math.max(0, currentTime - timestamp) <= COMMAND_CODE_MODEL_CATALOG_TTL_MS;

	const refreshModels = async (context: ProviderRefreshContext): Promise<ProviderModelDraft[]> => {
		await restoreStoredModels(context, context.stored);
		if (context?.allowNetwork !== true || context.signal?.aborted) {
			return [...models];
		}

		const currentTime = now();
		if (!context.force && isFresh(lastRefreshAt, currentTime)) {
			return [...models];
		}
		if (inFlightRefresh && inFlightRefresh.signal === context.signal) {
			return inFlightRefresh.request;
		}

		const request = (async (): Promise<ProviderModelDraft[]> => {
			try {
				const refreshedModels = await discoverCommandCodeModels(fetchFn, discoveryTimeoutMs, context.signal);
				if (context.signal?.aborted) {
					throw context.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
				}
				const updatedAt = now();
				await publishCatalog(context, refreshedModels, updatedAt, () => {
					publishModels(refreshedModels, "live", updatedAt);
					lastRefreshAt = updatedAt;
				});
				return [...models];
			} catch (error) {
				if (!context.signal?.aborted && !isAbortError(error)) {
					lastRefreshAt = now();
					catalog.lastError = catalogErrorCode(error);
				}
				throw error;
			}
		})();

		const activeRefresh = { signal: context.signal, request };
		inFlightRefresh = activeRefresh;
		void request.then(
			() => {
				if (inFlightRefresh === activeRefresh) inFlightRefresh = undefined;
			},
			() => {
				if (inFlightRefresh === activeRefresh) inFlightRefresh = undefined;
			},
		);

		return request;
	};

	provider = {
		name: COMMAND_CODE_PROVIDER_NAME,
		baseUrl: COMMAND_CODE_BASE_URL,
		apiKey: COMMAND_CODE_API_KEY_VAR,
		authHeader: true,
		api: "openai-completions",
		models,
		refreshModels,
		headers: getCommandCodeHeaders(),
	};

	return {
		id: COMMAND_CODE_PROVIDER_ID,
		catalog,
		provider,
	};
}

const commandCodeProviderExtension = defineProviderExtension({
	id: COMMAND_CODE_PROVIDER_ID,
	create: ({ fetch, modelDiscoveryTimeoutMs, now }) => createCommandCodeAdapter(fetch, modelDiscoveryTimeoutMs, now),
});

export default commandCodeProviderExtension;
