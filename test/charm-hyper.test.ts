import assert from "node:assert/strict";
import test from "node:test";
import { prepareProviderRegistration } from "../core/provider-registration.ts";
import { resolvePiProviderDependencies } from "../core/runtime-config.ts";
import type { ProviderRefreshContext } from "../core/types.ts";
import {
	createCharmHyperAdapter,
	HYPER_MODEL_CATALOG_TTL_MS,
	HYPER_MODELS_URL,
	HYPER_PROVIDER_URL,
	HYPER_USER_AGENT,
	parseHyperModels,
} from "../providers/charm-hyper.ts";

function refreshContext(overrides: Partial<ProviderRefreshContext> = {}): ProviderRefreshContext {
	const base: ProviderRefreshContext = {
		allowNetwork: false,
		signal: new AbortController().signal,
		publish: async ({ update }) => {
			update?.();
			return true;
		},
	};
	return { ...base, ...overrides };
}

test("does not apply hardcoded model-specific overrides", () => {
	const models = parseHyperModels({
		object: "list",
		data: [
			{
				id: "qwen3-coder-480b-a35b-instruct-int4-mixed-ar",
				supports_reasoning: true,
			},
			{
				id: "qwen3-next-80b-a3b-instruct",
				supports_reasoning: true,
			},
			{
				id: "gpt-oss-120b",
				supports_reasoning: true,
				supports_reasoning_effort: true,
				reasoning_effort_levels: ["low", "medium", "high"],
			},
		],
	});

	assert.equal(models[0].reasoning, true);
	assert.equal(models[1].reasoning, true);
	assert.deepEqual(models[2].thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	});
});

test("parses the current Charm Hyper capabilities schema", () => {
	const models = parseHyperModels({
		object: "list",
		data: [
			{
				id: "kimi-k2.6",
				capabilities: { vision: true },
				reasoning: {
					effort_levels: [
						{ value: "low", display: "Low" },
						{ value: "high", display: "High" },
					],
					default_effort_level: "high",
				},
				pricing: { input: 0.95, output: 4, cache_create: 0.16, cache_hit: 0 },
			},
		],
	});

	assert.equal(models[0].reasoning, true);
	assert.deepEqual(models[0].thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	});
	assert.deepEqual(models[0].input, ["text", "image"]);
	assert.deepEqual(models[0].compat, {
		supportsStore: false,
		supportsReasoningEffort: true,
		thinkingFormat: "deepseek",
		maxTokensField: "max_tokens",
	});
	assert.deepEqual(models[0].cost, { input: 0.95, output: 4, cacheRead: 0, cacheWrite: 0.16 });
});

test("parses the current Hyper /provider catalog schema", () => {
	const [model] = parseHyperModels({
		models: [
			{
				id: "current-model",
				name: "Current Model",
				cost_per_1m_in: 0.95,
				cost_per_1m_out: 4,
				cost_per_1m_in_cached: 0.16,
				cost_per_1m_out_cached: 0.8,
				context_window: 262_144,
				default_max_tokens: 32_768,
				can_reason: true,
				reasoning_levels: ["low", "high"],
				default_reasoning_effort: "high",
				supports_attachments: true,
			},
		],
	});

	assert.equal(model.id, "current-model");
	assert.equal(model.name, "Current Model");
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	});
	assert.deepEqual(model.compat, {
		supportsStore: false,
		supportsReasoningEffort: true,
		thinkingFormat: "deepseek",
		maxTokensField: "max_tokens",
	});
	assert.deepEqual(model.headers, { "User-Agent": HYPER_USER_AGENT });
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(model.cost, { input: 0.95, output: 4, cacheRead: 0.8, cacheWrite: 0.16 });
	assert.equal(model.contextWindow, 262_144);
	assert.equal(model.maxTokens, 32_768);
});

test("maps reasoning-only current Hyper models to an on/off thinking mode", () => {
	const [model] = parseHyperModels({
		models: [
			{
				id: "reasoning-only",
				name: "Reasoning Only",
				cost_per_1m_in: 1,
				cost_per_1m_out: 2,
				cost_per_1m_in_cached: 0,
				context_window: 128_000,
				default_max_tokens: 16_384,
				can_reason: true,
				supports_attachments: false,
			},
		],
	});

	assert.deepEqual(model.thinkingLevelMap, {
		off: "off",
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: "max",
	});
	assert.equal((model.compat as { supportsReasoningEffort?: boolean } | undefined)?.supportsReasoningEffort, false);
});

