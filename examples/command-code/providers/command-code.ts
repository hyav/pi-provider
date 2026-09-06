import type { ProviderAdapter, ProviderModelDraft, ProviderRefreshContext } from "@hyav/pi-provider";
import {
	createModelCatalogLifecycle,
	defineProviderExtension,
	isLegacyNormalizedSnapshot,
	isProviderDataError,
	ProviderDataError,
	parseRetryAfter,
	validateProviderModelDrafts,
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
type CommandCodeStoredModel = ProviderModelDraft & {
	provider: string;
	baseUrl: string;
	api: ProviderModelDraft["api"];
};

function draftsFromStoredModels(entry: CommandCodeModelsStoreEntry): ProviderModelDraft[] | undefined {
	if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return undefined;
	if (isLegacyNormalizedSnapshot(entry.models)) return undefined;
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
		validateProviderModelDrafts(drafts);
		return drafts;
	} catch {
		return undefined;
	}
}

function storedModelsFromDrafts(models: ProviderModelDraft[]): CommandCodeStoredModel[] {
	validateProviderModelDrafts(models);
	return models.map((model) => {
		const source = model.pricingSource;
		return {
			...model,
			name: typeof model.name === "string" && model.name.trim() !== "" ? model.name.trim() : model.id,
			...(source ? { pricingSource: source } : {}),
			api: model.api ?? "openai-completions",
			provider: COMMAND_CODE_PROVIDER_ID,
			baseUrl: model.baseUrl ?? COMMAND_CODE_BASE_URL,
		};
	});
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
	let provider: ProviderAdapter["provider"];
	const lifecycle = createModelCatalogLifecycle({
		initialModels: getCommandCodeFallbackModels(),
		initialSource: "fallback",
		ttlMs: COMMAND_CODE_MODEL_CATALOG_TTL_MS,
		now,
		discover: (context) => discoverCommandCodeModels(fetchFn, discoveryTimeoutMs, context.signal),
		restore: draftsFromStoredModels,
		persist: (models, checkedAt) => ({
			models: storedModelsFromDrafts(models) as unknown as NonNullable<CommandCodeModelsStoreEntry>["models"],
			checkedAt,
		}),
		onUpdate: (models) => {
			if (provider) provider.models = models;
		},
		errorCode: catalogErrorCode,
	});

	provider = {
		name: COMMAND_CODE_PROVIDER_NAME,
		baseUrl: COMMAND_CODE_BASE_URL,
		apiKey: COMMAND_CODE_API_KEY_VAR,
		authHeader: true,
		api: "openai-completions",
		models: lifecycle.getModels(),
		refreshModels: lifecycle.refreshModels,
		headers: getCommandCodeHeaders(),
	};

	return {
		id: COMMAND_CODE_PROVIDER_ID,
		catalog: lifecycle.catalog,
		lifecycle,
		provider,
	};
}

const commandCodeProviderExtension = defineProviderExtension({
	id: COMMAND_CODE_PROVIDER_ID,
	create: ({ fetch, modelDiscoveryTimeoutMs, now }) => createCommandCodeAdapter(fetch, modelDiscoveryTimeoutMs, now),
});

export default commandCodeProviderExtension;
