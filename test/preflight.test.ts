import assert from "node:assert/strict";
import test from "node:test";
import { createCharmHyperPreflightAdapter } from "../preflight/charm-hyper.ts";
import { createDeepSeekPreflightAdapter } from "../preflight/deepseek.ts";
import { createGooglePreflightAdapter } from "../preflight/google.ts";
import { createOpenAICodexPreflightAdapter } from "../preflight/openai-codex.ts";
import { createOpenCodePreflightAdapter } from "../preflight/opencode.ts";
import { createOpenCodeGoPreflightAdapter } from "../preflight/opencode-go.ts";
import { HYPER_USER_AGENT } from "../providers/charm-hyper/constants.ts";

test("Charm Hyper preflight checks the current catalog and falls back to the legacy endpoint", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const adapter = createCharmHyperPreflightAdapter(1_000);

	const snapshot = await adapter.fetch({
		fetch: async (input, init) => {
			requests.push({ url: String(input), init });
			if (requests.length === 1) return new Response("not found", { status: 404 });
			return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }), { status: 200 });
		},
		getApiKey: async () => "hyper-test-key",
		now: () => 500,
		model: { provider: "charm-hyper", id: "deepseek-v4-pro" } as any,
	});

	assert.deepEqual(snapshot, {
		passed: true,
		checks: ["endpoint", "auth", "catalog"],
		updatedAt: 500,
		httpStatus: 200,
	});
	assert.deepEqual(
		requests.map(({ url }) => url),
		["https://hyper.charm.land/v1/provider", "https://hyper.charm.land/v1/models"],
	);
	assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer hyper-test-key");
	assert.equal(new Headers(requests[0]?.init?.headers).get("user-agent"), HYPER_USER_AGENT);
});

test("DeepSeek preflight checks the authenticated model catalog without generating output", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const adapter = createDeepSeekPreflightAdapter(1_000);

	const snapshot = await adapter.fetch({
		fetch: async (input, init) => {
			requests.push({ url: String(input), init });
			return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
		getApiKey: async () => "deepseek-test-key",
		now: () => 1_000,
		model: { provider: "deepseek", id: "deepseek-v4-pro" } as any,
	});

	assert.deepEqual(snapshot, {
		passed: true,
		checks: ["endpoint", "auth", "catalog"],
		updatedAt: 1_000,
		httpStatus: 200,
	});
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.url, "https://api.deepseek.com/models");
	assert.deepEqual(requests[0]?.init?.headers, {
		Accept: "application/json",
		"Accept-Encoding": "identity",
		Authorization: "Bearer deepseek-test-key",
	});
});

