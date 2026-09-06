import assert from "node:assert/strict";
import test from "node:test";
import { ProviderDataError } from "../core/errors.ts";
import type { ProviderRefreshContext } from "../core/types.ts";
import {
	createMaaSPreflightAdapter,
	MAAS_MODELS_URL as MAAS_PREFLIGHT_MODELS_URL,
	parseMaaSModelIds,
} from "../examples/maas/preflight/maas.ts";
import { createMaaSAdapter, MAAS_BASE_URL, MAAS_MODELS_URL, parseMaaSModels } from "../examples/maas/providers/maas.ts";

function refreshContext(overrides: Partial<ProviderRefreshContext> = {}): ProviderRefreshContext {
	return {
		allowNetwork: false,
		signal: new AbortController().signal,
		publish: async ({ update }) => {
			update?.();
			return true;
		},
		...overrides,
	};
}

test("parses a bounded MaaS catalog into raw model drafts", () => {
	assert.deepEqual(
		parseMaaSModels({
			data: [
				{ id: " glm-5.3 ", name: " GLM 5.3 " },
				{ id: "GLM-5.3", name: "duplicate" },
				{ id: "deepseek-v4-flash-0731", name: "deepseek-v4-flash-0731" },
				{ id: "" },
				{ id: "unsafe\u0000id" },
			],
		}),
		[
			{ id: "glm-5.3", name: "GLM 5.3", api: "openai-completions", baseUrl: MAAS_BASE_URL },
			{ id: "deepseek-v4-flash-0731", api: "openai-completions", baseUrl: MAAS_BASE_URL },
		],
	);
	assert.deepEqual(parseMaaSModels({ data: "invalid" }), []);
});

test("discovers MaaS models with the effective API key and persists only raw drafts", async () => {
	let persisted: ProviderRefreshContext["stored"];
	let requestSignal: AbortSignal | null | undefined;
	const adapter = createMaaSAdapter(
		async (input, init) => {
			assert.equal(String(input), MAAS_MODELS_URL);
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer maas-test-key");
			assert.equal(headers.get("accept-encoding"), "identity");
			assert.equal(headers.get("user-agent"), "@hyav/pi-provider");
			requestSignal = init?.signal;
			return new Response(
				JSON.stringify({
					data: [{ id: "glm-5.3", name: "GLM 5.3" }, { id: "GLM-5.3", name: "duplicate" }, { name: "missing id" }],
				}),
				{ status: 200 },
			);
		},
		100,
		() => 2_000,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);
	assert.equal(adapter.id, "maas");
	assert.equal(adapter.provider.apiKey, "$MAAS_API_KEY");
	assert.equal(adapter.provider.authHeader, true);
	assert.equal(adapter.catalog?.source, "empty");

	const models = await refreshModels(
		refreshContext({
			allowNetwork: true,
			force: true,
			credential: { type: "api_key", key: " maas-test-key " },
			publish: async ({ persist, update }) => {
				persisted = persist ?? undefined;
				update?.();
				return true;
			},
		}),
	);

	assert.equal(requestSignal instanceof AbortSignal, true);
	assert.deepEqual(models, [{ id: "glm-5.3", name: "GLM 5.3", api: "openai-completions", baseUrl: MAAS_BASE_URL }]);
	assert.ok(persisted);
	assert.equal(persisted.checkedAt, 2_000);
	assert.deepEqual(persisted.models, [
		{
			id: "glm-5.3",
			name: "GLM 5.3",
			api: "openai-completions",
			provider: "maas",
			baseUrl: MAAS_BASE_URL,
		},
	]);
	assert.equal("contextWindow" in persisted.models[0]!, false);
	assert.equal("cost" in persisted.models[0]!, false);
	assert.equal(adapter.catalog?.rejectedCount, 1);
	assert.equal(adapter.catalog?.duplicateCount, 1);
});

test("restores validated MaaS raw drafts and rejects legacy normalized snapshots", async () => {
	const rawAdapter = createMaaSAdapter(
		async () => new Response("unused"),
		100,
		() => 2_000,
	);
	const rawRefresh = rawAdapter.provider.refreshModels;
	assert.ok(rawRefresh);
	const restored = await rawRefresh(
		refreshContext({
			stored: {
				checkedAt: 1_000,
				models: [
					{
						id: "glm-5.3",
						name: "GLM 5.3",
						provider: "maas",
						baseUrl: MAAS_BASE_URL,
						api: "openai-completions",
						contextWindow: 42,
					} as any,
				],
			},
		}),
	);
	assert.deepEqual(restored, [{ id: "glm-5.3", name: "GLM 5.3", api: "openai-completions", baseUrl: MAAS_BASE_URL }]);
	assert.equal(rawAdapter.catalog?.source, "cached");

	const legacyAdapter = createMaaSAdapter(async () => new Response("unused"), 100);
	const legacyRefresh = legacyAdapter.provider.refreshModels;
	assert.ok(legacyRefresh);
	const legacy = await legacyRefresh(
		refreshContext({
			stored: {
				checkedAt: 1_000,
				models: [
					{
						id: "legacy-model",
						name: "legacy-model",
						provider: "maas",
						baseUrl: MAAS_BASE_URL,
						api: "openai-completions",
						contextWindow: 128_000,
						maxTokens: 16_384,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						reasoning: false,
						input: ["text"],
					},
				],
			},
		}),
	);
	assert.deepEqual(legacy, []);
	assert.equal(legacyAdapter.catalog?.source, "empty");
});