test("skips malformed current Hyper models while retaining valid entries", () => {
	assert.deepEqual(
		parseHyperModels({
			models: [
				{
					id: "valid-model",
					name: "Valid Model",
					cost_per_1m_in: 1,
					cost_per_1m_out: 2,
					cost_per_1m_in_cached: 0,
					context_window: 128_000,
					default_max_tokens: 16_384,
					can_reason: false,
					supports_attachments: false,
				},
				{ id: "invalid-model", name: "Invalid Model", can_reason: true },
			],
		}).map(({ id }) => id),
		["valid-model"],
	);
});

test("reports invalid and duplicate current-schema models", async () => {
	const validModel = {
		id: "current-model",
		name: "Current Model",
		cost_per_1m_in: 1,
		cost_per_1m_out: 2,
		cost_per_1m_in_cached: 0,
		context_window: 128_000,
		default_max_tokens: 16_384,
		can_reason: false,
		supports_attachments: false,
	};
	const adapter = createCharmHyperAdapter(
		async () =>
			new Response(
				JSON.stringify({
					models: [validModel, { ...validModel, id: "CURRENT-MODEL" }, { id: "invalid-model" }],
				}),
				{ status: 200 },
			),
		100,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	await refreshModels(refreshContext({ allowNetwork: true, force: true }));

	assert.equal(adapter.catalog?.rejectedCount, 1);
	assert.equal(adapter.catalog?.duplicateCount, 1);
});

test("reports invalid and duplicate legacy models from a successful catalog", async () => {
	const adapter = createCharmHyperAdapter(
		async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "valid-model" },
						{ id: "VALID-MODEL" },
						{ id: "" },
						{ id: "invalid-window", context_window: -1 },
					],
				}),
				{ status: 200 },
			),
		100,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	await refreshModels(refreshContext({ allowNetwork: true, force: true }));

	assert.deepEqual(
		adapter.provider.models.map(({ id }) => id),
		["valid-model"],
	);
	assert.equal(adapter.catalog?.rejectedCount, 2);
	assert.equal(adapter.catalog?.duplicateCount, 1);
});

test("sends a versioned User-Agent for Hyper model discovery", async () => {
	let userAgent: string | null = null;
	const adapter = createCharmHyperAdapter(async (_input, init) => {
		userAgent = new Headers(init?.headers).get("user-agent");
		return new Response(JSON.stringify({ data: [{ id: "legacy-model" }] }), { status: 200 });
	}, 100);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	await refreshModels(refreshContext({ allowNetwork: true, force: true }));

	assert.equal(userAgent, HYPER_USER_AGENT);
});

test("falls back to the legacy Hyper model endpoint after a current endpoint 404", async () => {
	const requests: string[] = [];
	const adapter = createCharmHyperAdapter(async (input) => {
		requests.push(String(input));
		if (requests.length === 1) return new Response("not found", { status: 404 });
		return new Response(JSON.stringify({ data: [{ id: "legacy-model" }] }), { status: 200 });
	}, 100);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	const models = await refreshModels(refreshContext({ allowNetwork: true, force: true }));

	assert.deepEqual(requests, [HYPER_PROVIDER_URL, HYPER_MODELS_URL]);
	assert.deepEqual(
		models.map(({ id }) => id),
		["legacy-model"],
	);
});

test("rejects invalid catalogs and filters malformed model entries", () => {
	assert.deepEqual(parseHyperModels(null), []);
	assert.deepEqual(parseHyperModels({ data: {} }), []);
	assert.deepEqual(parseHyperModels({ data: [{}] }), []);

	const models = parseHyperModels({
		data: [
			{ id: "valid", context_window: 128_000, max_output_tokens: 8_000 },
			{ id: "", context_window: 128_000 },
			{ id: "negative", context_window: -1 },
			{ id: "fractional", max_output_tokens: 1.5 },
			{ id: "infinite", context_window: Number.POSITIVE_INFINITY },
			{ id: "valid", context_window: 256_000 },
		],
	});

	assert.deepEqual(
		models.map(({ id }) => id),
		["valid"],
	);
	assert.equal(models[0].contextWindow, 128_000);
});

