import assert from "node:assert/strict";
import test from "node:test";
import { prepareProviderRegistration } from "../core/provider-registration.ts";
import { getDefaultProviderKitDependencies } from "../core/runtime-config.ts";
import type { ProviderAdapter } from "../core/types.ts";

function providerAdapter(): ProviderAdapter {
	return {
		id: "discounted-provider",
		pricing: {
			defaultAdjustment: {
				multiplier: 0.8,
				label: "20% provider discount",
				source: "provider contract",
			},
		},
		provider: {
			name: "Discounted Provider",
			baseUrl: "https://provider.invalid/v1",
			apiKey: "$DISCOUNTED_PROVIDER_KEY",
			api: "openai-completions",
			models: [{ id: "model-alpha" }],
		},
	};
}

test("applies a runtime pricing policy to a Provider without adapter changes", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	const runtime = getDefaultProviderKitDependencies();
	runtime.pricingPolicies = {
		"discounted-provider": {
			defaultAdjustment: { multiplier: 0.8, label: "20% provider discount" },
		},
	};
	const registered = prepareProviderRegistration(adapter, runtime, {
		"model-alpha": { cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
	});

	assert.deepEqual(registered.models?.[0]?.cost, {
		input: 4,
		output: 24,
		cacheRead: 0.4,
		cacheWrite: 5,
	});
});

test("matches pricing policies and metadata after normalizing model IDs", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [{ id: " model-alpha " }];
	const runtime = getDefaultProviderKitDependencies();
	runtime.pricingPolicies = {
		"discounted-provider": {
			models: { "model-alpha": { multiplier: 0.5, label: "50% normalized model discount" } },
		},
	};
	const registered = prepareProviderRegistration(adapter, runtime, {
		"model-alpha": { cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 } },
	});

	assert.deepEqual(registered.models?.[0]?.cost, {
		input: 5,
		output: 10,
		cacheRead: 0.5,
		cacheWrite: 1,
	});
	assert.equal(
		adapter.registration?.modelMetadata?.["model-alpha"]?.pricing.adjustment?.label,
		"50% normalized model discount",
	);
});

test("prioritizes model draft and runtime policy adjustments over adapter defaults", () => {
	const adapter = providerAdapter();
	adapter.provider.models = [
		{
			id: "model-alpha",
			pricingAdjustment: { multiplier: 0.7, label: "30% model draft discount" },
		},
	];
	const runtime = getDefaultProviderKitDependencies();
	runtime.pricingPolicies = {
		"discounted-provider": {
			defaultAdjustment: { multiplier: 0.9, label: "10% runtime default discount" },
			models: { "model-alpha": { multiplier: 0.5, label: "50% runtime model discount" } },
		},
	};
	const registered = prepareProviderRegistration(adapter, runtime, {
		"model-alpha": { cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 } },
	});

	assert.deepEqual(registered.models?.[0]?.cost, {
		input: 7,
		output: 14,
		cacheRead: 0.7,
		cacheWrite: 1.4,
	});

	adapter.provider.models = [{ id: "model-alpha" }];
	const runtimeModelPolicy = prepareProviderRegistration(adapter, runtime, {
		"model-alpha": { cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 } },
	});
	assert.deepEqual(runtimeModelPolicy.models?.[0]?.cost, {
		input: 5,
		output: 10,
		cacheRead: 0.5,
		cacheWrite: 1,
	});
});

test("keeps a Provider fallback as the effective base price", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [
		{
			id: "model-alpha",
			cost: { input: 9, output: 18, cacheRead: 0.9, cacheWrite: 2 },
			pricingSource: "fallback",
		},
	];
	const registered = prepareProviderRegistration(adapter, getDefaultProviderKitDependencies(), {
		"model-alpha": { cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
	});

	assert.deepEqual(registered.models?.[0]?.cost, {
		input: 9,
		output: 18,
		cacheRead: 0.9,
		cacheWrite: 2,
	});
	assert.equal(adapter.registration?.modelMetadata?.["model-alpha"]?.pricing.source, "fallback");
});