test("Google preflight uses the Gemini API key header and requires a generative catalog model", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const adapter = createGooglePreflightAdapter(1_000);

	const snapshot = await adapter.fetch({
		fetch: async (input, init) => {
			requests.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					models: [
						{
							name: "models/gemini-3.1-pro-preview",
							baseModelId: "gemini-3.1-pro-preview",
							supportedGenerationMethods: ["generateContent"],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
		getApiKey: async () => "google-test-key",
		now: () => 2_000,
		model: { provider: "google", id: "gemini-3.1-pro-preview" } as any,
	});

	assert.deepEqual(snapshot, {
		passed: true,
		checks: ["endpoint", "auth", "catalog"],
		updatedAt: 2_000,
		httpStatus: 200,
	});
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.url, "https://generativelanguage.googleapis.com/v1beta/models");
	assert.deepEqual(requests[0]?.init?.headers, {
		Accept: "application/json",
		"Accept-Encoding": "identity",
		"x-goog-api-key": "google-test-key",
	});
});

test("Google preflight also matches a versioned model name when its base model ID differs", async () => {
	const adapter = createGooglePreflightAdapter(1_000);
	const snapshot = await adapter.fetch({
		fetch: async () =>
			new Response(
				JSON.stringify({
					models: [
						{
							name: "models/gemini-3.1-pro-preview-001",
							baseModelId: "gemini-3.1-pro-preview",
							supportedGenerationMethods: ["generateContent"],
						},
					],
				}),
				{ status: 200 },
			),
		getApiKey: async () => "google-test-key",
		now: () => 2_500,
		model: { provider: "google", id: "gemini-3.1-pro-preview-001" } as any,
	});

	assert.equal(snapshot.passed, true);
});

test("OpenCode Zen preflight checks its public catalog without claiming catalog access proves auth", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const adapter = createOpenCodePreflightAdapter(1_000);

	const snapshot = await adapter.fetch({
		fetch: async (input, init) => {
			requests.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					object: "list",
					data: [{ id: "gpt-5.5", object: "model", owned_by: "opencode" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
		getApiKey: async () => "opencode-test-key",
		now: () => 3_000,
		model: { provider: "opencode", id: "gpt-5.5" } as any,
	});

	assert.deepEqual(snapshot, {
		passed: true,
		checks: ["endpoint", "catalog"],
		updatedAt: 3_000,
		httpStatus: 200,
	});
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.url, "https://opencode.ai/zen/v1/models");
	assert.deepEqual(requests[0]?.init?.headers, {
		Accept: "application/json",
		"Accept-Encoding": "identity",
		Authorization: "Bearer opencode-test-key",
	});
});

test("OpenCode Go preflight uses the Go catalog endpoint for the native Go provider", async () => {
	const requests: string[] = [];
	const adapter = createOpenCodeGoPreflightAdapter(1_000);

	const snapshot = await adapter.fetch({
		fetch: async (input) => {
			requests.push(String(input));
			return new Response(JSON.stringify({ object: "list", data: [{ id: "kimi-k3" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
		getApiKey: async () => "opencode-go-test-key",
		now: () => 4_000,
		model: { provider: "opencode-go", id: "kimi-k3" } as any,
	});

	assert.deepEqual(snapshot, {
		passed: true,
		checks: ["endpoint", "catalog"],
		updatedAt: 4_000,
		httpStatus: 200,
	});
	assert.deepEqual(requests, ["https://opencode.ai/zen/go/v1/models"]);
});

test("OpenAI Codex preflight sends the OAuth account identity to the per-account model catalog", async () => {
	const encode = (value: string) => Buffer.from(value).toString("base64url");
	const token = [
		encode("header"),
		encode(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })),
		encode("signature"),
	].join(".");
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const adapter = createOpenAICodexPreflightAdapter(1_000);

	const snapshot = await adapter.fetch({
		fetch: async (input, init) => {
			requests.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-5.6-sol",
							visibility: "list",
							supported_in_api: true,
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
		getApiKey: async () => token,
		now: () => 5_000,
		model: { provider: "openai-codex", id: "gpt-5.6-sol" } as any,
	});

	assert.deepEqual(snapshot, {
		passed: true,
		checks: ["endpoint", "auth", "catalog"],
		updatedAt: 5_000,
		httpStatus: 200,
	});
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.url, "https://chatgpt.com/backend-api/codex/models?client_version=0.144.1");
	assert.deepEqual(requests[0]?.init?.headers, {
		Accept: "application/json",
		"Accept-Encoding": "identity",
		Authorization: `Bearer ${token}`,
		"chatgpt-account-id": "account-123",
		originator: "pi",
		"User-Agent": "@hyav/pi-provider",
	});
});

test("OpenAI Codex preflight rejects a credential without an account identity before network access", async () => {
	const adapter = createOpenAICodexPreflightAdapter(1_000);
	let requests = 0;

	await assert.rejects(
		adapter.fetch({
			fetch: async () => {
				requests++;
				return new Response("unexpected");
			},
			getApiKey: async () => "not-a-codex-jwt",
			now: () => 6_000,
			model: { provider: "openai-codex", id: "gpt-5.5" } as any,
		}),
		(error: any) => error?.name === "ProviderDataError" && error.code === "auth",
	);
	assert.equal(requests, 0);
});

test("new provider preflights check their authenticated catalogs", async () => {
	const { createGroqPreflightAdapter } = await import("../preflight/groq.ts");
	const { createXaiPreflightAdapter } = await import("../preflight/xai.ts");
	const { createGithubCopilotPreflightAdapter } = await import("../preflight/github-copilot.ts");
	const { createOpenRouterPreflightAdapter } = await import("../preflight/openrouter.ts");

	const cases = [
		{
			name: "Groq",
			adapter: createGroqPreflightAdapter(1_000),
			url: "https://api.groq.com/openai/v1/models",
			body: { data: [{ id: "llama-4-maverick" }] },
			model: "llama-4-maverick",
			checks: ["endpoint", "auth", "catalog"],
		},
		{
			name: "xAI",
			adapter: createXaiPreflightAdapter(1_000),
			url: "https://api.x.ai/v1/models",
			body: { data: [{ id: "grok-4.6" }] },
			model: "grok-4.6",
			checks: ["endpoint", "catalog", "auth"],
		},
		{
			name: "GitHub Copilot",
			adapter: createGithubCopilotPreflightAdapter(1_000),
			url: "https://api.individual.githubcopilot.com/models",
			body: { data: [{ id: "gpt-5.6-sol" }] },
			model: "gpt-5.6-sol",
			checks: ["endpoint", "catalog", "auth"],
		},
	];

	for (const entry of cases) {
		const snapshot = await entry.adapter.fetch({
			fetch: async (input, init) => {
				assert.equal(String(input), entry.url);
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
				return new Response(JSON.stringify(entry.body), { status: 200 });
			},
			getApiKey: async () => "test-key",
			now: () => 3_000,
			model: { provider: entry.adapter.providerId, id: entry.model } as any,
		});
		assert.deepEqual(snapshot, {
			passed: true,
			checks: entry.checks,
			updatedAt: 3_000,
			httpStatus: 200,
		});
	}

	const openRouterAdapter = createOpenRouterPreflightAdapter(1_000);
	const openRouterSnapshot = await openRouterAdapter.fetch({
		fetch: async (input, init) => {
			const url = String(input);
			if (url === "https://openrouter.ai/api/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.6" }] }), { status: 200 });
			}
			assert.equal(url, "https://openrouter.ai/api/v1/auth/key");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
			return new Response(JSON.stringify({ data: { label: "cli", usage: 1, limit: null, is_free_tier: true } }), {
				status: 200,
			});
		},
		getApiKey: async () => "test-key",
		now: () => 4_000,
		model: { provider: "openrouter", id: "openai/gpt-5.6" } as any,
	});
	assert.deepEqual(openRouterSnapshot, {
		passed: true,
		checks: ["endpoint", "catalog", "auth"],
		updatedAt: 4_000,
	});
});

test("first-batch preflights check OpenAI-style catalogs", async () => {
	const { createOpenAIPreflightAdapter } = await import("../preflight/openai.ts");
	const { createAnthropicPreflightAdapter } = await import("../preflight/anthropic.ts");
	const { createMistralPreflightAdapter } = await import("../preflight/mistral.ts");
	const { createNvidiaPreflightAdapter } = await import("../preflight/nvidia.ts");
	const { createCerebrasPreflightAdapter } = await import("../preflight/cerebras.ts");

	const cases = [
		{
			adapter: createOpenAIPreflightAdapter(1_000),
			url: "https://api.openai.com/v1/models",
			extraHeaders: undefined as Record<string, string> | undefined,
			modelId: "gpt-5.6",
			keyHeader: "authorization",
			keyValue: "Bearer test-key",
		},
		{
			adapter: createAnthropicPreflightAdapter(1_000),
			url: "https://api.anthropic.com/v1/models",
			extraHeaders: { "anthropic-version": "2023-06-01" },
			modelId: "claude-sonnet-4-6",
			keyHeader: "x-api-key",
			keyValue: "test-key",
		},
		{
			adapter: createMistralPreflightAdapter(1_000),
			url: "https://api.mistral.ai/v1/models",
			extraHeaders: undefined,
			modelId: "mistral-large-latest",
			keyHeader: "authorization",
			keyValue: "Bearer test-key",
		},
		{
			adapter: createNvidiaPreflightAdapter(1_000),
			url: "https://integrate.api.nvidia.com/v1/models",
			extraHeaders: undefined,
			modelId: "nvidia/nemotron-3.5-lightning-30b-a3b",
			keyHeader: "authorization",
			keyValue: "Bearer test-key",
		},
		{
			adapter: createCerebrasPreflightAdapter(1_000),
			url: "https://api.cerebras.ai/v1/models",
			extraHeaders: undefined,
			modelId: "llama-4-maverick",
			keyHeader: "authorization",
			keyValue: "Bearer test-key",
		},
	];

	for (const entry of cases) {
		const snapshot = await entry.adapter.fetch({
			fetch: async (input, init) => {
				assert.equal(String(input), entry.url);
				const headers = new Headers(init?.headers);
				assert.equal(headers.get(entry.keyHeader), entry.keyValue);
				for (const [header, value] of Object.entries(entry.extraHeaders ?? {})) {
					assert.equal(headers.get(header), value);
				}
				return new Response(JSON.stringify({ data: [{ id: entry.modelId }] }), { status: 200 });
			},
			getApiKey: async () => "test-key",
			now: () => 9_000,
			model: { provider: entry.adapter.providerId, id: entry.modelId } as any,
		});
		assert.deepEqual(snapshot, {
			passed: true,
			checks: ["endpoint", "catalog", "auth"],
			updatedAt: 9_000,
			httpStatus: 200,
		});
	}
});

test("catalog preflight supports provider-specific key headers and auth-less checks", async () => {
	const { createCatalogPreflightAdapter } = await import("../core/catalog-preflight.ts");
	const adapter = createCatalogPreflightAdapter(
		{
			id: "catalog-test",
			providerId: "test-provider",
			name: "Test",
			modelsUrl: "https://example.test/v1/models",
			keyHeader: "x-api-key",
			requireAuth: false,
		},
		1_000,
	);
	const snapshot = await adapter.fetch({
		fetch: async (input, init) => {
			assert.equal(String(input), "https://example.test/v1/models");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("x-api-key"), "test-key");
			return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 });
		},
		getApiKey: async () => "test-key",
		now: () => 21_000,
		model: { provider: "test-provider", id: "model-a" } as any,
	});
	assert.deepEqual(snapshot, {
		passed: true,
		checks: ["endpoint", "catalog"],
		updatedAt: 21_000,
		httpStatus: 200,
	});
});