test("sanitizes malformed optional capabilities, efforts, and pricing", () => {
	const [model] = parseHyperModels({
		data: [
			{
				id: "safe",
				capabilities: "vision",
				reasoning: { effort_levels: [{ value: "high" }, null, { value: 42 }, { value: "unknown" }] },
				reasoning_effort_levels: "low",
				pricing: { input: -1, output: Number.NaN, cache_create: "1", cache_hit: 0.5 },
			},
		],
	});

	assert.equal(model.input, undefined);
	assert.deepEqual(model.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	});
	assert.equal(model.cost, undefined);
	assert.equal(model.pricingSource, undefined);
});

test("rejects malformed legacy Hyper pricing instead of treating it as provider cost", () => {
	const [model] = parseHyperModels({
		data: [
			{
				id: "malformed-pricing",
				pricing: { input: -1, output: Number.NaN, cache_hit: 0.5, cache_create: "1" },
			},
		],
	});

	assert.equal(model.cost, undefined);
	assert.equal(model.pricingSource, undefined);
});

test("retains native OAuth when Charm Hyper is registered", () => {
	const adapter = createCharmHyperAdapter(async () => new Response(JSON.stringify({ data: [{ id: "model" }] })), 100);
	const registered = prepareProviderRegistration(
		adapter,
		resolvePiProviderDependencies({ enableOfficialPricingFallback: false }),
	);

	assert.equal(adapter.provider.oauth?.name, "Charm Hyper");
	assert.equal(registered.oauth?.name, "Charm Hyper");
	assert.equal(typeof registered.oauth?.login, "function");
	assert.equal(typeof registered.oauth?.refreshToken, "function");
	assert.equal(typeof registered.oauth?.getApiKey, "function");
});

test("starts with an empty catalog without waiting for model discovery", () => {
	let requests = 0;
	const adapter = createCharmHyperAdapter(async () => {
		requests++;
		return new Response(JSON.stringify({ data: [] }), { status: 200 });
	}, 5);

	assert.equal(requests, 0);
	assert.equal(adapter.catalog?.source, "empty");
	assert.equal(adapter.provider.models.length, 0);
});

test("times out model refreshes even without a caller signal", async () => {
	const adapter = createCharmHyperAdapter(
		async (_input, init) =>
			await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			}),
		5,
	);

	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);
	await assert.rejects(refreshModels(refreshContext({ allowNetwork: true })), { name: "TimeoutError" });
	assert.equal(adapter.catalog?.lastError, "timeout");
});

test("does not request network during a cache-only refresh", async () => {
	let requests = 0;
	const adapter = createCharmHyperAdapter(async () => {
		requests++;
		throw new Error("network should not be used");
	}, 5);

	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);
	const models = await refreshModels(refreshContext({ allowNetwork: false, force: true }));

	assert.equal(requests, 0);
	assert.deepEqual(models, []);
});

test("keeps an empty catalog state through Pi's cache-only refresh wrapper", async () => {
	const adapter = createCharmHyperAdapter(async () => {
		throw new Error("network should not be used");
	}, 5);
	const registered = prepareProviderRegistration(
		adapter,
		resolvePiProviderDependencies({ enableOfficialPricingFallback: false }),
	);

	await registered.refreshModels?.({ allowNetwork: false } as any);

	assert.equal(adapter.catalog?.source, "empty");
	assert.equal(adapter.catalog?.lastError, undefined);
});

test("preserves a failed catalog diagnostic without a static fallback", async () => {
	const adapter = createCharmHyperAdapter(async () => {
		throw new Error("temporary network failure");
	}, 5);
	const registered = prepareProviderRegistration(
		adapter,
		resolvePiProviderDependencies({ enableOfficialPricingFallback: false }),
	);
	const refreshModels = registered.refreshModels;
	assert.ok(refreshModels);

	await assert.rejects(
		refreshModels(refreshContext({ allowNetwork: true, credential: { type: "api_key", key: "test-key" } })),
	);
	await refreshModels(refreshContext({ allowNetwork: true, credential: { type: "api_key", key: "test-key" } }));

	assert.deepEqual(
		adapter.provider.models.map(({ id }) => id),
		[],
	);
	assert.equal(adapter.catalog?.lastError, "fetch");
});