test("classifies MaaS discovery authentication and Retry-After failures", async () => {
	let requests = 0;
	const missingAuthAdapter = createMaaSAdapter(async () => {
		requests++;
		return new Response("unexpected");
	}, 100);
	const missingAuthRefresh = missingAuthAdapter.provider.refreshModels;
	assert.ok(missingAuthRefresh);
	await assert.rejects(
		missingAuthRefresh(
			refreshContext({
				allowNetwork: true,
				credential: { type: "api_key", key: "proxy-managed" },
			}),
		),
		(error: unknown) => error instanceof ProviderDataError && error.code === "auth",
	);
	assert.equal(requests, 0);
	assert.equal(missingAuthAdapter.catalog?.lastError, "auth");

	const now = 1_700_000_000_000;
	const rateLimitedAdapter = createMaaSAdapter(
		async () => new Response("busy", { status: 429, headers: { "retry-after": "12" } }),
		100,
		() => now,
	);
	const rateLimitedRefresh = rateLimitedAdapter.provider.refreshModels;
	assert.ok(rateLimitedRefresh);
	await assert.rejects(
		rateLimitedRefresh(
			refreshContext({
				allowNetwork: true,
				credential: { type: "api_key", key: "maas-test-key" },
			}),
		),
		(error: unknown) =>
			error instanceof ProviderDataError &&
			error.code === "http429" &&
			error.retryAt === now + 12_000 &&
			error.httpStatus === 429,
	);
});

test("bounds MaaS model discovery with a deadline", async () => {
	let aborted = false;
	const adapter = createMaaSAdapter(
		async (_input, init) =>
			await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			}),
		5,
	);
	const refreshModels = adapter.provider.refreshModels;
	assert.ok(refreshModels);
	await assert.rejects(
		refreshModels(
			refreshContext({
				allowNetwork: true,
				credential: { type: "api_key", key: "maas-test-key" },
			}),
		),
		{ name: "TimeoutError" },
	);
	assert.equal(aborted, true);
	assert.equal(adapter.catalog?.lastError, "timeout");
});

test("MaaS Preflight authenticates and matches model IDs case-insensitively", async () => {
	const adapter = createMaaSPreflightAdapter(321);
	const controller = new AbortController();
	const snapshot = await adapter.fetch({
		fetch: async (input, init) => {
			assert.equal(String(input), MAAS_PREFLIGHT_MODELS_URL);
			assert.equal(init?.signal, controller.signal);
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer maas-test-key");
			assert.equal(headers.get("accept-encoding"), "identity");
			return new Response(JSON.stringify({ data: [{ id: "glm-5.3" }] }), { status: 200 });
		},
		getApiKey: async () => "maas-test-key",
		now: () => 5_000,
		signal: controller.signal,
		model: { provider: "maas", id: "GLM-5.3", baseUrl: MAAS_BASE_URL } as any,
	});

	assert.equal(adapter.requestTimeoutMs, 321);
	assert.deepEqual(snapshot, {
		passed: true,
		checks: ["endpoint", "auth", "catalog"],
		updatedAt: 5_000,
		httpStatus: 200,
	});
	assert.deepEqual([...parseMaaSModelIds({ data: [{ id: " GLM-5.3 " }, { id: "" }] })], ["glm-5.3"]);
	assert.equal(adapter.supportsModel?.({ baseUrl: MAAS_BASE_URL } as any), true);
	assert.equal(adapter.supportsModel?.({ baseUrl: "https://proxy.example.test/v1" } as any), false);
});

test("MaaS Preflight fails closed without a credential and preserves HTTP errors", async () => {
	const adapter = createMaaSPreflightAdapter(1_000);
	let requests = 0;
	const missing = await adapter.fetch({
		fetch: async () => {
			requests++;
			return new Response("unexpected");
		},
		getApiKey: async () => undefined,
		now: () => 6_000,
		model: { provider: "maas", id: "glm-5.3" } as any,
	});
	assert.deepEqual(missing, { passed: false, checks: ["auth"], updatedAt: 6_000 });
	assert.equal(requests, 0);

	await assert.rejects(
		adapter.fetch({
			fetch: async () => new Response("unauthorized", { status: 401 }),
			getApiKey: async () => "wrong-key",
			now: () => 7_000,
			model: { provider: "maas", id: "glm-5.3" } as any,
		}),
		(error: unknown) => error instanceof ProviderDataError && error.code === "auth" && error.httpStatus === 401,
	);
});
