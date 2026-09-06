import assert from "node:assert/strict";
import test from "node:test";
import {
	findPiCatalogModel,
	isLegacyNormalizedModel,
	isLegacyNormalizedSnapshot,
	loadPiCatalog,
	mergeModelWithPiCatalog,
	ORIGINAL_PI_PROVIDER_ALLOWLIST,
	parsePiCatalogFromProviders,
	stripKnownModelSuffixes,
	stripProviderPrefix,
} from "../core/pi-model-metadata.ts";
import type { ProviderModelDraft } from "../core/types.ts";

test("allowlist includes original manufacturers and excludes proxy/aggregator providers", () => {
	assert.ok(ORIGINAL_PI_PROVIDER_ALLOWLIST.has("openai"));
	assert.ok(ORIGINAL_PI_PROVIDER_ALLOWLIST.has("anthropic"));
	assert.ok(ORIGINAL_PI_PROVIDER_ALLOWLIST.has("google"));
	assert.ok(ORIGINAL_PI_PROVIDER_ALLOWLIST.has("deepseek"));
	assert.ok(ORIGINAL_PI_PROVIDER_ALLOWLIST.has("minimax"));
	assert.ok(ORIGINAL_PI_PROVIDER_ALLOWLIST.has("moonshotai"));
	assert.ok(ORIGINAL_PI_PROVIDER_ALLOWLIST.has("mistral"));
	assert.ok(ORIGINAL_PI_PROVIDER_ALLOWLIST.has("xai"));
	assert.ok(ORIGINAL_PI_PROVIDER_ALLOWLIST.has("zai"));
	assert.ok(ORIGINAL_PI_PROVIDER_ALLOWLIST.has("xiaomi"));

	// Excluded proxies / aggregators / clouds / token plans
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("openrouter"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("vercel-ai-gateway"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("opencode"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("opencode-go"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("together"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("fireworks"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("cerebras"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("nvidia"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("baseten"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("amazon-bedrock"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("azure-openai-responses"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("cloudflare-ai-gateway"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("cloudflare-workers-ai"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("github-copilot"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("google-vertex"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("groq"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("huggingface"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("openai-codex"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("qwen-token-plan"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("xiaomi-token-plan-ams"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("xiaomi-token-plan-cn"));
	assert.ok(!ORIGINAL_PI_PROVIDER_ALLOWLIST.has("xiaomi-token-plan-sgp"));
});

test("parses Pi catalog only for allowlisted providers without copying routing fields", () => {
	const mockProviders = ["openai", "openrouter", "deepseek"];
	const mockModels: Record<string, unknown[]> = {
		openai: [
			{
				id: "gpt-4.1",
				name: "GPT-4.1",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				contextWindow: 128_000,
				maxTokens: 16_384,
				input: ["text", "image"],
				reasoning: true,
				cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
				compat: { supportsStore: true, baseUrl: "https://evil.com" },
			},
		],
		openrouter: [
			{
				id: "google/gemini-3.8-flash",
				contextWindow: 1_000_000,
			},
		],
		deepseek: [
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				reasoning: true,
				input: ["text"],
				thinkingLevelMap: { high: "high", max: "max" },
				compat: { requiresReasoningContentOnAssistantMessages: true },
			},
		],
	};

	const catalog = parsePiCatalogFromProviders(mockProviders, (p) => mockModels[p] ?? [], 12345);

	// openrouter was excluded
	assert.equal(catalog.models.has("google/gemini-3.8-flash"), false);

	// openai and deepseek were included
	assert.ok(catalog.models.has("gpt-4.1"));
	assert.ok(catalog.models.has("deepseek-v4-flash"));

	const gpt = catalog.models.get("gpt-4.1");
	assert.equal(gpt?.name, "GPT-4.1");
	assert.equal(gpt?.contextWindow, 128_000);
	assert.equal(gpt?.compat?.supportsStore, true);
	// baseUrl removed from compat
	assert.equal(gpt?.compat?.baseUrl, undefined);
});

test("stripProviderPrefix removes transport and aggregator prefixes", () => {
	assert.equal(stripProviderPrefix("google/gemini-3.8-flash"), "gemini-3.8-flash");
	assert.equal(stripProviderPrefix("openapi/gemini-3.8-flash"), "gemini-3.8-flash");
	assert.equal(stripProviderPrefix("deepseek/deepseek-v4-flash"), "deepseek-v4-flash");
	assert.equal(stripProviderPrefix("custom-provider/deepseek-v4-flash", "custom-provider"), "deepseek-v4-flash");
	assert.equal(stripProviderPrefix("gemini-3.8-flash"), "gemini-3.8-flash");
});

test("stripKnownModelSuffixes removes date, latest, and effort suffixes", () => {
	assert.equal(stripKnownModelSuffixes("deepseek-v4-flash-0731"), "deepseek-v4-flash");
	assert.equal(stripKnownModelSuffixes("kimi-k2-0711-preview"), "kimi-k2");
	assert.equal(stripKnownModelSuffixes("gpt-4.1-latest"), "gpt-4.1");
	assert.equal(stripKnownModelSuffixes("claude-sonnet-5-xhigh-effort"), "claude-sonnet-5");
	assert.equal(stripKnownModelSuffixes("claude-opus-4-5-20251101-thinking-64k-high-effort"), "claude-opus-4-5");
});

test("findPiCatalogModel matches exact ID, prefix normalized ID, and date suffix", async () => {
	const catalog = await loadPiCatalog();

	// Exact match
	const deepseek = findPiCatalogModel("deepseek-v4-flash", catalog);
	assert.ok(deepseek);
	assert.equal(deepseek?.matched.id, "deepseek-v4-flash");
	assert.equal(deepseek?.matchType, "exact");

	// Date suffix match
	const suffixedDeepseek = findPiCatalogModel("deepseek-v4-flash-0731", catalog);
	assert.ok(suffixedDeepseek);
	assert.equal(suffixedDeepseek?.matched.id, "deepseek-v4-flash");
	assert.equal(suffixedDeepseek?.matchType, "normalized");

	// Prefix stripped match
	const googleFlash = findPiCatalogModel("google/gemini-2.0-flash", catalog);
	assert.ok(googleFlash);
	assert.equal(googleFlash?.matched.id, "gemini-2.0-flash");
	assert.equal(googleFlash?.matchType, "normalized");
});

test("findPiCatalogModel rejects ambiguous conflict when multiple candidates match", () => {
	const mockCatalog = parsePiCatalogFromProviders(
		["google", "openai"],
		(provider) => {
			if (provider === "google") {
				return [{ id: "model-x-20260101" }];
			}
			return [{ id: "model-x-20260201" }];
		},
		Date.now(),
		new Set(["google", "openai"]),
	);

	// Both "model-x-20260101" and "model-x-20260201" strip to base "model-x" across different providers
	const result = findPiCatalogModel("model-x", mockCatalog);
	assert.equal(result, undefined);
});

test("mergeModelWithPiCatalog merges field by field: Provider > Pi catalog > default", () => {
	const mockCatalog = parsePiCatalogFromProviders(
		["deepseek"],
		() => [
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				input: ["text"],
				reasoning: true,
				cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
				thinkingLevelMap: { high: "high", max: "max" },
				compat: {
					requiresReasoningContentOnAssistantMessages: true,
					supportsStore: false,
				},
			},
		],
		Date.now(),
	);

	const draft: ProviderModelDraft = {
		id: "deepseek-v4-flash-0731",
		maxTokens: 64_000, // Provider explicitly overrides maxTokens
		cost: { input: 0.065, output: 0.18, cacheRead: 0.016, cacheWrite: 0 }, // Provider explicit cost
	};

	const result = mergeModelWithPiCatalog(draft, mockCatalog);

	assert.equal(result.draft.contextWindow, 1_000_000); // from Pi catalog
	assert.equal(result.fieldSources.contextWindow, "pi");

	assert.equal(result.draft.maxTokens, 64_000); // from Provider
	assert.equal(result.fieldSources.maxTokens, "provider");

	assert.equal(result.draft.reasoning, true); // from Pi catalog
	assert.equal(result.fieldSources.reasoning, "pi");

	assert.deepEqual(result.draft.input, ["text"]); // from Pi catalog
	assert.equal(result.fieldSources.input, "pi");

	assert.deepEqual(result.draft.thinkingLevelMap, { high: "high", max: "max" }); // from Pi catalog
	assert.equal(result.fieldSources.thinkingLevelMap, "pi");

	assert.equal((result.draft.compat as any)?.requiresReasoningContentOnAssistantMessages, true); // from Pi catalog
	assert.equal(result.fieldSources.cost, "provider");
});

test("mergeModelWithPiCatalog preserves explicit false, 0, and ['text']", () => {
	const mockCatalog = parsePiCatalogFromProviders(
		["google"],
		() => [
			{
				id: "gemini-flash",
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				input: ["text", "image"],
				reasoning: true,
				cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0 },
			},
		],
		Date.now(),
	);

	const draft: ProviderModelDraft = {
		id: "gemini-flash",
		reasoning: false, // explicit false
		input: ["text"], // explicit ['text'] - must NOT add image from catalog
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // explicit 0 price
	};

	const result = mergeModelWithPiCatalog(draft, mockCatalog);

	assert.equal(result.draft.reasoning, false);
	assert.equal(result.fieldSources.reasoning, "provider");

	assert.deepEqual(result.draft.input, ["text"]);
	assert.equal(result.fieldSources.input, "provider");

	assert.equal(result.draft.cost?.input, 0);
	assert.equal(result.fieldSources.cost, "provider");
});

test("mergeModelWithPiCatalog clears thinking levels when reasoning: false", () => {
	const mockCatalog = parsePiCatalogFromProviders(
		["deepseek"],
		() => [
			{
				id: "deepseek-v4-flash",
				reasoning: true,
				thinkingLevelMap: { high: "high", max: "max" },
			},
		],
		Date.now(),
	);

	const draft: ProviderModelDraft = {
		id: "deepseek-v4-flash",
		reasoning: false,
	};

	const result = mergeModelWithPiCatalog(draft, mockCatalog);
	assert.equal(result.draft.reasoning, false);
	assert.equal(result.draft.thinkingLevelMap, undefined);
});

test("mergeModelWithPiCatalog merges cost by SKU and tracks mixed sources", () => {
	const mockCatalog = parsePiCatalogFromProviders(
		["openai"],
		() => [
			{
				id: "gpt-4.1",
				cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1 },
			},
		],
		Date.now(),
	);

	// Provider supplies input and output, misses cacheRead and cacheWrite
	const draft: ProviderModelDraft = {
		id: "gpt-4.1",
		cost: { input: 1.5, output: 6, cacheRead: 0, cacheWrite: 0 } as any,
	};
	// Simulate missing SKUs on draft
	delete (draft.cost as any).cacheRead;
	delete (draft.cost as any).cacheWrite;

	const result = mergeModelWithPiCatalog(draft, mockCatalog);

	assert.equal(result.draft.cost?.input, 1.5); // provider
	assert.equal(result.draft.cost?.output, 6); // provider
	assert.equal(result.draft.cost?.cacheRead, 0.5); // pi
	assert.equal(result.draft.cost?.cacheWrite, 1); // pi

	assert.equal(result.fieldSources.cost, "mixed");
	assert.equal(result.fieldSources.costBySku?.input, "provider");
	assert.equal(result.fieldSources.costBySku?.output, "provider");
	assert.equal(result.fieldSources.costBySku?.cacheRead, "pi");
	assert.equal(result.fieldSources.costBySku?.cacheWrite, "pi");
});

test("mergeModelWithPiCatalog respects useFallback: false", () => {
	const mockCatalog = parsePiCatalogFromProviders(
		["deepseek"],
		() => [
			{
				id: "deepseek-v4-flash",
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				reasoning: true,
			},
		],
		Date.now(),
	);

	const draft: ProviderModelDraft = {
		id: "deepseek-v4-flash",
	};

	const result = mergeModelWithPiCatalog(draft, mockCatalog, { useFallback: false });

	assert.equal(result.draft.contextWindow, undefined);
	assert.equal(result.draft.maxTokens, undefined);
	assert.equal(result.draft.reasoning, undefined);
	assert.equal(result.fieldSources.contextWindow, "default");
	assert.equal(result.matchType, "none");
});

test("dynamic provider draft with date-suffixed model resolves correct Pi catalog capabilities", () => {
	const mockCatalog = parsePiCatalogFromProviders(
		["deepseek"],
		() => [
			{
				id: "deepseek-v4-flash",
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
				thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
				compat: { supportsThinkingControl: true },
			},
		],
		Date.now(),
	);

	// Raw dynamic provider draft from /models only has id and endpoint metadata
	const draft: ProviderModelDraft = {
		id: "deepseek-v4-flash-0731",
		api: "openai-completions",
		baseUrl: "https://api.example.com/v1",
	};

	const result = mergeModelWithPiCatalog(draft, mockCatalog, { currentProviderId: "custom-provider" });
	assert.equal(result.matchType, "normalized");
	assert.equal(result.draft.contextWindow, 1_000_000);
	assert.equal(result.draft.maxTokens, 384_000);
	assert.equal(result.draft.reasoning, true);
	assert.deepEqual(result.draft.thinkingLevelMap, { off: null, low: "low", high: "high", max: "max" });
	assert.equal(result.draft.cost?.input, 0.14);
	assert.equal(result.fieldSources.contextWindow, "pi");
	assert.equal(result.fieldSources.maxTokens, "pi");
	assert.equal(result.fieldSources.reasoning, "pi");
	assert.equal(result.fieldSources.thinkingLevelMap, "pi");
	assert.equal(result.fieldSources.cost, "pi");
});

test("isLegacyNormalizedModel and isLegacyNormalizedSnapshot detect legacy cache", () => {
	const oldNormalizedStored = {
		id: "deepseek-v4-flash-0731",
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		input: ["text"],
		provider: "custom-provider",
	};

	assert.equal(isLegacyNormalizedModel(oldNormalizedStored), true);
	assert.equal(isLegacyNormalizedSnapshot([oldNormalizedStored]), true);

	const rawDraft = {
		id: "deepseek-v4-flash-0731",
		api: "openai-completions",
	};
	assert.equal(isLegacyNormalizedModel(rawDraft), false);
	assert.equal(isLegacyNormalizedSnapshot([rawDraft]), false);

	const mockCatalog = parsePiCatalogFromProviders(
		["deepseek"],
		() => [
			{
				id: "deepseek-v4-flash",
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				reasoning: true,
			},
		],
		Date.now(),
	);

	const merged = mergeModelWithPiCatalog(rawDraft, mockCatalog, { currentProviderId: "custom-provider" });
	assert.equal(merged.draft.contextWindow, 1_000_000);
	assert.equal(merged.draft.maxTokens, 384_000);
	assert.equal(merged.draft.reasoning, true);
	assert.equal(merged.fieldSources.contextWindow, "pi");
});

test("loadPiCatalog accepts the catalog from Pi's active extension module graph", async () => {
	const snapshot = await loadPiCatalog({
		allowlist: new Set(["openai", "zai"]),
		builtinCatalog: {
			getBuiltinProviders: () => ["openai", "zai", "openrouter"],
			getBuiltinModels: (provider) => {
				if (provider === "openai") {
					return [
						{
							id: "gpt-6-astra",
							provider,
							contextWindow: 272_000,
							maxTokens: 128_000,
							reasoning: true,
							input: ["text", "image"],
						},
					];
				}
				if (provider === "zai") {
					return [
						{
							id: "glm-5.3",
							provider,
							contextWindow: 1_000_000,
							maxTokens: 131_072,
							reasoning: true,
							input: ["text"],
						},
					];
				}
				return [{ id: "openai/gpt-6-astra", provider, contextWindow: 1_000_000 }];
			},
			getBuiltinModelDataGeneratedAt: () => 123,
		},
	});

	assert.equal(snapshot.generatedAt, 123);
	assert.equal(findPiCatalogModel("gpt-6-astra", snapshot, "openapi")?.matched.contextWindow, 272_000);
	assert.equal(findPiCatalogModel("glm-5.3", snapshot, "maas")?.matched.maxTokens, 131_072);
	assert.equal(snapshot.models.has("openai/gpt-6-astra"), false);
});

test("loadPiCatalog prefers the active registry and ignores proxy-provider models", async () => {
	const snapshot = await loadPiCatalog({
		modelRegistry: {
			getAll: () => [
				{
					id: "gpt-6-astra",
					provider: "openai",
					contextWindow: 272_000,
					maxTokens: 128_000,
					reasoning: true,
					input: ["text", "image"],
				},
				{
					id: "glm-5.3",
					provider: "zai",
					contextWindow: 1_000_000,
					maxTokens: 131_072,
					reasoning: true,
				},
				{
					id: "gpt-6-astra",
					provider: "openapi",
					contextWindow: 128_000,
					maxTokens: 16_384,
					reasoning: false,
				},
			],
		},
		builtinCatalog: {
			getBuiltinProviders: () => ["openai"],
			getBuiltinModels: () => [{ id: "gpt-6-astra", contextWindow: 1 }],
		},
	});

	assert.equal(findPiCatalogModel("gpt-6-astra", snapshot, "openapi")?.matched.contextWindow, 272_000);
	assert.equal(findPiCatalogModel("glm-5.3", snapshot, "maas")?.matched.contextWindow, 1_000_000);
	assert.equal(snapshot.models.has("gpt-6-astra"), true);
});

test("loadPiCatalog caches per allowlist and does not ignore allowlist on subsequent calls", async () => {
	// First call requesting only openai
	const openaiCatalog = await loadPiCatalog({ allowlist: new Set(["openai"]) });
	assert.ok(openaiCatalog.byProvider.has("openai"));
	assert.ok(!openaiCatalog.byProvider.has("deepseek"));
	assert.ok(openaiCatalog.models.has("gpt-4o") || openaiCatalog.models.has("gpt-4.1"));

	// Second call requesting only deepseek
	const deepseekCatalog = await loadPiCatalog({ allowlist: new Set(["deepseek"]) });
	assert.ok(deepseekCatalog.byProvider.has("deepseek"));
	assert.ok(!deepseekCatalog.byProvider.has("openai"));
	assert.ok(!deepseekCatalog.models.has("gpt-4o"));

	// Third call with default allowlist
	const defaultCatalog = await loadPiCatalog();
	assert.ok(defaultCatalog.byProvider.has("openai"));
	assert.ok(defaultCatalog.byProvider.has("deepseek"));
});

test("Xiaomi paid models are not overwritten by Token Plan zero prices", async () => {
	const catalog = await loadPiCatalog();
	const mimo = catalog.models.get("mimo-v2.5");
	assert.ok(mimo, "mimo-v2.5 should exist in global models");
	assert.equal(mimo.provider, "xiaomi");
	assert.ok(mimo.cost, "mimo-v2.5 should have cost");
	assert.equal(mimo.cost.input, 0.14);
	assert.equal(mimo.cost.output, 0.28);

	// Also verify that even if token plan providers are parsed together, paid pricing is preserved
	const mixedCatalog = parsePiCatalogFromProviders(
		["xiaomi", "xiaomi-token-plan-sgp"],
		(p) => {
			if (p === "xiaomi") {
				return [
					{
						id: "mimo-v2.5",
						cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
						contextWindow: 1048576,
						maxTokens: 131072,
					},
				];
			}
			return [
				{
					id: "mimo-v2.5",
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1048576,
					maxTokens: 131072,
				},
			];
		},
		Date.now(),
		new Set(["xiaomi", "xiaomi-token-plan-sgp"]),
	);
	const mixedMimo = mixedCatalog.models.get("mimo-v2.5");
	// Should not be overwritten with 0/0
	if (mixedMimo?.cost) {
		assert.notEqual(mixedMimo.cost.input, 0);
		assert.equal(mixedMimo.cost.input, 0.14);
	}
});
