import assert from "node:assert/strict";
import test from "node:test";
import {
	prepareProviderRegistration,
	refreshProviderRegistrations,
	registerProviderAdapter,
} from "../core/provider-registration.ts";
import { getDefaultPiProviderDependencies } from "../core/runtime-config.ts";
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
	const runtime = getDefaultPiProviderDependencies();
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
	const runtime = getDefaultPiProviderDependencies();
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
	const runtime = getDefaultPiProviderDependencies();
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
	const registered = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies(), {
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

test("preserves provider pricing without being overridden by Pi catalog reference", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [
		{
			id: "model-alpha",
			cost: { input: 9, output: 18, cacheRead: 0.9, cacheWrite: 2 },
			pricingSource: "provider",
		},
	];
	const registered = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies(), {
		"model-alpha": {
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		},
	});

	assert.deepEqual(registered.models?.[0]?.cost, {
		input: 9,
		output: 18,
		cacheRead: 0.9,
		cacheWrite: 2,
	});
	assert.equal(adapter.registration?.modelMetadata?.["model-alpha"]?.pricing.source, "provider");
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
	prepareProviderRegistration(adapter, getDefaultPiProviderDependencies(), {
		"model-alpha": {
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			reasoning: true,
		},
	});

	assert.deepEqual(adapter.registration?.modelMetadata?.["model-alpha"]?.fieldSources, {
		cost: "pi",
		contextWindow: "provider",
		maxTokens: "pi",
		input: "provider",
		reasoning: "provider",
		thinkingLevelMap: "default",
		costBySku: {
			input: "pi",
			output: "pi",
			cacheRead: "pi",
			cacheWrite: "pi",
		},
	});
});

test("records cost and thinking-map sources without overriding Provider fields", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [
		{
			id: "provider-model",
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			pricingSource: "fallback",
			thinkingLevelMap: { high: "provider-high" },
		},
		{ id: "pi-model" },
	];
	prepareProviderRegistration(adapter, getDefaultPiProviderDependencies(), {
		"provider-model": {
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			thinkingLevelMap: { high: "pi-high" },
		},
		"pi-model": {
			cost: { input: 3, output: 9, cacheRead: 0, cacheWrite: 0 },
			thinkingLevelMap: { low: "low", high: "high" },
		},
	});

	assert.equal(adapter.registration?.modelMetadata?.["provider-model"]?.fieldSources?.cost, "fallback");
	assert.equal(adapter.registration?.modelMetadata?.["provider-model"]?.fieldSources?.thinkingLevelMap, "provider");
	assert.equal(adapter.registration?.modelMetadata?.["provider-model"]?.pricing.source, "fallback");
	assert.deepEqual(adapter.registration?.modelDrafts[0]?.thinkingLevelMap, { high: "provider-high" });
	assert.equal(adapter.registration?.modelMetadata?.["pi-model"]?.fieldSources?.cost, "pi");
	assert.equal(adapter.registration?.modelMetadata?.["pi-model"]?.fieldSources?.thinkingLevelMap, "pi");
	assert.equal(adapter.registration?.modelMetadata?.["pi-model"]?.pricing.source, "pi");
});

test("records default sources when cost and thinking metadata are unavailable", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [{ id: "model-without-metadata" }];
	prepareProviderRegistration(adapter, getDefaultPiProviderDependencies());

	const metadata = adapter.registration?.modelMetadata?.["model-without-metadata"];
	assert.equal(metadata?.fieldSources?.cost, "default");
	assert.equal(metadata?.fieldSources?.thinkingLevelMap, "default");
	assert.equal(metadata?.pricing.source, "none");
	assert.equal(metadata?.pricing.known, false);
});

test("normalizes incomplete costs before calculating pricing adjustments", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [
		{
			id: "partial-cost-model",
			cost: { input: 1 } as any,
			pricingAdjustment: { multiplier: 0.8, label: "20% discount" },
		},
	];
	const registered = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies());
	const cost = registered.models?.[0]?.cost;
	const pricing = adapter.registration?.modelMetadata?.["partial-cost-model"]?.pricing;

	assert.deepEqual(cost, { input: 0.8, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(pricing?.baseCost, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(pricing?.effectiveCost, cost);
	assert.equal(pricing?.known, true);
	assert.ok(cost && Object.values(cost).every((value) => typeof value === "number" && Number.isFinite(value)));
	assert.equal(adapter.registration?.modelMetadata?.["partial-cost-model"]?.fieldSources?.cost, "normalized");
});

test("reports normalized sources for fields changed by model registration", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [
		{
			id: "normalized-model",
			input: [],
			contextWindow: 100_000,
			maxTokens: 200_000,
		},
	];
	prepareProviderRegistration(adapter, getDefaultPiProviderDependencies());

	assert.deepEqual(adapter.registration?.normalizedModels[0]?.input, ["text"]);
	assert.equal(adapter.registration?.normalizedModels[0]?.maxTokens, 100_000);
	assert.equal(adapter.registration?.modelMetadata?.["normalized-model"]?.fieldSources?.input, "normalized");
	assert.equal(adapter.registration?.modelMetadata?.["normalized-model"]?.fieldSources?.maxTokens, "normalized");
});
test("preserves an explicit Provider zero price", () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	adapter.provider.models = [
		{
			id: "model-alpha",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			pricingSource: "provider",
		},
	];
	prepareProviderRegistration(adapter, getDefaultPiProviderDependencies(), {
		"model-alpha": { cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
	});

	assert.deepEqual(adapter.registration?.modelMetadata?.["model-alpha"]?.pricing, {
		known: true,
		source: "provider",
		baseCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		effectiveCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		costBySku: {
			input: "provider",
			output: "provider",
			cacheRead: "provider",
			cacheWrite: "provider",
		},
	});
	assert.equal(adapter.registration?.modelMetadata?.["model-alpha"]?.fieldSources?.cost, "provider");
});

