import assert from "node:assert/strict";
import test from "node:test";
import { formatProviderStatus } from "../core/status-report.ts";
import type { ProviderModelMetadata } from "../core/types.ts";

test("does not present a discount without a base price as free", () => {
	const model: any = {
		provider: "unknown-pricing-provider",
		id: "model-alpha",
		api: "openai-completions",
		baseUrl: "https://provider.invalid/v1",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		input: ["text"],
		reasoning: false,
	};
	const result = formatProviderStatus(
		model,
		undefined,
		undefined,
		undefined,
		undefined,
		{ configured: false },
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		1_700_000_000_000,
		{
			modelMetadata: {
				pricing: {
					known: false,
					source: "none",
					adjustment: { multiplier: 0.8, label: "20% provider discount" },
					note: "discount configured, base price unavailable",
				},
			},
		},
	);

	assert.match(result.report, /Pricing: unavailable/);
	assert.doesNotMatch(result.report, /Pricing: unavailable · unavailable/);
	assert.match(result.report, /Pricing note: discount configured, base price unavailable/);
});

test("uses consistent freshness lines for catalog, preflight, and account status", () => {
	const now = 1_700_000_000_000;
	const model: any = {
		provider: "fresh-provider",
		id: "model-alpha",
		api: "openai-completions",
		baseUrl: "https://provider.invalid/v1",
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		input: ["text"],
		reasoning: false,
	};
	const result = formatProviderStatus(
		model,
		{
			id: "fresh-provider",
			provider: { models: [model] },
			catalog: { source: "live", modelCount: 1, updatedAt: now - 60_000 },
		} as any,
		{ cacheTtlMs: 300_000 } as any,
		{ cacheTtlMs: 300_000 } as any,
		undefined,
		{ configured: true },
		{ snapshot: { entries: [], updatedAt: now - 180_000 } } as any,
		{ snapshot: { passed: true, checks: ["endpoint"], updatedAt: now - 120_000 } } as any,
		undefined,
		undefined,
		false,
		now,
	);

	assert.match(result.report, /Catalog:\n {2}Status: fresh · live · 1m ago\n {2}Models: 1/);
	assert.match(result.report, /Preflight: passed · endpoint · fresh · 2m ago/);
	assert.match(result.report, /Account:\n {2}Status: fresh · 3m ago/);
	assert.doesNotMatch(result.report, /Updated:/);
});

test("shows quality metrics and inline provenance without changing health severity", () => {
	const model: any = {
		provider: "reference-provider",
		id: "model-alpha",
		api: "openai-completions",
		baseUrl: "https://provider.invalid/v1",
		cost: {
			input: 4,
			output: 24,
			cacheRead: 0.4,
			cacheWrite: 5,
			tiers: [{ inputTokensAbove: 272_000, input: 8, output: 48, cacheRead: 0.8, cacheWrite: 10 }],
		},
		contextWindow: 128_000,
		maxTokens: 16_384,
		input: ["text"],
		reasoning: false,
	};
	const modelMetadata = {
		pricing: {
			known: true,
			source: "official",
			baseCost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			effectiveCost: model.cost,
			adjustment: { multiplier: 0.8, label: "20% provider discount" },
		},
		fieldSources: {
			contextWindow: "official",
			maxTokens: "official",
			input: "official",
			reasoning: "official",
		},
		quality: [
			{
				source: "artificial-analysis",
				benchmark: "Artificial Analysis",
				category: "intelligence",
				metric: "score",
				value: 51.2,
			},
			{
				source: "artificial-analysis",
				benchmark: "Artificial Analysis",
				category: "coding",
				metric: "score",
				value: 71.4,
			},
			{
				source: "artificial-analysis",
				benchmark: "Artificial Analysis",
				category: "agentic",
				metric: "score",
				value: 45.6,
			},
		],
	} as ProviderModelMetadata;

	const result = formatProviderStatus(
		model,
		undefined,
		undefined,
		undefined,
		undefined,
		{ configured: false },
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		1_700_000_000_000,
		{
			modelMetadata,
			metadataStatus: { state: "fresh", updatedAt: 1_699_999_280_000, source: "AA/OpenRouter" },
		} as any,
	);

	assert.match(result.report, /Context: 128k · OpenRouter/);
	assert.match(result.report, /Max output: 16k · OpenRouter/);
	assert.match(result.report, /Input: text · OpenRouter/);
	assert.match(result.report, /Reasoning: not supported · OpenRouter/);
	assert.match(
		result.report,
		/Quality:\n {2}Status: fresh · 12m ago\n {2}Source: AA\/OpenRouter\n {2}Indices: intelligence 51.2 · coding 71.4 · agentic 45.6/,
	);
	assert.match(
		result.report,
		/Pricing: \$4 input \/ \$24 output \/ \$0.4 cache read \/ \$5 cache write per 1M tokens · OpenRouter · 20% provider discount · estimate/,
	);
	assert.match(
		result.report,
		/Pricing tier: above 272k · \$8 input \/ \$48 output \/ \$0.8 cache read \/ \$10 cache write per 1M tokens/,
	);
	assert.doesNotMatch(result.report, /\+1 tiers/);
	assert.doesNotMatch(result.report, /Capability reference:/);
	assert.doesNotMatch(result.report, /Pricing source:/);
	assert.equal(result.warningLevel, "none");
});
