import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderModel, ProviderModelDraft } from "@hyav/pi-provider";

let openRouterSnapshotCache: Record<string, unknown> | undefined;

function getOpenRouterSnapshot(): Record<string, unknown> {
	if (openRouterSnapshotCache !== undefined) return openRouterSnapshotCache;
	try {
		const currentFile = fileURLToPath(import.meta.url);
		const baseDir = path.dirname(path.dirname(path.dirname(currentFile)));
		const metaPath = path.join(baseDir, "openrouter-model-metadata.json");
		if (fs.existsSync(metaPath)) {
			const raw = fs.readFileSync(metaPath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed.snapshot === "object") {
				openRouterSnapshotCache = parsed.snapshot as Record<string, unknown>;
				return openRouterSnapshotCache;
			}
		}
	} catch {
		// ignore
	}
	openRouterSnapshotCache = {};
	return openRouterSnapshotCache;
}

function findOpenRouterMeta(id: string, snapshot: Record<string, unknown>): Record<string, any> | undefined {
	const lower = id.toLowerCase().trim();
	if (snapshot[lower] && typeof snapshot[lower] === "object") {
		return snapshot[lower] as Record<string, any>;
	}
	if (lower.includes("/")) {
		const shortId = lower.split("/")[1];
		if (shortId && snapshot[shortId] && typeof snapshot[shortId] === "object") {
			return snapshot[shortId] as Record<string, any>;
		}
	}
	return undefined;
}

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
 * Static dictionary of known Command Code models (including all 56 official models).
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
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
		input: ["text", "image"],
		reasoning: true,
		api: "anthropic-messages",
		baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL,
		aliases: ["claude-4.6-sonnet", "sonnet-4-6", "claude-sonnet-4.6"],
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
		input: ["text", "image"],
		reasoning: true,
		api: "anthropic-messages",
		baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL,
		aliases: ["fable-5", "claude-5-fable"],
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
		input: ["text", "image"],
		reasoning: true,
		api: "anthropic-messages",
		baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL,
		aliases: ["claude-5-opus", "opus-5"],
	},
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
		input: ["text", "image"],
		reasoning: true,
		api: "anthropic-messages",
		baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL,
		aliases: ["claude-4.8-opus", "opus-4-8", "claude-opus-4.8"],
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
		input: ["text", "image"],
		reasoning: true,
		api: "anthropic-messages",
		baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL,
		aliases: ["claude-4.7-opus", "opus-4-7", "claude-opus-4.7"],
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

	// OpenAI / GPT series
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
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		cost: { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 2.5 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: standardThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gpt-5-6-terra"],
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: standardThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gpt-5-6-luna"],
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		contextWindow: 200_000,
		maxTokens: 65_536,
		cost: { input: 1.5, output: 6.0, cacheRead: 0.15, cacheWrite: 1.5 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: standardThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gpt-5-5"],
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 400_000,
		maxTokens: 65_536,
		cost: { input: 1.25, output: 5.0, cacheRead: 0.125, cacheWrite: 1.25 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: standardThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gpt-5-4"],
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		contextWindow: 400_000,
		maxTokens: 65_536,
		cost: { input: 1.25, output: 5.0, cacheRead: 0.125, cacheWrite: 1.25 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: standardThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gpt-5-3-codex"],
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

	// DeepSeek series
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
	{
		id: "deepseek/deepseek-v4-flash",
		name: "DeepSeek V4 Flash (latest)",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: deepseekThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["deepseek-v4-flash"],
	},

	// Moonshot Kimi series
	{
		id: "moonshotai/Kimi-K3",
		name: "Kimi K3",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["kimi-k3"],
	},
	{
		id: "moonshotai/Kimi-K2.7-Code",
		name: "Kimi K2.7 Code",
		contextWindow: 256_000,
		maxTokens: 65_536,
		cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["kimi-k2.7-code", "kimi-k2-7-code"],
	},
	{
		id: "moonshotai/Kimi-K2.7-Code-Highspeed",
		name: "Kimi K2.7 Code HighSpeed",
		contextWindow: 262_000,
		maxTokens: 65_536,
		cost: { input: 1.9, output: 8.0, cacheRead: 0.38, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["kimi-k2.7-code-highspeed", "kimi-k2-7-code-highspeed"],
	},
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
	{
		id: "moonshotai/Kimi-K2.5",
		name: "Kimi K2.5",
		contextWindow: 256_000,
		maxTokens: 65_536,
		cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["kimi-k2.5", "kimi-k2-5"],
	},

	// ZAI / GLM series
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
	{
		id: "zai-org/GLM-5.2",
		name: "GLM-5.2",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["glm-5.2", "glm-5-2"],
	},
	{
		id: "zai-org/GLM-5.2-Fast",
		name: "GLM-5.2 Fast",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 3.0, output: 10.25, cacheRead: 0.5, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["glm-5.2-fast", "glm-5-2-fast"],
	},
	{
		id: "zai-org/GLM-5.1",
		name: "GLM-5.1",
		contextWindow: 200_000,
		maxTokens: 65_536,
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["glm-5.1", "glm-5-1"],
	},
	{
		id: "zai-org/GLM-5",
		name: "GLM-5",
		contextWindow: 200_000,
		maxTokens: 65_536,
		cost: { input: 1.0, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["glm-5"],
	},

	// MiniMax series
	{
		id: "MiniMaxAI/MiniMax-M3",
		name: "MiniMax M3",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["minimax-m3"],
	},
	{
		id: "MiniMaxAI/MiniMax-M2.7",
		name: "MiniMax M2.7",
		contextWindow: 200_000,
		maxTokens: 65_536,
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["minimax-m2.7", "minimax-m2-7"],
	},
	{
		id: "MiniMaxAI/MiniMax-M2.5",
		name: "MiniMax M2.5",
		contextWindow: 200_000,
		maxTokens: 65_536,
		cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["minimax-m2.5", "minimax-m2-5"],
	},

	// Xiaomi MiMo series
	{
		id: "xiaomi/mimo-v2.5-pro",
		name: "MiMo V2.5 Pro",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["mimo-v2.5-pro", "mimo-v2-5-pro"],
	},
	{
		id: "xiaomi/mimo-v2.5",
		name: "MiMo V2.5",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["mimo-v2.5", "mimo-v2-5"],
	},

	// Qwen series
	{
		id: "Qwen/Qwen3.8-Max",
		name: "Qwen 3.8 Max",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 2.5 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["qwen3.8-max", "qwen3-8-max"],
	},
	{
		id: "Qwen/Qwen3.8-27B",
		name: "Qwen 3.8 27B",
		contextWindow: 262_144,
		maxTokens: 65_536,
		cost: { input: 0.45, output: 3.2, cacheRead: 0.05, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		compat: { supportsReasoningEffort: true },
		aliases: ["qwen3.8-27b", "qwen3-8-27b"],
	},
	{
		id: "Qwen/Qwen3.7-Max",
		name: "Qwen 3.7 Max",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.13 },
		input: ["text"],
		reasoning: true,
		aliases: ["qwen3.7-max", "qwen3-7-max"],
	},
	{
		id: "Qwen/Qwen3.7-Plus",
		name: "Qwen 3.7 Plus",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0.5 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["qwen3.7-plus", "qwen3-7-plus"],
	},
	{
		id: "Qwen/Qwen3.7-Flash",
		name: "Qwen 3.7 Flash",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.03, output: 0.13, cacheRead: 0.006, cacheWrite: 0.038 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["qwen3.7-flash", "qwen3-7-flash"],
	},
	{
		id: "Qwen/Qwen3.6-Max-Preview",
		name: "Qwen 3.6 Max Preview",
		contextWindow: 200_000,
		maxTokens: 65_536,
		cost: { input: 1.3, output: 7.8, cacheRead: 0.26, cacheWrite: 1.63 },
		input: ["text"],
		reasoning: true,
		aliases: ["qwen3.6-max-preview", "qwen3-6-max-preview"],
	},
	{
		id: "Qwen/Qwen3.6-Plus",
		name: "Qwen 3.6 Plus",
		contextWindow: 200_000,
		maxTokens: 65_536,
		cost: { input: 0.5, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["qwen3.6-plus", "qwen3-6-plus"],
	},

	// StepFun series
	{
		id: "stepfun/Step-3.7-Flash",
		name: "Step 3.7 Flash",
		contextWindow: 256_000,
		maxTokens: 65_536,
		cost: { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["step-3.7-flash", "step-3-7-flash"],
	},
	{
		id: "stepfun/Step-3.5-Flash",
		name: "Step 3.5 Flash",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["step-3.5-flash", "step-3-5-flash"],
	},

	// Tencent series
	{
		id: "tencent/hy3-paid",
		name: "Tencent Hy3",
		contextWindow: 262_144,
		maxTokens: 65_536,
		cost: { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["tencent-hy3", "hy3-paid"],
	},

	// Google Gemini series
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
	{
		id: "google/gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.04167 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: geminiThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gemini-3.6-flash", "gemini-3-6-flash"],
	},
	{
		id: "google/gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.35, output: 1.75, cacheRead: 0.035, cacheWrite: 0.02 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: geminiThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gemini-3.5-flash", "gemini-3-5-flash"],
	},
	{
		id: "google/gemini-3.5-flash-lite",
		name: "Gemini 3.5 Flash Lite",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.0833 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: geminiThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gemini-3.5-flash-lite", "gemini-3-5-flash-lite"],
	},
	{
		id: "google/gemini-3.1-flash-lite",
		name: "Gemini 3.1 Flash Lite",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.2, output: 1.5, cacheRead: 0.02, cacheWrite: 0.05 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: geminiThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["gemini-3.1-flash-lite", "gemini-3-1-flash-lite"],
	},

	// Sakana series
	{
		id: "sakana/fugu-ultra",
		name: "Fugu Ultra",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 1.0, output: 4.0, cacheRead: 0.15, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["fugu-ultra"],
	},

	// NVIDIA series
	{
		id: "nvidia/nemotron-3-ultra-550b-a55b",
		name: "Nemotron 3 Ultra",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
		input: ["text"],
		reasoning: true,
		aliases: ["nemotron-3-ultra", "nemotron-3-ultra-550b-a55b"],
	},

	// Thinking Machines series
	{
		id: "thinkingmachines/inkling",
		name: "Inkling",
		contextWindow: 256_000,
		maxTokens: 65_536,
		cost: { input: 1.0, output: 4.05, cacheRead: 0.17, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["inkling"],
	},
	{
		id: "thinkingmachines/inkling-small",
		name: "Inkling Small",
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0.5, output: 1.2, cacheRead: 0.1, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["inkling-small"],
	},

	// Poolside series
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

	// Meta series
	{
		id: "meta/muse-spark-1.1",
		name: "Muse Spark 1.1",
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["muse-spark-1.1", "muse-spark-1-1"],
	},
	{
		id: "meta/muse-spark-1.2",
		name: "Muse Spark 1.2",
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["muse-spark-1.2", "muse-spark-1-2"],
	},
	{
		id: "meta/muse-spark-1.2-contributor",
		name: "Muse Spark 1.2 Contributor",
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		aliases: ["muse-spark-1.2-contributor", "muse-spark-1-2-contributor"],
	},

	// xAI Grok series
	{
		id: "xai/grok-4.5",
		name: "Grok 4.5",
		contextWindow: 500_000,
		maxTokens: 65_536,
		cost: { input: 2.0, output: 6.0, cacheRead: 0.5, cacheWrite: 0 },
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: grokThinkingLevelMap,
		compat: { supportsReasoningEffort: true },
		aliases: ["grok-4.5", "grok-4-5"],
	},
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
 * 3. OpenRouter metadata fallback (pricing, quality, capabilities)
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
		: (staticDef?.contextWindow ?? 128_000);

	if (staticDef) {
		// Tier 2: Static official definition
		const maxTokens = Math.min(staticDef.maxTokens ?? SAFE_MAX_OUTPUT_TOKENS, contextWindow);
		return {
			id,
			name,
			contextWindow,
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

	// Tier 3: OpenRouter metadata fallback
	const snapshot = getOpenRouterSnapshot();
	const openRouterMeta = findOpenRouterMeta(id, snapshot);

	if (openRouterMeta && isRecord(openRouterMeta.cost)) {
		const maxTokens = Math.min(
			typeof openRouterMeta.maxTokens === "number" ? openRouterMeta.maxTokens : SAFE_MAX_OUTPUT_TOKENS,
			contextWindow,
		);
		const inputModalities = Array.isArray(openRouterMeta.input) ? openRouterMeta.input : ["text"];
		return {
			id,
			name: typeof openRouterMeta.name === "string" ? openRouterMeta.name : name,
			contextWindow: typeof openRouterMeta.contextWindow === "number" ? openRouterMeta.contextWindow : contextWindow,
			maxTokens,
			cost: {
				input: typeof openRouterMeta.cost.input === "number" ? openRouterMeta.cost.input : 0,
				output: typeof openRouterMeta.cost.output === "number" ? openRouterMeta.cost.output : 0,
				cacheRead: typeof openRouterMeta.cost.cacheRead === "number" ? openRouterMeta.cost.cacheRead : 0,
				cacheWrite: typeof openRouterMeta.cost.cacheWrite === "number" ? openRouterMeta.cost.cacheWrite : 0,
			},
			pricingSource: "fallback",
			input: inputModalities.filter((item): item is "text" | "image" => item === "text" || item === "image"),
			reasoning: Boolean(openRouterMeta.reasoning),
			...(openRouterMeta.thinkingLevelMap && isRecord(openRouterMeta.thinkingLevelMap)
				? { thinkingLevelMap: openRouterMeta.thinkingLevelMap as any }
				: {}),
			compat: {
				...routing.compat,
				...(isRecord(openRouterMeta.compat) && openRouterMeta.compat.supportsReasoningEffort
					? { supportsReasoningEffort: true }
					: {}),
			},
			...(routing.api !== "openai-completions" ? { api: routing.api } : {}),
			...(routing.baseUrl !== COMMAND_CODE_BASE_URL ? { baseUrl: routing.baseUrl } : {}),
			...(headers ? { headers } : {}),
		};
	}

	// Safe fallback defaults for unvetted models
	const maxTokens = Math.min(SAFE_MAX_OUTPUT_TOKENS, contextWindow);
	return {
		id,
		name,
		contextWindow,
		maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		pricingSource: "fallback",
		input: ["text"],
		reasoning: false,
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