test("restores the provider-scoped catalog before considering network", async () => {
	let requests = 0;
	let writes = 0;
	const stored: NonNullable<ProviderRefreshContext["stored"]> = {
		checkedAt: 1_000,
		models: [
			{
				id: "cached-model",
				name: "Cached Model",
				api: "openai-completions",
				provider: "charm-hyper",
				baseUrl: "https://hyper.charm.land/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
				contextWindow: 32_000,
				maxTokens: 4_000,
			},
		],
	};
	const adapter = createCharmHyperAdapter(
		async () => {
			requests++;
			throw new Error("network should not be used");
		},
		5,
		() => 2_000,
	);

	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);
	const models = await refreshModels(
		refreshContext({
			allowNetwork: false,
			stored,
			publish: async ({ persist, update }) => {
				if (persist !== undefined) writes++;
				update?.();
				return true;
			},
		}),
	);

	assert.deepEqual(
		models.map(({ id }) => id),
		["cached-model"],
	);
	assert.deepEqual(
		adapter.provider.models.map(({ id }) => id),
		["cached-model"],
	);
	assert.equal(adapter.catalog?.source, "cached");
	assert.equal(requests, 0);
	assert.equal(writes, 0);
});

test("replaces a cached catalog with the complete live catalog", async () => {
	const stored: NonNullable<ProviderRefreshContext["stored"]> = {
		checkedAt: 1_000,
		models: [
			{
				id: "removed-model",
				name: "Removed Model",
				api: "openai-completions",
				provider: "charm-hyper",
				baseUrl: "https://hyper.charm.land/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 4_000,
			},
		],
	};
	const adapter = createCharmHyperAdapter(
		async () => new Response(JSON.stringify({ data: [{ id: "current-model" }] }), { status: 200 }),
		100,
		() => 2_000,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	await refreshModels(
		refreshContext({
			allowNetwork: true,
			force: true,
			stored,
			credential: { type: "api_key", key: "test-key" },
		}),
	);

	assert.deepEqual(
		adapter.provider.models.map(({ id }) => id),
		["current-model"],
	);
	assert.equal(adapter.catalog?.source, "live");
	assert.equal(adapter.catalog?.modelCount, 1);
});

test("persists a successful catalog for a later adapter instance", async () => {
	let stored: ProviderRefreshContext["stored"];
	let requests = 0;
	const context = (allowNetwork: boolean): ProviderRefreshContext =>
		refreshContext({
			allowNetwork,
			stored,
			publish: async ({ persist, update }) => {
				if (persist !== undefined) stored = persist ?? undefined;
				update?.();
				return true;
			},
		});
	const firstAdapter = createCharmHyperAdapter(
		async () => {
			requests++;
			return new Response(JSON.stringify({ data: [{ id: "persisted-model" }] }), { status: 200 });
		},
		100,
		() => 1_000,
	);
	const firstRefresh = firstAdapter.provider.refreshModels;
	assert.ok(firstRefresh);
	await firstRefresh(context(true));

	const secondAdapter = createCharmHyperAdapter(
		async () => {
			requests++;
			throw new Error("network should not be used");
		},
		100,
		() => 1_500,
	);
	const secondRefresh = secondAdapter.provider.refreshModels;
	assert.ok(secondRefresh);
	const restored = await secondRefresh(context(false));

	assert.equal(requests, 1);
	assert.deepEqual(
		restored.map(({ id }) => id),
		["persisted-model"],
	);
});

test("does not apply a catalog rejected by Pi's refresh generation guard", async () => {
	const adapter = createCharmHyperAdapter(
		async () => new Response(JSON.stringify({ data: [{ id: "stale-model" }] }), { status: 200 }),
		100,
		() => 1_000,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	const models = await refreshModels(
		refreshContext({
			allowNetwork: true,
			force: true,
			publish: async () => false,
		}),
	);

	assert.deepEqual(models, []);
	assert.equal(adapter.catalog?.source, "empty");
});

test("shares a refresh after Pi supersedes an older generation", async () => {
	let requests = 0;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const adapter = createCharmHyperAdapter(
		async () => {
			requests++;
			await gate;
			return new Response(JSON.stringify({ data: [{ id: "current-model" }] }), { status: 200 });
		},
		100,
		() => 1_000,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	let activeGeneration = 1;
	const firstController = new AbortController();
	const contextFor = (generation: number, signal: AbortSignal): ProviderRefreshContext =>
		refreshContext({
			allowNetwork: true,
			force: true,
			signal,
			publish: async ({ update }) => {
				if (generation !== activeGeneration) return false;
				update?.();
				return true;
			},
		});

	const first = refreshModels(contextFor(1, firstController.signal));
	void first.catch(() => undefined);
	await new Promise((resolve) => setImmediate(resolve));
	activeGeneration = 2;
	firstController.abort();
	const second = refreshModels(contextFor(2, new AbortController().signal));
	await new Promise((resolve) => setImmediate(resolve));
	const requestsBeforeRelease = requests;
	release?.();
	const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);

	assert.equal(requestsBeforeRelease, 1);
	assert.equal(firstOutcome.status, "rejected");
	assert.equal(secondOutcome.status, "fulfilled");
	assert.deepEqual(
		adapter.provider.models.map(({ id }) => id),
		["current-model"],
	);
});

test("coalesces concurrent refreshes in one generation and reuses a fresh snapshot", async () => {
	let requests = 0;
	let release: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		release = resolve;
	});
	const adapter = createCharmHyperAdapter(
		async () => {
			requests++;
			await started;
			return new Response(JSON.stringify({ data: [{ id: "remote-model" }] }), { status: 200 });
		},
		100,
		() => 1_000,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	const context = refreshContext({ allowNetwork: true });
	const first = refreshModels(context);
	await new Promise((resolve) => setImmediate(resolve));
	const second = refreshModels(context);
	assert.equal(requests, 1);
	release?.();
	await Promise.all([first, second]);
	await refreshModels(refreshContext({ allowNetwork: true }));

	assert.equal(requests, 1);
	assert.deepEqual(
		adapter.provider.models.map(({ id }) => id),
		["remote-model"],
	);
});

test("reuses the catalog within its TTL and force refresh bypasses it", async () => {
	let requests = 0;
	let now = 1_000;
	const adapter = createCharmHyperAdapter(
		async () => {
			requests++;
			return new Response(JSON.stringify({ data: [{ id: `remote-${requests}` }] }), { status: 200 });
		},
		100,
		() => now,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	await refreshModels(refreshContext({ allowNetwork: true }));
	await refreshModels(refreshContext({ allowNetwork: true }));
	now += HYPER_MODEL_CATALOG_TTL_MS + 1;
	await refreshModels(refreshContext({ allowNetwork: true }));
	await refreshModels(refreshContext({ allowNetwork: true, force: true }));

	assert.equal(requests, 3);
	assert.deepEqual(
		adapter.provider.models.map(({ id }) => id),
		["remote-3"],
	);
});

test("keeps the last successful catalog after a failed refresh", async () => {
	let requests = 0;
	const adapter = createCharmHyperAdapter(
		async () => {
			requests++;
			if (requests === 1) return new Response(JSON.stringify({ data: [{ id: "good-model" }] }), { status: 200 });
			throw new Error("temporary network failure");
		},
		100,
		() => 1_000,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	await refreshModels(refreshContext({ allowNetwork: true }));
	await assert.rejects(refreshModels(refreshContext({ allowNetwork: true, force: true })));
	assert.deepEqual(
		adapter.provider.models.map(({ id }) => id),
		["good-model"],
	);
	assert.equal(adapter.catalog?.lastError, "fetch");
	await refreshModels(refreshContext({ allowNetwork: true }));

	assert.equal(requests, 2);
});

test("uses official costs only when upstream pricing is absent", () => {
	const [known, explicit, unknown] = parseHyperModels({
		data: [
			{ id: "kimi-k2.6" },
			{ id: "deepseek-v4-flash", pricing: { input: 0, output: 0, cache_hit: 0, cache_create: 0 } },
			{ id: "unpriced-custom-model" },
		],
	});

	assert.equal(known.cost, undefined);
	assert.deepEqual(explicit.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(unknown.cost, undefined);
});

test("invalidates legacy normalized snapshots on restore", async () => {
	const adapter = createCharmHyperAdapter(
		async () => new Response(JSON.stringify({ data: [{ id: "online-model" }] }), { status: 200 }),
		100,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	const legacyStored = {
		checkedAt: Date.now(),
		models: [
			{
				id: "legacy-model",
				name: "legacy-model",
				provider: "charm-hyper",
				baseUrl: "https://hyper.charm.land/v1",
				api: "openai-completions" as const,
				contextWindow: 128_000,
				maxTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				input: ["text" as const],
			},
		],
	};

	const result = await refreshModels(refreshContext({ allowNetwork: false, stored: legacyStored }));
	assert.equal(result.length, 0);
	assert.equal(adapter.provider.models.length, 0);
});

test("Provider explicit endpoint fields take precedence over Pi catalog", async () => {
	const runtime = resolvePiProviderDependencies();
	const adapter = createCharmHyperAdapter(
		async () =>
			new Response(
				JSON.stringify({
					models: [
						{
							id: "claude-sonnet-4",
							name: "Provider Explicit Sonnet",
							cost_per_1m_in: 5.0,
							cost_per_1m_out: 25.0,
							cost_per_1m_in_cached: 1.0,
							context_window: 300_000,
							default_max_tokens: 40_000,
							can_reason: true,
							supports_attachments: true,
							reasoning_levels: ["low", "high"],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		100,
	);

	const piCatalogSnapshot = {
		models: {
			"claude-sonnet-4": {
				cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 8_192,
				reasoning: false,
				input: ["text" as const],
			},
		},
		providers: {},
	};

	const registered = prepareProviderRegistration(adapter, runtime, piCatalogSnapshot);
	assert.ok(registered.refreshModels);

	const models = await registered.refreshModels(
		refreshContext({
			allowNetwork: true,
			force: true,
			credential: { type: "api_key", key: "test-key" },
		}),
	);

	assert.equal(models.length, 1);
	const model = models[0];
	assert.equal(model.id, "claude-sonnet-4");
	assert.equal(model.name, "Provider Explicit Sonnet");
	assert.equal(model.contextWindow, 300_000);
	assert.equal(model.maxTokens, 40_000);
	assert.deepEqual(model.cost, { input: 5.0, output: 25.0, cacheRead: 0, cacheWrite: 1.0 });
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.reasoning, true);
});

test("Provider missing fields are completed by Pi catalog", async () => {
	const runtime = resolvePiProviderDependencies();
	const adapter = createCharmHyperAdapter(
		async () =>
			new Response(
				JSON.stringify({
					data: [{ id: "claude-sonnet-4" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		100,
	);

	const piCatalogSnapshot = {
		models: {
			"claude-sonnet-4": {
				cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 8_192,
				reasoning: true,
				thinkingLevelMap: { low: "low", high: "high" },
				input: ["text" as const, "image" as const],
			},
		},
		providers: {},
	};

	const registered = prepareProviderRegistration(adapter, runtime, piCatalogSnapshot);
	assert.ok(registered.refreshModels);

	const models = await registered.refreshModels(
		refreshContext({
			allowNetwork: true,
			force: true,
			credential: { type: "api_key", key: "test-key" },
		}),
	);

	assert.equal(models.length, 1);
	const model = models[0];
	assert.equal(model.id, "claude-sonnet-4");
	assert.equal(model.contextWindow, 200_000);
	assert.equal(model.maxTokens, 8_192);
	assert.deepEqual(model.cost, { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 });
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.thinkingLevelMap, { low: "low", high: "high" });
});

test("Explicit false, zero price, and text-only input are preserved against Pi catalog", async () => {
	const runtime = resolvePiProviderDependencies();
	const adapter = createCharmHyperAdapter(
		async () =>
			new Response(
				JSON.stringify({
					models: [
						{
							id: "claude-sonnet-4",
							name: "Free Non-reasoning Text Sonnet",
							cost_per_1m_in: 0,
							cost_per_1m_out: 0,
							cost_per_1m_in_cached: 0,
							context_window: 100_000,
							default_max_tokens: 4_000,
							can_reason: false,
							supports_attachments: false,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		100,
	);

	const piCatalogSnapshot = {
		models: {
			"claude-sonnet-4": {
				cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 8_192,
				reasoning: true,
				input: ["text" as const, "image" as const],
			},
		},
		providers: {},
	};

	const registered = prepareProviderRegistration(adapter, runtime, piCatalogSnapshot);
	assert.ok(registered.refreshModels);

	const models = await registered.refreshModels(
		refreshContext({
			allowNetwork: true,
			force: true,
			credential: { type: "api_key", key: "test-key" },
		}),
	);

	assert.equal(models.length, 1);
	const model = models[0];
	assert.equal(model.id, "claude-sonnet-4");
	assert.equal(model.reasoning, false);
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(model.input, ["text"]);
});

test("Invalid models and duplicate models do not overwrite existing valid catalog", async () => {
	let callCount = 0;
	const adapter = createCharmHyperAdapter(async () => {
		callCount++;
		if (callCount === 1) {
			return new Response(
				JSON.stringify({
					data: [{ id: "valid-initial-model" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response(
			JSON.stringify({
				models: [],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}, 100);

	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	const first = await refreshModels(refreshContext({ allowNetwork: true }));
	assert.deepEqual(
		first.map((m) => m.id),
		["valid-initial-model"],
	);

	await assert.rejects(refreshModels(refreshContext({ allowNetwork: true, force: true })));

	assert.deepEqual(
		adapter.provider.models.map((m) => m.id),
		["valid-initial-model"],
	);

	const dupAdapter = createCharmHyperAdapter(
		async () =>
			new Response(
				JSON.stringify({
					data: [{ id: "dup-model" }, { id: "dup-model" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		100,
	);
	const dupRefresh = dupAdapter.provider.refreshModels;
	assert.ok(dupRefresh);
	const deduped = await dupRefresh(refreshContext({ allowNetwork: true }));
	assert.deepEqual(
		deduped.map((m) => m.id),
		["dup-model"],
	);
});

test("Successful refresh persists raw drafts without injected normalization defaults", async () => {
	let persistedEntry: any;
	const adapter = createCharmHyperAdapter(
		async () =>
			new Response(
				JSON.stringify({
					data: [{ id: "raw-sparse-model" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		100,
	);

	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	await refreshModels(
		refreshContext({
			allowNetwork: true,
			force: true,
			publish: async ({ persist, update }) => {
				if (persist) persistedEntry = persist;
				update?.();
				return true;
			},
		}),
	);

	assert.ok(persistedEntry, "Persisted entry must be provided");
	assert.equal(persistedEntry.models.length, 1);
	const persistedModel = persistedEntry.models[0];
	assert.equal(persistedModel.id, "raw-sparse-model");
	assert.equal(persistedModel.cost, undefined);
	assert.equal(persistedModel.reasoning, undefined);
	assert.equal(persistedModel.contextWindow, undefined);
	assert.equal(persistedModel.maxTokens, undefined);
});

test("Legacy normalized snapshot is rejected on restore and triggers online discovery", async () => {
	let fetchCalls = 0;
	const adapter = createCharmHyperAdapter(async () => {
		fetchCalls++;
		return new Response(
			JSON.stringify({
				data: [{ id: "online-fresh-model" }],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}, 100);

	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);

	const legacyStored = {
		checkedAt: Date.now() - 1000,
		models: [
			{
				id: "legacy-normalized-model",
				name: "legacy-normalized-model",
				provider: "charm-hyper",
				baseUrl: "https://hyper.charm.land/v1",
				api: "openai-completions" as const,
				contextWindow: 128_000,
				maxTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				input: ["text" as const],
			},
		],
	};

	const offlineResult = await refreshModels(
		refreshContext({
			allowNetwork: false,
			stored: legacyStored,
		}),
	);
	assert.equal(offlineResult.length, 0);
	assert.equal(fetchCalls, 0);

	const onlineResult = await refreshModels(
		refreshContext({
			allowNetwork: true,
			stored: legacyStored,
		}),
	);
	assert.equal(fetchCalls, 1);
	assert.deepEqual(
		onlineResult.map((m) => m.id),
		["online-fresh-model"],
	);
});