test("keeps an explicit discount unavailable when no base price exists", () => {
	const adapter = providerAdapter();
	const registered = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies());

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
	const registered = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies(), {
		"refreshed-model": {
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.25 },
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
	assert.equal(adapter.registration?.modelMetadata?.["refreshed-model"]?.pricing.source, "pi");
});

test("registers an OAuth-only Provider when its optional environment API key is absent", () => {
	const environmentName = "PI_PROVIDER_OPTIONAL_OAUTH_API_KEY";
	const previous = process.env[environmentName];
	delete process.env[environmentName];
	try {
		const adapter = providerAdapter();
		adapter.provider.apiKey = `$${environmentName}`;
		adapter.provider.authHeader = true;
		adapter.provider.oauth = {
			name: "Optional OAuth",
			login: async () => ({ access: "access", refresh: "refresh", expires: 1 }),
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		};
		const runtime = getDefaultPiProviderDependencies();
		runtime.readStoredCredential = () => undefined;

		const registered = prepareProviderRegistration(adapter, runtime);

		assert.equal(registered.apiKey, undefined);
		assert.equal(registered.oauth, adapter.provider.oauth);
		assert.equal(registered.authHeader, true);

		runtime.readStoredCredential = () => ({ type: "api_key" });
		assert.equal(prepareProviderRegistration(adapter, runtime).apiKey, `$${environmentName}`);
		runtime.readStoredCredential = () => undefined;
		process.env[environmentName] = "configured-key";
		assert.equal(prepareProviderRegistration(adapter, runtime).apiKey, `$${environmentName}`);
	} finally {
		if (previous === undefined) delete process.env[environmentName];
		else process.env[environmentName] = previous;
	}
});

test("clears a previously registered environment key before switching to OAuth-only auth", () => {
	const environmentName = "PI_PROVIDER_RELOADED_OPTIONAL_API_KEY";
	const previous = process.env[environmentName];
	delete process.env[environmentName];
	try {
		const adapter = providerAdapter();
		adapter.provider.apiKey = `$${environmentName}`;
		adapter.provider.oauth = {
			name: "Reloaded OAuth",
			login: async () => ({ access: "access", refresh: "refresh", expires: 1 }),
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		};
		const runtime = getDefaultPiProviderDependencies();
		runtime.readStoredCredential = () => undefined;
		const operations: string[] = [];

		registerProviderAdapter(
			{
				unregisterProvider: (id) => {
					operations.push(`unregister:${id}`);
				},
				registerProvider: (id, config) => {
					operations.push(`register:${id}:${config.apiKey ?? "oauth"}`);
				},
			},
			adapter,
			runtime,
		);

		assert.deepEqual(operations, ["unregister:discounted-provider", "register:discounted-provider:oauth"]);
	} finally {
		if (previous === undefined) delete process.env[environmentName];
		else process.env[environmentName] = previous;
	}
});

test("skips a dynamic catalog network refresh when its API-key environment is absent", async () => {
	const environmentName = "PI_PROVIDER_UNCONFIGURED_CATALOG_KEY";
	const previous = process.env[environmentName];
	delete process.env[environmentName];
	try {
		const adapter = providerAdapter();
		adapter.provider.apiKey = `\${${environmentName}}`;
		let refreshCalls = 0;
		adapter.provider.refreshModels = async () => {
			refreshCalls++;
			throw new Error("unauthenticated catalog request");
		};
		const registered = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies());

		const models = await registered.refreshModels?.({ allowNetwork: true } as any);

		assert.equal(refreshCalls, 0);
		assert.deepEqual(
			models?.map(({ id }) => id),
			["model-alpha"],
		);
		assert.equal(adapter.catalog?.lastError, undefined);
	} finally {
		if (previous === undefined) delete process.env[environmentName];
		else process.env[environmentName] = previous;
	}
});