test("moonshot and hugging face preflights check their catalogs", async () => {
	const { createMoonshotaiPreflightAdapter } = await import("../preflight/moonshotai.ts");
	const { createMoonshotaiCnPreflightAdapter } = await import("../preflight/moonshotai-cn.ts");
	const { createHuggingFacePreflightAdapter } = await import("../preflight/huggingface.ts");

	for (const [adapter, url, modelId] of [
		[createMoonshotaiPreflightAdapter(1_000), "https://api.moonshot.ai/v1/models", "kimi-k2.6"],
		[createMoonshotaiCnPreflightAdapter(1_000), "https://api.moonshot.cn/v1/models", "kimi-k2.6"],
		[createHuggingFacePreflightAdapter(1_000), "https://router.huggingface.co/v1/models", "moonshotai/Kimi-K2.5"],
	] as const) {
		const snapshot = await adapter.fetch({
			fetch: async (input: string | URL | Request, init?: RequestInit) => {
				assert.equal(String(input), url);
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
				return new Response(JSON.stringify({ data: [{ id: modelId }] }), { status: 200 });
			},
			getApiKey: async () => "test-key",
			now: () => 30_000,
			model: { provider: adapter.providerId, id: modelId } as any,
		});
		assert.deepEqual(snapshot, {
			passed: true,
			checks: ["endpoint", "catalog", "auth"],
			updatedAt: 30_000,
			httpStatus: 200,
		});
	}
});

