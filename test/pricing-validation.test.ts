import assert from "node:assert/strict";
import test from "node:test";
import { validateProviderAdapter } from "../core/adapter-validation.ts";
import {
	getDefaultPiProviderDependencies,
	resolvePiProviderDependencies,
	validatePiProviderDependencies,
} from "../core/runtime-config.ts";
import type { ProviderAdapter } from "../core/types.ts";

test("rejects an invalid Provider pricing adjustment", () => {
	const adapter: ProviderAdapter = {
		id: "invalid-pricing",
		pricing: {
			defaultAdjustment: { multiplier: -0.2, label: "invalid" },
		},
		provider: {
			name: "Invalid Pricing",
			baseUrl: "https://provider.invalid/v1",
			apiKey: "$INVALID_PRICING_KEY",
			api: "openai-completions",
			models: [{ id: "model" }],
		},
	};

	assert.throws(() => validateProviderAdapter(adapter), /multiplier/);
});

test("accepts dependency objects created before runtime pricing policies existed", () => {
	const legacyRuntime = getDefaultPiProviderDependencies();
	delete legacyRuntime.pricingPolicies;

	assert.doesNotThrow(() => validatePiProviderDependencies(legacyRuntime));
});

test("rejects an invalid runtime pricing policy", () => {
	assert.throws(
		() =>
			resolvePiProviderDependencies({
				pricingPolicies: {
					provider: { defaultAdjustment: { multiplier: -1, label: "invalid" } },
				},
			}),
		/multiplier/,
	);
});