test("allows a dynamic catalog refresh with an environment or stored credential", async () => {
	const environmentName = "PI_PROVIDER_CONFIGURED_CATALOG_KEY";
	const previous = process.env[environmentName];
	try {
		const adapter = providerAdapter();
		adapter.provider.apiKey = `$${environmentName}`;
		let refreshCalls = 0;
		adapter.provider.refreshModels = async () => [{ id: `refreshed-${++refreshCalls}` }];
		const registered = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies());

		process.env[environmentName] = "test-key";
		const environmentModels = await registered.refreshModels?.({ allowNetwork: true } as any);
		delete process.env[environmentName];
		const credentialModels = await registered.refreshModels?.({
			allowNetwork: true,
			credential: { type: "api_key", key: "stored-key" },
		} as any);

		assert.equal(refreshCalls, 2);
		assert.deepEqual(
			environmentModels?.map(({ id }) => id),
			["refreshed-1"],
		);
		assert.deepEqual(
			credentialModels?.map(({ id }) => id),
			["refreshed-2"],
		);
	} finally {
		if (previous === undefined) delete process.env[environmentName];
		else process.env[environmentName] = previous;
	}
});

test("rejects unsafe and oversized dynamic model catalogs without replacing the active catalog", async () => {
	const unsafeCatalogs = [
		[{ id: "unsafe-\u001b[31m-model" }],
		[{ id: "safe-model", name: "unsafe-\u009b31m-name" }],
		Array.from({ length: 4_097 }, (_, index) => ({ id: `model-${index}` })),
	];

	for (const unsafeCatalog of unsafeCatalogs) {
		const adapter = providerAdapter();
		adapter.provider.refreshModels = async () => unsafeCatalog;
		const registered = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies());

		await assert.rejects(
			async () =>
				await registered.refreshModels?.({
					allowNetwork: true,
					credential: { type: "api_key", key: "stored-key" },
				} as any),
			/unsafe|control|too many|safe text|model ID/i,
		);
		assert.deepEqual(
			registered.models?.map(({ id }) => id),
			["model-alpha"],
		);
	}
});

test("shares registration state when pricing is reapplied during a dynamic refresh", async () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	let signalStarted: (() => void) | undefined;
	let release: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	adapter.provider.refreshModels = async () => {
		signalStarted?.();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return [{ id: "dynamic-model" }];
	};

	const firstRegistration = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies());
	const refresh = firstRegistration.refreshModels?.({
		allowNetwork: true,
		credential: { type: "api_key", key: "stored-key" },
	} as any);
	await started;

	const latestRegistration = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies(), {
		"dynamic-model": { cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } },
	});
	release?.();
	await refresh;

	assert.equal(latestRegistration.models?.[0]?.id, "dynamic-model");
	assert.deepEqual(latestRegistration.models?.[0]?.cost, {
		input: 1,
		output: 2,
		cacheRead: 0.1,
		cacheWrite: 0.2,
	});
});

test("defers pricing re-registration until an active catalog refresh settles", async () => {
	const adapter = providerAdapter();
	adapter.pricing = undefined;
	let signalStarted: (() => void) | undefined;
	let release: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	adapter.provider.refreshModels = async () => {
		signalStarted?.();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return [{ id: "dynamic-model" }];
	};
	const runtime = getDefaultPiProviderDependencies();
	const registrations: any[] = [];
	const pi = {
		registerProvider(_id: string, config: unknown) {
			registrations.push(config);
		},
	};
	refreshProviderRegistrations(pi as any, [adapter], runtime, {});
	const refresh = registrations[0].refreshModels({
		allowNetwork: true,
		credential: { type: "api_key", key: "stored-key" },
	});
	await started;

	refreshProviderRegistrations(pi as any, [adapter], runtime, {
		"dynamic-model": { cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } },
	});
	assert.equal(registrations.length, 1);

	release?.();
	await refresh;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(registrations.length, 2);
	assert.equal(registrations[1].models[0].id, "dynamic-model");
	assert.equal(registrations[1].models[0].cost.input, 1);
});

test("registers a discounted reference price and keeps pricing provenance", () => {
	const adapter = providerAdapter();
	const registered = prepareProviderRegistration(adapter, getDefaultPiProviderDependencies(), {
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
		source: "pi",
		baseCost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		effectiveCost: { input: 4, output: 24, cacheRead: 0.4, cacheWrite: 5 },
		adjustment: {
			multiplier: 0.8,
			label: "20% provider discount",
			source: "provider contract",
		},
		costBySku: {
			input: "pi",
			output: "pi",
			cacheRead: "pi",
			cacheWrite: "pi",
		},
	});
});
