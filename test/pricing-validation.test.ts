import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { validateProviderAdapter } from "../core/adapter-validation.ts";
import { normalizeProviderModels } from "../core/provider-registration.ts";
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

test("applies the same model-catalog boundary to initial and cached model lists", () => {
	const adapter: ProviderAdapter = {
		id: "catalog-boundary",
		provider: {
			name: "Catalog Boundary",
			baseUrl: "https://provider.invalid/v1",
			apiKey: "$CATALOG_BOUNDARY_KEY",
			api: "openai-completions",
			models: Array.from({ length: 4_097 }, (_, index) => ({ id: `model-${index}` })),
		},
	};
	assert.throws(() => validateProviderAdapter(adapter), /too many/i);
	assert.throws(() => normalizeProviderModels([{ id: "cached-model", name: "bad-\u001b[2J-name" }]), /safe text/i);
});

test("validates model catalog retry diagnostics", () => {
	const adapter: ProviderAdapter = {
		id: "catalog-diagnostics",
		catalog: {
			source: "cached",
			modelCount: 1,
			lastSuccessfulRefreshAt: 1,
			lastAttemptAt: 2,
			consecutiveFailures: 2,
			nextRetryAt: 3,
			lastError: "fetch",
		},
		provider: {
			name: "Catalog Diagnostics",
			baseUrl: "https://provider.invalid/v1",
			apiKey: "$CATALOG_DIAGNOSTICS_KEY",
			api: "openai-completions",
			models: [{ id: "model" }],
		},
	};

	assert.doesNotThrow(() => validateProviderAdapter(adapter));
	adapter.catalog!.consecutiveFailures = -1;
	assert.throws(() => validateProviderAdapter(adapter), /failure count/i);
	adapter.catalog!.consecutiveFailures = 1;
	adapter.catalog!.nextRetryAt = Number.NaN;
	assert.throws(() => validateProviderAdapter(adapter), /nextRetryAt/);
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

test("derives the metadata cache path after applying an agentDir override", () => {
	const custom = resolvePiProviderDependencies({ agentDir: "/custom/pi-agent" });
	assert.equal(
		custom.openRouterMetadataCachePath,
		join("/custom/pi-agent", "extensions", "pi-provider", "openrouter-model-metadata.json"),
	);

	const memoryOnly = resolvePiProviderDependencies({ agentDir: "" });
	assert.equal(memoryOnly.openRouterMetadataCachePath, "");

	const explicit = resolvePiProviderDependencies({
		agentDir: "/custom/pi-agent",
		openRouterMetadataCachePath: "/explicit/cache.json",
	});
	assert.equal(explicit.openRouterMetadataCachePath, "/explicit/cache.json");
});
