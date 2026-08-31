import type {
	ProviderAdapter,
	ProviderModel,
	ProviderModelDraft,
	ProviderRefreshContext,
	ThinkingLevel,
} from "@hyav/pi-provider";
import {
	createModelCatalogLifecycle,
	defineProviderExtension,
	isProviderDataError,
	MAX_PROVIDER_MODEL_COUNT,
	normalizeProviderModels,
	ProviderDataError,
	withDeadline,
} from "@hyav/pi-provider";
import { HYPER_BASE_URL, HYPER_USER_AGENT, hyperJsonHeaders } from "./charm-hyper/constants.ts";
import { createCharmHyperOAuth } from "./charm-hyper/oauth.ts";

export { HYPER_BASE_URL, HYPER_USER_AGENT } from "./charm-hyper/constants.ts";
export const HYPER_PROVIDER_URL = "https://hyper.charm.land/v1/provider";
export const HYPER_MODELS_URL = "https://hyper.charm.land/v1/models";
export const HYPER_MODEL_CATALOG_TTL_MS = 4 * 60 * 60 * 1_000;

const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const baseHyperCompat: NonNullable<ProviderModel["compat"]> = {
	supportsStore: false,
	thinkingFormat: "deepseek",
	maxTokensField: "max_tokens",
};
const hyperModelHeaders = { "User-Agent": HYPER_USER_AGENT };
const onOffThinkingLevelMap: NonNullable<ProviderModel["thinkingLevelMap"]> = {
	off: "off",
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: "max",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function mapHyperPricing(value: unknown): ProviderModel["cost"] | undefined {
	if (!isRecord(value)) return undefined;
	if (!isFiniteNonNegative(value.input) || !isFiniteNonNegative(value.output)) return undefined;
	if (value.cache_hit !== undefined && !isFiniteNonNegative(value.cache_hit)) return undefined;
	if (value.cache_create !== undefined && !isFiniteNonNegative(value.cache_create)) return undefined;
	if (!("input" in value) && !("output" in value) && !("cache_hit" in value) && !("cache_create" in value)) {
		return undefined;
	}
	return {
		input: value.input,
		output: value.output,
		cacheRead: value.cache_hit ?? 0,
		cacheWrite: value.cache_create ?? 0,
	};
}

function buildThinkingLevelMap(levels: readonly string[]): NonNullable<ProviderModel["thinkingLevelMap"]> {
	const available = new Set(levels);
	return {
		off: available.has("off") ? "off" : null,
		minimal: available.has("minimal") ? "minimal" : null,
		low: available.has("low") ? "low" : null,
		medium: available.has("medium") ? "medium" : null,
		high: available.has("high") ? "high" : null,
		xhigh: available.has("xhigh") ? "xhigh" : null,
		max: available.has("max") ? "max" : null,
	};
}

function readEffortLevels(model: Record<string, unknown>): ThinkingLevel[] {
	const reasoning = isRecord(model.reasoning) ? model.reasoning : undefined;
	const currentLevels = Array.isArray(reasoning?.effort_levels)
		? reasoning.effort_levels.filter(isRecord).map(({ value }) => value)
		: [];
	const legacyLevels = Array.isArray(model.reasoning_effort_levels) ? model.reasoning_effort_levels : [];
	return (currentLevels.length > 0 ? currentLevels : legacyLevels).filter(
		(level): level is ThinkingLevel => typeof level === "string" && thinkingLevels.has(level as ThinkingLevel),
	);
}

function parseCurrentHyperModel(value: unknown): ProviderModelDraft | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || value.id.trim() === "") return undefined;
	if (typeof value.name !== "string" || value.name.trim() === "") return undefined;
	if (!isFiniteNonNegative(value.cost_per_1m_in)) return undefined;
	if (!isFiniteNonNegative(value.cost_per_1m_out)) return undefined;
	if (!isFiniteNonNegative(value.cost_per_1m_in_cached)) return undefined;
	if (value.cost_per_1m_out_cached !== undefined && !isFiniteNonNegative(value.cost_per_1m_out_cached))
		return undefined;
	if (!isPositiveInteger(value.context_window) || !isPositiveInteger(value.default_max_tokens)) return undefined;
	if (typeof value.can_reason !== "boolean" || typeof value.supports_attachments !== "boolean") return undefined;
	if (
		value.reasoning_levels !== undefined &&
		(!Array.isArray(value.reasoning_levels) ||
			value.reasoning_levels.length === 0 ||
			value.reasoning_levels.some((level) => typeof level !== "string" || level.trim() === ""))
	) {
		return undefined;
	}
	if (
		value.default_reasoning_effort !== undefined &&
		(typeof value.default_reasoning_effort !== "string" || value.default_reasoning_effort.trim() === "")
	) {
		return undefined;
	}

	const id = value.id.trim();
	const reportedReasoningLevels = Array.isArray(value.reasoning_levels)
		? value.reasoning_levels.filter((level): level is string => typeof level === "string")
		: [];
	const thinkingLevelMap =
		reportedReasoningLevels.length > 0
			? buildThinkingLevelMap(reportedReasoningLevels)
			: value.can_reason
				? onOffThinkingLevelMap
				: undefined;
	const mapped: ProviderModelDraft = {
		id,
		name: value.name.trim(),
		reasoning: value.can_reason,
		input: value.supports_attachments ? ["text", "image"] : ["text"],
		headers: { ...hyperModelHeaders },
		cost: {
			input: value.cost_per_1m_in,
			output: value.cost_per_1m_out,
			cacheRead: value.cost_per_1m_in_cached,
			cacheWrite: 0,
		},
		contextWindow: value.context_window,
		maxTokens: value.default_max_tokens,
		pricingSource: "provider",
		compat: { ...baseHyperCompat, supportsReasoningEffort: reportedReasoningLevels.length > 0 },
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
	return mapped;
}