test("attaches quality metadata without replacing provider pricing", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [
		{
			id: "model-alpha",
			cost: { input: 9, output: 18, cacheRead: 0.9, cacheWrite: 2 },
			pricingSource: "provider",
		},
	];
	const registered = prepareProviderRegistration(adapter, getDefaultProviderKitDependencies(), {
		"model-alpha": {
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			quality: [
				{
					source: "artificial-analysis",
					benchmark: "Artificial Analysis",
					category: "intelligence",
					metric: "score",
					value: 51.2,
				},
			],
		},
	});

	assert.deepEqual(registered.models?.[0]?.cost, {
		input: 9,
		output: 18,
		cacheRead: 0.9,
		cacheWrite: 2,
	});
	assert.deepEqual(adapter.registration?.modelMetadata?.["model-alpha"]?.quality, [
		{
			source: "artificial-analysis",
			benchmark: "Artificial Analysis",
			category: "intelligence",
			metric: "score",
			value: 51.2,
		},
	]);
});

test("records the source of each registered model field", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [
		{
			id: "model-alpha",
			contextWindow: 128_000,
			input: ["text"],
			reasoning: false,
		},
	];
	prepareProviderRegistration(adapter, getDefaultProviderKitDependencies(), {
		"model-alpha": {
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			reasoning: true,
		},
	});

	assert.deepEqual(adapter.registration?.modelMetadata?.["model-alpha"]?.fieldSources, {
		contextWindow: "provider",
		maxTokens: "official",
		input: "provider",
		reasoning: "provider",
	});
});

test("keeps an explicit discount unavailable when no base price exists", () => {
	const adapter = providerAdapter();
	const registered = prepareProviderRegistration(adapter, getDefaultProviderKitDependencies());

	assert.deepEqual(registered.models?.[0]?.cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
	assert.deepEqual(adapter.registration?.modelMetadata?.["model-alpha"]?.pricing, {
		known: false,
		source: "none",
		adjustment: {
			multiplier: 0.8,
			label: "20% provider discount",
			source: "provider contract",
		},
		note: "discount configured, base price unavailable",
	});
	assert.equal("pricingAdjustment" in (registered.models?.[0] ?? {}), false);
});

test("refreshes the pricing sidecar when a dynamic catalog changes", async () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [{ id: "initial-model" }];
	adapter.provider.refreshModels = async () => [{ id: "refreshed-model" }];
	const registered = prepareProviderRegistration(adapter, getDefaultProviderKitDependencies(), {
		"refreshed-model": {
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.25 },
			quality: [
				{
					source: "artificial-analysis",
					benchmark: "Artificial Analysis",
					category: "intelligence",
					metric: "score",
					value: 48.5,
				},
			],
		},
	});

	const refreshed = await registered.refreshModels?.({} as any);
	assert.deepEqual(refreshed?.[0]?.cost, {
		input: 1,
		output: 2,
		cacheRead: 0.1,
		cacheWrite: 0.25,
	});
	assert.equal(adapter.registration?.modelMetadata?.["initial-model"], undefined);
	assert.equal(adapter.registration?.modelMetadata?.["refreshed-model"]?.pricing.source, "official");
	assert.equal(adapter.registration?.modelMetadata?.["refreshed-model"]?.quality?.[0]?.category, "intelligence");
});

test("registers a discounted reference price and keeps pricing provenance", () => {
	const adapter = providerAdapter();
	const registered = prepareProviderRegistration(adapter, getDefaultProviderKitDependencies(), {
		"model-alpha": {
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		},
	});

	assert.deepEqual(registered.models?.[0]?.cost, {
		input: 4,
		output: 24,
		cacheRead: 0.4,
		cacheWrite: 5,
	});
	assert.deepEqual(adapter.registration?.modelMetadata?.["model-alpha"]?.pricing, {
		known: true,
		source: "official",
		baseCost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		effectiveCost: { input: 4, output: 24, cacheRead: 0.4, cacheWrite: 5 },
		adjustment: {
			multiplier: 0.8,
			label: "20% provider discount",
			source: "provider contract",
		},
	});
});
