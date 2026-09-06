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

	assert.match(result.report, /Pricing\s+unavailable/);
	assert.doesNotMatch(result.report, /Pricing\s+unavailable\s+unavailable/);
	assert.match(result.report, /Pricing note\s+discount configured, base price unavailable/);
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

	assert.match(result.report, /Catalog\s+fresh · live · 1 model · 1m ago/);
	assert.match(result.report, /Preflight\s+passed · endpoint · fresh · 2m ago/);
	assert.match(result.report, /Availability\s+not checked/);
	assert.match(result.report, /Account\s+fresh · 3m ago/);
	assert.doesNotMatch(result.report, /Updated:/);

	const lines = result.report.split("\n");
	const valueIndex = (label: string, value: string): number => {
		const line = lines.find((candidate) => candidate.startsWith(label));
		assert.ok(line, `missing report line: ${label}`);
		return line.indexOf(value);
	};
	assert.equal(valueIndex("  Catalog", "fresh"), valueIndex("  API", "openai-completions"));
	assert.equal(valueIndex("  Preflight", "passed"), valueIndex("  Context", "128k"));
	assert.equal(valueIndex("  Account", "fresh"), valueIndex("  Endpoint", "https://provider.invalid/v1"));
});

test("shows model catalog retry backoff diagnostics", () => {
	const now = 1_700_000_000_000;
	const model: any = {
		provider: "retry-provider",
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
		{
			id: "retry-provider",
			provider: { models: [model] },
			catalog: {
				source: "cached",
				modelCount: 1,
				updatedAt: now - 60_000,
				rejectedCount: 3,
				duplicateCount: 1,
				lastError: "fetch",
				consecutiveFailures: 2,
				nextRetryAt: now + 30_000,
			},
		} as any,
		undefined,
		undefined,
		undefined,
		{ configured: true },
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		now,
	);

	assert.match(result.report, /Catalog\s+stale · cached · 1 model · 1m ago/);
	assert.match(result.report, /Skipped: 3 invalid · 1 duplicate/);
	assert.match(result.report, /Error: fetch/);
	assert.match(result.report, /Retry: in 30s · 2 consecutive failures/);
});

test("shows provenance and thinking levels without changing health severity", () => {
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
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		},
	};
	const modelMetadata = {
		pricing: {
			known: true,
			source: "pi",
			baseCost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			effectiveCost: model.cost,
			adjustment: { multiplier: 0.8, label: "20% provider discount" },
		},
		fieldSources: {
			cost: "pi",
			contextWindow: "pi",
			maxTokens: "pi",
			input: "pi",
			reasoning: "pi",
			thinkingLevelMap: "pi",
		},
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
		},
	);

	assert.match(result.report, /Context\s+128k · Pi catalog/);
	assert.match(result.report, /Max output\s+16k · Pi catalog/);
	assert.match(result.report, /Input\s+text · Pi catalog/);
	assert.match(result.report, /Thinking\s+low, high · Pi catalog/);
	assert.doesNotMatch(result.report, /Reasoning:/);
	assert.doesNotMatch(result.report, /Quality:/);
	assert.match(result.report, /Pricing\s+input \$4 · output \$24/);
	assert.match(result.report, /cache read \$0.4 · cache write \$5/);
	assert.match(result.report, /per 1M tokens · Pi catalog · 20% provider discount · estimate/);
	assert.match(result.report, /Tier >272k\s+input \$8 · output \$48/);
	assert.match(result.report, /cache read \$0.8 · cache write \$10/);
	assert.match(result.report, /per 1M tokens/);
	assert.doesNotMatch(result.report, /\+1 tiers/);
	assert.doesNotMatch(result.report, /Capability reference:/);
	assert.doesNotMatch(result.report, /Pricing source:/);
	assert.equal(result.warningLevel, "none");
});