function parseCurrentHyperModels(payload: Record<string, unknown>): ProviderModelDraft[] | undefined {
	if (!Array.isArray(payload.models)) return undefined;
	if (payload.models.length > MAX_PROVIDER_MODEL_COUNT) return [];
	const models: ProviderModelDraft[] = [];
	const seenIds = new Set<string>();
	for (const value of payload.models) {
		const model = parseCurrentHyperModel(value);
		if (model === undefined) continue;
		const normalizedId = model.id.toLowerCase();
		if (seenIds.has(normalizedId)) continue;
		seenIds.add(normalizedId);
		models.push(model);
	}
	return models;
}

function parseLegacyHyperModels(payload: Record<string, unknown>): ProviderModelDraft[] {
	if (!Array.isArray(payload.data) || payload.data.length > MAX_PROVIDER_MODEL_COUNT) return [];
	const models: ProviderModelDraft[] = [];
	const seenIds = new Set<string>();

	for (const value of payload.data) {
		if (!isRecord(value) || typeof value.id !== "string" || value.id.trim() === "") continue;
		const id = value.id.trim();
		const normalizedId = id.toLowerCase();
		if (seenIds.has(normalizedId)) continue;
		if (value.context_window !== undefined && !isPositiveInteger(value.context_window)) continue;
		if (value.max_output_tokens !== undefined && !isPositiveInteger(value.max_output_tokens)) continue;

		const contextWindow = isPositiveInteger(value.context_window) ? value.context_window : undefined;
		const maxTokens = isPositiveInteger(value.max_output_tokens) ? value.max_output_tokens : undefined;
		if (contextWindow !== undefined && maxTokens !== undefined && maxTokens > contextWindow) continue;
		const reasoning = isRecord(value.reasoning) ? value.reasoning : undefined;
		const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
		const reasoningEffortLevels = readEffortLevels(value);
		const thinkingLevelMap = Object.fromEntries(reasoningEffortLevels.map((level) => [level, level]));
		const supportsReasoningEffort =
			typeof value.supports_reasoning_effort === "boolean"
				? value.supports_reasoning_effort
				: reasoningEffortLevels.length > 0;
		const cost = mapHyperPricing(value.pricing);
		const supportsReasoning =
			typeof value.supports_reasoning === "boolean"
				? value.supports_reasoning
				: reasoning !== undefined
					? true
					: undefined;
		const input: ("text" | "image")[] | undefined =
			typeof capabilities?.vision === "boolean"
				? capabilities.vision
					? ["text", "image"]
					: ["text"]
				: typeof value.supports_attachments === "boolean"
					? value.supports_attachments
						? ["text", "image"]
						: ["text"]
					: undefined;
		const mapped: ProviderModelDraft = {
			id,
			name:
				typeof value.display_name === "string" && value.display_name.trim() !== "" ? value.display_name.trim() : id,
			...(supportsReasoning !== undefined ? { reasoning: supportsReasoning } : {}),
			...(Object.keys(thinkingLevelMap).length > 0
				? { thinkingLevelMap: buildThinkingLevelMap(reasoningEffortLevels) }
				: {}),
			...(input ? { input } : {}),
			headers: { ...hyperModelHeaders },
			...(contextWindow !== undefined ? { contextWindow } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
			...(cost ? { cost, pricingSource: "provider" as const } : {}),
			compat: { ...baseHyperCompat, supportsReasoningEffort },
		};
		models.push(mapped);
		seenIds.add(normalizedId);
	}
	return models;
}

export function parseHyperModels(payload: unknown): ProviderModelDraft[] {
	if (!isRecord(payload)) return [];
	const currentModels = parseCurrentHyperModels(payload);
	return currentModels ?? parseLegacyHyperModels(payload);
}

async function discoverHyperModels(
	fetchFn: typeof globalThis.fetch,
	timeoutMs: number,
	externalSignal?: AbortSignal,
): Promise<ProviderModelDraft[]> {
	return withDeadline(
		async (signal) => {
			let endpoint = HYPER_PROVIDER_URL;
			let response = await fetchFn(endpoint, { signal, headers: hyperJsonHeaders() });
			if (response.status === 404) {
				endpoint = HYPER_MODELS_URL;
				response = await fetchFn(endpoint, { signal, headers: hyperJsonHeaders() });
			}
			if (!response.ok) {
				throw new ProviderDataError(
					`Charm Hyper model discovery failed: HTTP ${response.status}`,
					`http${response.status}`,
				);
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new ProviderDataError(
					`Charm Hyper model discovery returned invalid JSON from ${endpoint}`,
					"badjson",
				);
			}
			const models = parseHyperModels(payload);
			if (models.length === 0) {
				throw new ProviderDataError("Charm Hyper model discovery returned no valid models", "badjson");
			}
			normalizeProviderModels(models);
			return models;
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

type HyperModelsStoreEntry = ProviderRefreshContext["stored"];
type HyperStoredModel = NonNullable<HyperModelsStoreEntry>["models"][number] & {
	pricingSource?: ProviderModelDraft["pricingSource"];
};

function draftsFromStoredModels(entry: HyperModelsStoreEntry): ProviderModelDraft[] | undefined {
	if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return undefined;
	try {
		const drafts: ProviderModelDraft[] = entry.models.map(({ provider: _provider, ...model }) => model);
		normalizeProviderModels(drafts);
		return drafts;
	} catch {
		return undefined;
	}
}

function storedModelsFromDrafts(models: ProviderModelDraft[]): HyperStoredModel[] {
	return normalizeProviderModels(models).map((model) => {
		const source = models.find(({ id }) => id === model.id)?.pricingSource;
		return {
			...model,
			...(source ? { pricingSource: source } : {}),
			api: model.api ?? "openai-completions",
			provider: "charm-hyper",
			baseUrl: model.baseUrl ?? HYPER_BASE_URL,
		};
	});
}

export function createCharmHyperAdapter(
	fetchFn: typeof globalThis.fetch,
	discoveryTimeoutMs: number,
	now: () => number = Date.now,
): ProviderAdapter {
	let provider: ProviderAdapter["provider"];
	const lifecycle = createModelCatalogLifecycle({
		ttlMs: HYPER_MODEL_CATALOG_TTL_MS,
		now,
		discover: (context) => discoverHyperModels(fetchFn, discoveryTimeoutMs, context.signal),
		restore: draftsFromStoredModels,
		persist: (models, checkedAt) => ({ models: storedModelsFromDrafts(models), checkedAt }),
		onUpdate: (models) => {
			if (provider) provider.models = models;
		},
		errorCode: catalogErrorCode,
	});

	provider = {
		name: "Charm Hyper",
		baseUrl: HYPER_BASE_URL,
		apiKey: "$HYPER_API_KEY",
		authHeader: true,
		api: "openai-completions",
		models: lifecycle.getModels(),
		refreshModels: lifecycle.refreshModels,
		oauth: createCharmHyperOAuth(fetchFn, now),
	};

	return { id: "charm-hyper", catalog: lifecycle.catalog, provider };
}

const charmHyperProviderExtension = defineProviderExtension({
	id: "charm-hyper",
	create: ({ fetch, modelDiscoveryTimeoutMs, now }) => createCharmHyperAdapter(fetch, modelDiscoveryTimeoutMs, now),
});

export default charmHyperProviderExtension;
