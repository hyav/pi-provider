import type { ProviderModel, ProviderModelDraft } from "@hyav/pi-provider";

export const COMMAND_CODE_PROVIDER_ID = "command-code";
export const COMMAND_CODE_PROVIDER_NAME = "Command Code";
export const COMMAND_CODE_API_KEY_VAR = "$COMMAND_CODE_API_KEY";
export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const COMMAND_CODE_ANTHROPIC_BASE_URL = "https://api.commandcode.ai/provider";
export const COMMAND_CODE_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";
export const COMMAND_CODE_MODEL_CATALOG_TTL_MS = 4 * 60 * 60 * 1_000;
export const SAFE_MAX_OUTPUT_TOKENS = 65_536;

export interface CommandCodeModelDefinition {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens?: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	input: ("text" | "image")[];
	reasoning: boolean;
	thinkingLevelMap?: NonNullable<ProviderModel["thinkingLevelMap"]>;
	compat?: NonNullable<ProviderModel["compat"]>;
	aliases?: string[];
	api?: "openai-completions" | "anthropic-messages";
	baseUrl?: string;
}

const standardThinkingLevelMap: NonNullable<ProviderModel["thinkingLevelMap"]> = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const grokThinkingLevelMap: NonNullable<ProviderModel["thinkingLevelMap"]> = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
};

const deepseekThinkingLevelMap: NonNullable<ProviderModel["thinkingLevelMap"]> = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
};

const geminiThinkingLevelMap: NonNullable<ProviderModel["thinkingLevelMap"]> = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "max",
};

export const baseOpenAICompat: NonNullable<ProviderModel["compat"]> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens",
};

export const baseAnthropicCompat: NonNullable<ProviderModel["compat"]> = {
	supportsEagerToolInputStreaming: false,
	supportsLongCacheRetention: false,
	supportsCacheControlOnTools: false,
	supportsToolReferences: false,
};

/**
 * Representative static definitions used as the offline fallback and metadata
 * scaffold. The live `/v1/models` endpoint is authoritative; these entries
 * only demonstrate each capability variant (provider routing, thinking-level
 * maps, aliases, reasoning effort, free tiers) and keep the catalog usable
 * while the network is unavailable.
 */
export const COMMAND_CODE_KNOWN_MODELS: readonly CommandCodeModelDefinition[] = [
	// Claude series (Anthropic Messages API)
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
		input: ["text", "image"],
		reasoning: true,
		api: "anthropic-messages",
		baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL,
		aliases: ["claude-5-sonnet", "sonnet-5"],
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		contextWindow: 200_000,
		maxTokens: 65_536,
		cost: { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
		input: ["text", "image"],
		reasoning: true,
		api: "anthropic-messages",
		baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL,
		aliases: ["claude-haiku-4-5", "claude-haiku-4.5", "haiku-4-5"],
	},

	// OpenAI / GPT series (standard thinking levels + reasoning effort)
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		cost: { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 6.25 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: standardThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gpt-5-6-sol"],
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 Mini",
		contextWindow: 400_000,
		maxTokens: 65_536,
		cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0.15 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: standardThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gpt-5-4-mini"],
	},

	// DeepSeek series (deepseek thinking envelope)
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro (latest)",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: deepseekThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["deepseek-v4-pro"],
	},

	// Moonshot Kimi series (no published thinking levels)
	{
		id: "moonshotai/Kimi-K2.6",
		name: "Kimi K2.6",
		contextWindow: 256_000,
		maxTokens: 65_536,
		cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["kimi-k2.6", "kimi-k2-6"],
	},

	// ZAI / GLM series (non-standard provider prefix)
	{
		id: "zai-org/GLM-5.3",
		name: "GLM-5.3",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["glm-5.3", "glm-5-3"],
	},

	// Qwen series (cache-write priced + reasoning effort)
	{
		id: "Qwen/Qwen3.8-Max",
		name: "Qwen 3.8 Max",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 2.5 },
		input: ["text", "image"],
		reasoning: true,
		compat: { supportsReasoningEffort: true },
		aliases: ["qwen3.8-max", "qwen3-8-max"],
	},

	// Google Gemini series (gemini thinking envelope)
	{
		id: "google/gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.04167 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: geminiThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gemini-3.7-flash", "gemini-3-7-flash"],
	},

	// xAI Grok series (grok thinking envelope without max)
	{
		id: "xai/grok-4.6",
		name: "Grok 4.6",
		contextWindow: 500_000,
		maxTokens: 65_536,
		cost: { input: 2.0, output: 6.0, cacheRead: 0.5, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: grokThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["grok-4.6", "grok-4-6"],
	},

	// Poolside free tier (zero-cost model)
	{
		id: "poolside/laguna-s-2.1-free",
		name: "Laguna S 2.1",
		contextWindow: 256_000,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["laguna-s-2.1-free", "laguna-s-2-1-free", "laguna-s-2.1", "laguna-s-2-1"],
	},
];

export function normalizeCommandCodeModelId(id: string): string {
	return id.trim().toLowerCase();
}

function normalizeKey(str: string): string {
	return str.trim().toLowerCase();
}

const knownLookupMap = new Map<string, CommandCodeModelDefinition>();

for (const model of COMMAND_CODE_KNOWN_MODELS) {
	knownLookupMap.set(normalizeKey(model.id), model);
	if (model.id.includes("/")) {
		const shortId = model.id.split("/")[1];
		if (shortId) knownLookupMap.set(normalizeKey(shortId), model);
	}
	if (model.aliases) {
		for (const alias of model.aliases) {
			knownLookupMap.set(normalizeKey(alias), model);
			if (alias.includes("/")) {
				const shortAlias = alias.split("/")[1];
				if (shortAlias) knownLookupMap.set(normalizeKey(shortAlias), model);
			}
		}
	}
}

