import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyOfficialModelCosts,
	clearPricingCache,
	fetchOfficialPricing,
	findOfficialCost,
	findOfficialMeta,
	getDefaultOpenRouterMetadataCachePath,
	getPricingCache,
	parseOpenRouterModels,
	parseOpenRouterPricing,
} from "../core/official-pricing.ts";
import type { ProviderModelDraft } from "../core/types.ts";

test("stores provider metadata under Pi's resolved agent directory", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "~/configured-pi-agent";
	try {
		assert.equal(
			getDefaultOpenRouterMetadataCachePath(),
			join(homedir(), "configured-pi-agent", "pi-provider", "openrouter-model-metadata.json"),
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("parseOpenRouterPricing correctly maps prompt/completion prices and tiers overrides", () => {
	const samplePayload = {
		data: [
			{
				id: "openai/model-alpha",
				pricing: {
					prompt: "0.000005",
					completion: "0.00003",
					input_cache_read: "0.0000005",
					input_cache_write: "0.00000625",
					overrides: [
						{
							min_prompt_tokens: 272000,
							prompt: "0.00001",
							completion: "0.000045",
							input_cache_read: "0.000001",
							input_cache_write: "0.0000125",
						},
					],
				},
			},
			{
				id: "anthropic/model-delta",
				pricing: {
					prompt: "0.000003",
					completion: "0.000015",
				},
			},
		],
	};

	const parsed = parseOpenRouterPricing(samplePayload);

	assert.deepEqual(parsed["model-alpha"], {
		input: 5,
		output: 30,
		cacheRead: 0.5,
		cacheWrite: 6.25,
		tiers: [
			{
				inputTokensAbove: 272000,
				input: 10,
				output: 45,
				cacheRead: 1,
				cacheWrite: 12.5,
			},
		],
	});
	assert.deepEqual(parsed["anthropic/model-delta"], {
		input: 3,
		output: 15,
		cacheRead: 0,
		cacheWrite: 0,
	});
});

test("does not treat Design Arena metadata as the selected quality source", () => {
	const parsed = parseOpenRouterModels({
		data: [
			{
				id: "openai/model-alpha",
				pricing: { prompt: "0.000005", completion: "0.00003" },
				benchmarks: {
					design_arena: [{ arena: "models", category: "general", elo: 1250, win_rate: 0.61, rank: 8 }],
				},
			},
		],
	});

	assert.equal(parsed["openai/model-alpha"]?.quality, undefined);
});

test("parses Artificial Analysis indices exposed by OpenRouter", () => {
	const parsed = parseOpenRouterModels({
		data: [
			{
				id: "openai/quality-model",
				benchmarks: {
					artificial_analysis: {
						intelligence_index: 51.2,
						coding_index: 71.4,
						agentic_index: 45.6,
					},
				},
			},
		],
	});

	assert.deepEqual(parsed["openai/quality-model"]?.quality, [
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
	]);
});

test("retains quality metadata when a model has no pricing object", () => {
	const parsed = parseOpenRouterModels({
		data: [
			{
				id: "openai/quality-only",
				benchmarks: {
					artificial_analysis: { intelligence_index: 48.5 },
				},
			},
		],
	});

	assert.deepEqual(parsed["openai/quality-only"]?.quality, [
		{
			source: "artificial-analysis",
			benchmark: "Artificial Analysis",
			category: "intelligence",
			metric: "score",
			value: 48.5,
		},
	]);
});

test("marks malformed OpenRouter prices as unknown instead of treating them as free", () => {
	const payload = {
		data: [{ id: "openai/malformed-price", pricing: { prompt: "not-a-number", completion: null } }],
	};
	const parsed = parseOpenRouterModels(payload);

	assert.equal(parsed["openai/malformed-price"]?.costKnown, false);
	assert.equal(findOfficialCost("openai/malformed-price", parsed), undefined);
	assert.equal(parseOpenRouterPricing(payload)["openai/malformed-price"], undefined);
});

test("resolves an unversioned model to the latest OpenRouter version without using an older score", () => {
	const parsed = parseOpenRouterModels({
		data: [
			{
				id: "deepseek/deepseek-v4-flash",
				canonical_slug: "deepseek/deepseek-v4-flash-20260423",
				created: 1_777_000_000,
				pricing: { prompt: "0.00000014", completion: "0.00000028" },
				context_length: 1_048_576,
				top_provider: { max_completion_tokens: 393_216 },
				benchmarks: { artificial_analysis: { intelligence_index: 40 } },
			},
			{
				id: "deepseek/deepseek-v4-flash-0731",
				canonical_slug: "deepseek/deepseek-v4-flash-20260731",
				created: 1_785_000_000,
				pricing: { prompt: "0.00000009", completion: "0.00000018" },
				context_length: 1_048_576,
				top_provider: { max_completion_tokens: 65_536 },
			},
			{
				id: "~deepseek/deepseek-v4-flash-latest",
				alias_target: { slug: "deepseek/deepseek-v4-flash-0731" },
				created: 1_785_000_001,
				pricing: { prompt: "0.00000009", completion: "0.00000018" },
			},
		],
	});

	const latest = findOfficialMeta("deepseek-v4-flash", parsed);
	assert.equal(latest?.maxTokens, 65_536);
	assert.equal(latest?.quality, undefined);
	assert.equal(findOfficialMeta("deepseek/deepseek-v4-flash-0731", parsed)?.quality, undefined);
	assert.equal(findOfficialMeta("deepseek/deepseek-v4-flash-20260731", parsed)?.maxTokens, 65_536);
});

test("does not fall back to an older score when the latest version only has identity metadata", () => {
	const parsed = parseOpenRouterModels({
		data: [
			{
				id: "deepseek/deepseek-v4-flash-20260731",
				created: 1_785_000_000,
				pricing: { prompt: "0.00000009", completion: "0.00000018" },
				benchmarks: { artificial_analysis: { intelligence_index: 40 } },
			},
			{
				id: "deepseek/deepseek-v4-flash-20260801",
				canonical_slug: "deepseek/deepseek-v4-flash-20260801",
				created: 1_785_100_000,
				context_length: 2_000_000,
				top_provider: { max_completion_tokens: 131_072 },
			},
		],
	});

	assert.ok(parsed["deepseek/deepseek-v4-flash-20260801"]);
	const latest = findOfficialMeta("deepseek-v4-flash", parsed);
	assert.equal(latest?.maxTokens, 131_072);
	assert.equal(latest?.quality, undefined);
});

test("takes the highest reported score for each category within the latest model version", () => {
	const parsed = parseOpenRouterModels({
		data: [
			{
				id: "openai/model-alpha-high",
				canonical_slug: "openai/model-alpha-20260801",
				created: 1_785_000_000,
				pricing: { prompt: "0.000001", completion: "0.000002" },
				benchmarks: {
					artificial_analysis: { intelligence_index: 51, coding_index: 68 },
				},
			},
			{
				id: "openai/model-alpha-max",
				canonical_slug: "openai/model-alpha-20260801",
				created: 1_785_000_001,
				pricing: { prompt: "0.000001", completion: "0.000002" },
				benchmarks: {
					artificial_analysis: { intelligence_index: 55, agentic_index: 45 },
				},
			},
		],
	});

	assert.deepEqual(findOfficialMeta("model-alpha", parsed)?.quality, [
		{
			source: "artificial-analysis",
			benchmark: "Artificial Analysis",
			category: "intelligence",
			metric: "score",
			value: 55,
		},
		{
			source: "artificial-analysis",
			benchmark: "Artificial Analysis",
			category: "coding",
			metric: "score",
			value: 68,
		},
		{
			source: "artificial-analysis",
			benchmark: "Artificial Analysis",
			category: "agentic",
			metric: "score",
			value: 45,
		},
	]);
});

test("retains explicitly free models in the official catalog", () => {
	const parsed = parseOpenRouterPricing({ data: [{ id: "free/model", pricing: { prompt: 0, completion: 0 } }] });
	assert.deepEqual(parsed["free/model"], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(parsed.model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("maps OpenRouter reasoning efforts to Pi thinking levels", () => {
	const parsed = parseOpenRouterModels({
		data: [
			{
				id: "openai/reasoning-model",
				pricing: { prompt: 0.000001, completion: 0.000002 },
				reasoning: { supported_efforts: ["high", "low", "minimal"] },
				supported_parameters: ["reasoning_effort"],
			},
		],
	});

	assert.deepEqual(parsed["openai/reasoning-model"].thinkingLevelMap, {
		off: null,
		minimal: "minimal",
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	});
});

test("does not create an ambiguous unprefixed alias for same-named provider models", () => {
	const payload = (ids: string[]) => ({
		data: ids.map((id, index) => ({
			id,
			pricing: { prompt: String(index + 1), completion: String((index + 1) * 2) },
		})),
	});
	const firstOrder = parseOpenRouterModels(payload(["openai/shared", "anthropic/shared"]));
	const secondOrder = parseOpenRouterModels(payload(["anthropic/shared", "openai/shared"]));

	assert.equal(firstOrder.shared, undefined);
	assert.equal(secondOrder.shared, undefined);
	assert.equal(findOfficialCost("shared", firstOrder), undefined);
	assert.deepEqual(findOfficialCost("openai/shared", firstOrder), {
		input: 1_000_000,
		output: 2_000_000,
		cacheRead: 0,
		cacheWrite: 0,
	});
	assert.deepEqual(findOfficialCost("anthropic/shared", firstOrder), {
		input: 2_000_000,
		output: 4_000_000,
		cacheRead: 0,
		cacheWrite: 0,
	});
});

test("findOfficialCost matches exact model IDs but not partial prefixes", () => {
	const dynamicPricing = {
		"openai/model-alpha": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	};

	assert.deepEqual(findOfficialCost("openai/model-alpha", dynamicPricing), {
		input: 5,
		output: 30,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	});

	assert.deepEqual(findOfficialCost("model-alpha", dynamicPricing), {
		input: 5,
		output: 30,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	});
	assert.equal(findOfficialCost("model", dynamicPricing), undefined);
});

test("applyOfficialModelCosts fills missing cost from dynamic pricing without overwriting existing cost", () => {
	const dynamicPricing = {
		"model-alpha": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	};

	const models: ProviderModelDraft[] = [
		{
			id: "model-alpha",
			name: "Model Alpha",
			reasoning: true,
			input: ["text"],
			contextWindow: 272_000,
			maxTokens: 128_000,
		},
		{
			id: "model-delta",
			name: "Model Delta",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
		},
	];

	const processed = applyOfficialModelCosts(models, dynamicPricing);

	assert.deepEqual(processed[0].cost, dynamicPricing["model-alpha"]);
	assert.deepEqual(processed[1].cost, { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 });

	const explicitFree = applyOfficialModelCosts(
		[{ id: "model-alpha", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		dynamicPricing,
	);
	assert.deepEqual(explicitFree[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("keeps a provider fallback cost instead of replacing it with a generic reference", () => {
	const processed = applyOfficialModelCosts(
		[
			{
				id: "model-alpha",
				cost: { input: 9, output: 18, cacheRead: 0.9, cacheWrite: 2 },
				pricingSource: "fallback",
			},
		],
		{
			"model-alpha": {
				cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 128_000,
			},
		},
	);

	assert.deepEqual(processed[0]?.cost, { input: 9, output: 18, cacheRead: 0.9, cacheWrite: 2 });
	assert.equal(processed[0]?.pricingSource, "fallback");
	assert.equal(processed[0]?.contextWindow, 128_000);
});

test("fills missing reasoning metadata from the official catalog", () => {
	const processed = applyOfficialModelCosts([{ id: "reasoning-model", compat: { supportsStore: false } }], {
		"openai/reasoning-model": {
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			},
			compat: { supportsReasoningEffort: true },
		},
	});

	assert.equal(processed[0].reasoning, true);
	assert.deepEqual(processed[0].thinkingLevelMap, {
		off: null,
		minimal: "minimal",
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	});
	assert.deepEqual(processed[0].compat, {
		supportsStore: false,
		supportsReasoningEffort: true,
	});
});

test("returns from official pricing after a deadline when fetch ignores cancellation", async () => {
	clearPricingCache();
	const pricingUrl = "https://deadline.example/pricing.json";
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			fetchOfficialPricing(
				(async () => await new Promise<Response>(() => {})) as typeof globalThis.fetch,
				pricingUrl,
				5,
			),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("official pricing did not meet its deadline")), 100);
			}),
		]);
		assert.deepEqual(result, {});
	} finally {
		if (timer) clearTimeout(timer);
		clearPricingCache(pricingUrl);
	}
});

test("fetchOfficialPricing caches successful responses and falls back to last cached snapshot on failure", async () => {
	clearPricingCache();

	const mockSuccessFetch = async () =>
		new Response(
			JSON.stringify({
				data: [
					{
						id: "model-alpha",
						pricing: { prompt: "0.000005", completion: "0.00003" },
					},
				],
			}),
			{ status: 200 },
		);

	const fetched = await fetchOfficialPricing(mockSuccessFetch as any, "https://example.com/pricing.json", 1000);
	assert.deepEqual(fetched["model-alpha"].cost, { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(getPricingCache("https://example.com/pricing.json"), fetched);

	const mockFailedFetch = async () => new Response("network error", { status: 500 });
	const fallback = await fetchOfficialPricing(mockFailedFetch as any, "https://example.com/pricing.json", 1000);

	assert.deepEqual(fallback, fetched);
});

test("persists OpenRouter metadata and restores the snapshot across process cache resets", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-pricing-cache-"));
	const cachePath = join(root, "openrouter-model-metadata.json");
	const pricingUrl = "https://persistent.example/models";
	const now = 1_700_000_000_000;
	let requests = 0;
	const successFetch = async () => {
		requests++;
		return new Response(
			JSON.stringify({
				data: [{ id: "persistent/model", pricing: { prompt: "0.000001", completion: "0.000002" } }],
			}),
			{ status: 200 },
		);
	};

	try {
		clearPricingCache(pricingUrl);
		const first = await fetchOfficialPricing(successFetch, pricingUrl, 1_000, 60_000, 60 * 60 * 1_000, () => now, {
			cachePath,
		});
		const persisted = JSON.parse(await readFile(cachePath, "utf8")) as {
			version: number;
			sourceUrl: string;
		};
		assert.equal(persisted.version, 3);
		assert.equal(persisted.sourceUrl, pricingUrl);

		clearPricingCache(pricingUrl);
		const restored = await fetchOfficialPricing(
			async () => {
				requests++;
				throw new Error("network should not be used for a fresh persisted cache");
			},
			pricingUrl,
			1_000,
			60_000,
			60 * 60 * 1_000,
			() => now,
			{ cachePath },
		);
		assert.deepEqual(restored, first);
		assert.equal(requests, 1);

		clearPricingCache(pricingUrl);
		const staleFallback = await fetchOfficialPricing(
			async () => {
				requests++;
				return new Response("unavailable", { status: 503 });
			},
			pricingUrl,
			1_000,
			0,
			60 * 60 * 1_000,
			() => now + 1,
			{ cachePath },
		);
		assert.deepEqual(staleFallback, first);
		assert.equal(requests, 2);
	} finally {
		clearPricingCache(pricingUrl);
		await rm(root, { recursive: true, force: true });
	}
});

test("background pricing refresh returns the current snapshot before network completion", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-pricing-background-"));
	const cachePath = join(root, "openrouter-model-metadata.json");
	const pricingUrl = "https://background.example/models";
	const now = 1_700_000_000_000;
	let requests = 0;
	let release: (() => void) | undefined;
	let started: () => void = () => undefined;
	const fetchStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const fetchFn = async () => {
		requests++;
		started();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return new Response(
			JSON.stringify({
				data: [{ id: "background/model", pricing: { prompt: "0.000001", completion: "0.000002" } }],
			}),
			{ status: 200 },
		);
	};

	try {
		clearPricingCache(pricingUrl);
		const initial = await fetchOfficialPricing(fetchFn, pricingUrl, 1_000, 0, 60 * 60 * 1_000, () => now, {
			cachePath,
			background: true,
		});
		assert.deepEqual(initial, {});
		await fetchStarted;
		assert.equal(requests, 1);

		const completed = fetchOfficialPricing(fetchFn, pricingUrl, 1_000, 0, 60 * 60 * 1_000, () => now, {
			cachePath,
		});
		release?.();
		const refreshed = await completed;
		assert.deepEqual(refreshed["background/model"].cost, {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
		});
		assert.equal(requests, 1);
	} finally {
		clearPricingCache(pricingUrl);
		await rm(root, { recursive: true, force: true });
	}
});

test("does not reuse pricing from a different URL", async () => {
	clearPricingCache();
	await fetchOfficialPricing(
		async () =>
			new Response(
				JSON.stringify({ data: [{ id: "provider-a/model", pricing: { prompt: "1", completion: "2" } }] }),
				{
					status: 200,
				},
			),
		"https://provider-a.example/pricing.json",
		1000,
	);

	const fallback = await fetchOfficialPricing(
		async () => new Response("unavailable", { status: 503 }),
		"https://provider-b.example/pricing.json",
		1000,
	);

	assert.deepEqual(fallback, {});
});

test("coalesces concurrent official pricing requests for the same URL", async () => {
	clearPricingCache();
	let requests = 0;
	let release: (() => void) | undefined;
	const fetchFn = async () => {
		requests++;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return new Response(
			JSON.stringify({ data: [{ id: "coalesced/model", pricing: { prompt: "1", completion: "2" } }] }),
			{
				status: 200,
			},
		);
	};
	const first = fetchOfficialPricing(fetchFn, "https://coalesced.example/pricing.json", 1_000);
	const second = fetchOfficialPricing(fetchFn, "https://coalesced.example/pricing.json", 1_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests, 1);
	release?.();
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.deepEqual(firstResult, secondResult);
	clearPricingCache();
});
