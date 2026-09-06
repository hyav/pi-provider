import type {
	ModelCatalogDiscoveryResult,
	ProviderAdapter,
	ProviderModelDraft,
	ProviderRefreshContext,
} from "@hyav/pi-provider";
import {
	createModelCatalogLifecycle,
	defineProviderExtension,
	isLegacyNormalizedSnapshot,
	isProviderDataError,
	MAX_PROVIDER_MODEL_COUNT,
	ProviderDataError,
	parseRetryAfter,
	validateProviderModelDrafts,
	withDeadline,
} from "@hyav/pi-provider";

export const MAAS_PROVIDER_ID = "maas";
export const MAAS_PROVIDER_NAME = "MaaS";
export const MAAS_BASE_URL = "https://maas-api.antdigital.com/v1";
export const MAAS_MODELS_URL = `${MAAS_BASE_URL}/models`;
export const MAAS_API_KEY = "$MAAS_API_KEY";
export const MAAS_MODEL_CATALOG_TTL_MS = 4 * 60 * 60 * 1_000;

const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_NAME_LENGTH = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (normalized === "" || normalized.length > maxLength || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
		return undefined;
	}
	return normalized;
}

function parseMaaSModel(value: unknown): ProviderModelDraft | undefined {
	if (!isRecord(value)) return undefined;
	const id = safeText(value.id, MAX_MODEL_ID_LENGTH);
	if (!id) return undefined;
	const name = safeText(value.name, MAX_MODEL_NAME_LENGTH);
	return {
		id,
		...(name !== undefined && name.toLowerCase() !== id.toLowerCase() ? { name } : {}),
		api: "openai-completions",
		baseUrl: MAAS_BASE_URL,
	};
}

interface ParsedMaaSCatalog extends ModelCatalogDiscoveryResult {
	diagnostics: {
		rejectedCount: number;
		duplicateCount: number;
	};
}

function parseMaaSCatalog(payload: unknown): ParsedMaaSCatalog {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		return { models: [], diagnostics: { rejectedCount: 0, duplicateCount: 0 } };
	}
	if (payload.data.length > MAX_PROVIDER_MODEL_COUNT) {
		return {
			models: [],
			diagnostics: { rejectedCount: payload.data.length, duplicateCount: 0 },
		};
	}

	const models: ProviderModelDraft[] = [];
	const seenIds = new Set<string>();
	let rejectedCount = 0;
	let duplicateCount = 0;
	for (const value of payload.data) {
		const model = parseMaaSModel(value);
		if (!model) {
			rejectedCount++;
			continue;
		}
		const normalizedId = model.id.toLowerCase();
		if (seenIds.has(normalizedId)) {
			duplicateCount++;
			continue;
		}
		seenIds.add(normalizedId);
		models.push(model);
	}
	return { models, diagnostics: { rejectedCount, duplicateCount } };
}

export function parseMaaSModels(payload: unknown): ProviderModelDraft[] {
	return parseMaaSCatalog(payload).models;
}

function resolveMaaSApiKey(context: ProviderRefreshContext): string | undefined {
	if (context.credential?.type === "api_key") {
		const key = safeText(context.credential.key, 16_384);
		return key && key !== "proxy-managed" ? key : undefined;
	}
	const key = safeText(process.env.MAAS_API_KEY, 16_384);
	return key && key !== "proxy-managed" ? key : undefined;
}

async function discoverMaaSModels(
	fetchFn: typeof globalThis.fetch,
	timeoutMs: number,
	apiKey: string,
	now: () => number,
	externalSignal?: AbortSignal,
): Promise<ParsedMaaSCatalog> {
	return withDeadline(
		async (signal) => {
			const response = await fetchFn(MAAS_MODELS_URL, {
				headers: {
					Accept: "application/json",
					"Accept-Encoding": "identity",
					Authorization: `Bearer ${apiKey}`,
					"User-Agent": "@hyav/pi-provider",
				},
				signal,
			});
			if (!response.ok) {
				throw new ProviderDataError(
					`MaaS model discovery failed: HTTP ${response.status}`,
					response.status === 401 || response.status === 403 ? "auth" : `http${response.status}`,
					parseRetryAfter(response.headers.get("retry-after"), now()),
					response.status,
				);
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new ProviderDataError("MaaS model discovery returned invalid JSON", "badjson");
			}
			const parsed = parseMaaSCatalog(payload);
			if (parsed.models.length === 0) {
				throw new ProviderDataError("MaaS model discovery returned no valid models", "badjson");
			}
			validateProviderModelDrafts(parsed.models);
			return parsed;
		},
		timeoutMs,
		externalSignal,
	);
}

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

type MaaSModelsStoreEntry = ProviderRefreshContext["stored"];
type MaaSStoredModel = ProviderModelDraft & {
	provider: string;
	baseUrl: string;
	api: ProviderModelDraft["api"];
};

function draftsFromStoredModels(entry: MaaSModelsStoreEntry): ProviderModelDraft[] | undefined {
	if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return undefined;
	if (isLegacyNormalizedSnapshot(entry.models)) return undefined;
	const models = parseMaaSCatalog({ data: entry.models }).models;
	if (models.length === 0) return undefined;
	try {
		validateProviderModelDrafts(models);
		return models;
	} catch {
		return undefined;
	}
}

function storedModelsFromDrafts(models: ProviderModelDraft[]): MaaSStoredModel[] {
	validateProviderModelDrafts(models);
	return models.map((model) => ({
		id: model.id,
		...(typeof model.name === "string" && model.name.trim() !== "" ? { name: model.name.trim() } : {}),
		api: "openai-completions",
		provider: MAAS_PROVIDER_ID,
		baseUrl: MAAS_BASE_URL,
	}));
}

export function createMaaSAdapter(
	fetchFn: typeof globalThis.fetch,
	discoveryTimeoutMs: number,
	now: () => number = Date.now,
): ProviderAdapter {
	let provider: ProviderAdapter["provider"];
	const lifecycle = createModelCatalogLifecycle({
		ttlMs: MAAS_MODEL_CATALOG_TTL_MS,
		now,
		discover: (context) => {
			const apiKey = resolveMaaSApiKey(context);
			if (!apiKey) throw new ProviderDataError("MaaS model discovery requires an API key", "auth");
			return discoverMaaSModels(fetchFn, discoveryTimeoutMs, apiKey, now, context.signal);
		},
		restore: draftsFromStoredModels,
		persist: (models, checkedAt) => ({
			models: storedModelsFromDrafts(models) as unknown as NonNullable<MaaSModelsStoreEntry>["models"],
			checkedAt,
		}),
		onUpdate: (models) => {
			if (provider) provider.models = models;
		},
		errorCode: catalogErrorCode,
	});

	provider = {
		name: MAAS_PROVIDER_NAME,
		baseUrl: MAAS_BASE_URL,
		apiKey: MAAS_API_KEY,
		authHeader: true,
		api: "openai-completions",
		models: lifecycle.getModels(),
		refreshModels: lifecycle.refreshModels,
	};
	return { id: MAAS_PROVIDER_ID, catalog: lifecycle.catalog, lifecycle, provider };
}

const maasProviderExtension = defineProviderExtension({
	id: MAAS_PROVIDER_ID,
	create: ({ fetch, modelDiscoveryTimeoutMs, now }) => createMaaSAdapter(fetch, modelDiscoveryTimeoutMs, now),
});

export default maasProviderExtension;
