import assert from "node:assert/strict";
import test from "node:test";
import { applyOfficialModelCosts } from "../core/official-pricing.ts";
import type { ProviderModelDraft } from "../core/types.ts";

const catalogModelIds = ["model-alpha", "model-beta", "model-gamma", "model-delta"];

function createCatalogModels(): ProviderModelDraft[] {
	return catalogModelIds.map((id) => ({
		id,
		name: id,
		...(id !== "model-delta" ? { compat: { supportsStore: false } } : {}),
	}));
}

test("provider models receive pricing and reasoning metadata dynamically", () => {
	const officialPricing = {
		"model-alpha": {
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			reasoning: true,
			thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
		},
		"model-beta": {
			cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
			reasoning: true,
			thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
		},
		"model-gamma": {
			cost: { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0.125 },
			reasoning: true,
			thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
		},
		"model-delta": {
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			reasoning: true,
			thinkingLevelMap: { off: null, low: null, medium: null, high: null, xhigh: "xhigh", max: null },
		},
	};

	for (const models of [createCatalogModels(), createCatalogModels()]) {
		for (const model of models) {
			assert.equal(model.reasoning, undefined);
			assert.equal(model.thinkingLevelMap, undefined);
		}

		const enriched = applyOfficialModelCosts(models, officialPricing);
		assert.equal(enriched.length, 4);
		for (const model of enriched) {
			assert.ok(model.cost, `${model.id} should have cost populated`);
			assert.ok(model.cost.input > 0);
			assert.equal(model.reasoning, true);
			assert.ok(model.thinkingLevelMap);
		}
	}
});