export function matchKnownModel(id: string): CommandCodeModelDefinition | undefined {
	if (typeof id !== "string" || id.trim() === "") return undefined;
	const key = normalizeKey(id);
	const direct = knownLookupMap.get(key);
	if (direct) return direct;

	if (key.includes("/")) {
		const afterSlash = key.split("/")[1];
		if (afterSlash) {
			const byShort = knownLookupMap.get(afterSlash);
			if (byShort) return byShort;
		}
	}

	const hyphenated = key.replaceAll(".", "-");
	const byHyphen = knownLookupMap.get(hyphenated);
	if (byHyphen) return byHyphen;

	const dotted = key.replaceAll("-", ".");
	const byDot = knownLookupMap.get(dotted);
	if (byDot) return byDot;

	return undefined;
}

export function isSafeText(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getModelRouting(id: string): {
	api: "openai-completions" | "anthropic-messages";
	baseUrl: string;
	compat: NonNullable<ProviderModel["compat"]>;
} {
	const lower = id.toLowerCase();
	if (lower.startsWith("claude-") || lower.includes("/claude-")) {
		return {
			api: "anthropic-messages",
			baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL,
			compat: { ...baseAnthropicCompat },
		};
	}
	return {
		api: "openai-completions",
		baseUrl: COMMAND_CODE_BASE_URL,
		compat: { ...baseOpenAICompat },
	};
}

export function getCommandCodeHeaders(): Record<string, string> | undefined {
	if (process.env.CMD_ZDR === "1") {
		return { "x-cmd-zdr": "1" };
	}
	return undefined;
}

/**
 * Resolves a model draft using the 3-level strategy:
 * 1. Live endpoint data (id, name, context_length)
 * 2. Static official definition (capabilities, reasoning, pricing)
 * 3. Raw draft fallback allowing Pi catalog fallback completion
 */
export function resolveModelDraft(liveModel: {
	id: string;
	name?: string;
	context_length?: number;
}): ProviderModelDraft | undefined {
	if (!isSafeText(liveModel.id)) return undefined;
	const id = liveModel.id.trim();
	const routing = getModelRouting(id);
	const headers = getCommandCodeHeaders();

	const staticDef = matchKnownModel(id);

	// Tier 1: Live properties
	const name = isSafeText(liveModel.name) ? liveModel.name.trim() : (staticDef?.name ?? id);
	const contextWindow = isPositiveInteger(liveModel.context_length)
		? liveModel.context_length
		: staticDef?.contextWindow;

	if (staticDef) {
		// Tier 2: Static official definition
		const effectiveContextWindow = contextWindow ?? 128_000;
		const maxTokens = Math.min(staticDef.maxTokens ?? SAFE_MAX_OUTPUT_TOKENS, effectiveContextWindow);
		return {
			id,
			name,
			contextWindow: effectiveContextWindow,
			maxTokens,
			cost: { ...staticDef.cost },
			pricingSource: "provider",
			input: [...staticDef.input],
			reasoning: staticDef.reasoning,
			...(staticDef.thinkingLevelMap ? { thinkingLevelMap: { ...staticDef.thinkingLevelMap } } : {}),
			compat: {
				...routing.compat,
				...(staticDef.compat ?? {}),
			},
			...(staticDef.api || routing.api !== "openai-completions" ? { api: staticDef.api ?? routing.api } : {}),
			...(staticDef.baseUrl || routing.baseUrl !== COMMAND_CODE_BASE_URL
				? { baseUrl: staticDef.baseUrl ?? routing.baseUrl }
				: {}),
			...(headers ? { headers } : {}),
		};
	}

	// Tier 3: Raw draft for unvetted models - allow Pi catalog fallback to enrich capabilities
	return {
		id,
		name,
		...(contextWindow !== undefined ? { contextWindow } : {}),
		compat: { ...routing.compat },
		...(routing.api !== "openai-completions" ? { api: routing.api } : {}),
		...(routing.baseUrl !== COMMAND_CODE_BASE_URL ? { baseUrl: routing.baseUrl } : {}),
		...(headers ? { headers } : {}),
	};
}

export function getCommandCodeFallbackModels(): ProviderModelDraft[] {
	return COMMAND_CODE_KNOWN_MODELS.map((model) => {
		const draft = resolveModelDraft({
			id: model.id,
			name: model.name,
			context_length: model.contextWindow,
		});
		if (!draft) {
			throw new Error(`Failed to create fallback draft for ${model.id}`);
		}
		return draft;
	});
}

export function parseCommandCodeModels(payload: unknown): ProviderModelDraft[] {
	if (!isRecord(payload) && !Array.isArray(payload)) return [];

	const rawList: unknown[] = Array.isArray(payload)
		? payload
		: Array.isArray(payload.data)
			? payload.data
			: Array.isArray(payload.models)
				? payload.models
				: [];

	const models: ProviderModelDraft[] = [];
	const seenNormalizedIds = new Set<string>();

	for (const item of rawList) {
		if (!isRecord(item)) continue;
		if (!isSafeText(item.id)) continue;

		const rawId = item.id.trim();
		const normalizedId = normalizeCommandCodeModelId(rawId);
		if (seenNormalizedIds.has(normalizedId)) continue;

		const name = isSafeText(item.name) ? item.name.trim() : undefined;
		const contextLength = isPositiveInteger(item.context_length)
			? item.context_length
			: isPositiveInteger(item.context_window)
				? item.context_window
				: undefined;

		const draft = resolveModelDraft({
			id: rawId,
			name,
			context_length: contextLength,
		});

		if (draft) {
			seenNormalizedIds.add(normalizedId);
			models.push(draft);
		}
	}

	return models;
}