test("Vercel AI Gateway preflight checks a mixed-type catalog", async () => {
	const { parseVercelModelIds, vercelAIGatewayPreflightAdapter } = await import("../preflight/vercel-ai-gateway.ts");
	assert.deepEqual(
		[
			...parseVercelModelIds({
				data: [
					{ id: "openai/gpt-5.6", type: "language" },
					{ id: "somewhere/embedding-model", type: "embedding" },
					{ id: "anthropic/claude-sonnet-4-6" },
				],
			}),
		],
		["openai/gpt-5.6", "anthropic/claude-sonnet-4-6"],
	);
	assert.throws(() => parseVercelModelIds({ data: [] }), /empty catalog/);

	const snapshot = await vercelAIGatewayPreflightAdapter.fetch({
		fetch: async (input) => {
			assert.equal(String(input), "https://ai-gateway.vercel.sh/v1/models");
			return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.6", type: "language" }] }), { status: 200 });
		},
		getApiKey: async () => "vercel-key",
		now: () => 99_000,
		model: { provider: "vercel-ai-gateway", id: "openai/gpt-5.6" } as any,
	});
	assert.deepEqual(snapshot, {
		passed: true,
		checks: ["endpoint", "auth", "catalog"],
		updatedAt: 99_000,
		httpStatus: 200,
	});
});

test("Anthropic preflight sends Bearer token when credential type is oauth", async () => {
	const { createAnthropicPreflightAdapter } = await import("../preflight/anthropic.ts");
	const adapter = createAnthropicPreflightAdapter(1_000);
	const snapshot = await adapter.fetch({
		fetch: async (input, init) => {
			assert.equal(String(input), "https://api.anthropic.com/v1/models");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer oauth-token");
			assert.equal(headers.get("x-api-key"), null);
			assert.equal(headers.get("anthropic-version"), "2023-06-01");
			return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), { status: 200 });
		},
		getApiKey: async () => "oauth-token",
		getCredentialType: async () => "oauth",
		now: () => 10_000,
		model: { provider: "anthropic", id: "claude-sonnet-4-6" } as any,
	});
	assert.deepEqual(snapshot, {
		passed: true,
		checks: ["endpoint", "catalog", "auth"],
		updatedAt: 10_000,
		httpStatus: 200,
	});
});
