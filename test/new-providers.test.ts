import assert from "node:assert/strict";
import test from "node:test";
import { ProviderDataError } from "../core/errors.ts";
import { createAnthropicStatusAdapter, parseAnthropicUsage } from "../status/anthropic.ts";
import { createGithubCopilotStatusAdapter, githubCopilotStatusAdapter } from "../status/github-copilot.ts";
import { groqStatusAdapter } from "../status/groq.ts";
import { createOpenRouterStatusAdapter, openRouterStatusAdapter } from "../status/openrouter.ts";
import { createXaiStatusAdapter, xaiStatusAdapter } from "../status/xai.ts";

function statusContext(key: string | undefined, fetch: typeof globalThis.fetch) {
	return {
		getApiKey: async () => key,
		fetch,
		now: () => 1_700_000_000_000,
	};
}

test("parses anthropic subscription usage payloads", () => {
	const parsed = parseAnthropicUsage({
		plan: "Ent",
		subscribedUsage: {
			session: 12,
			sessionLimit: 100,
			weekly: 320,
			weeklyLimit: 500,
			extraUsageBalanceUsd: 15,
		},
		weeklyResetAt: 1_700_100_000,
	});
	assert.equal(parsed.plan, "Ent");
	assert.deepEqual(
		parsed.windows.map(({ id, used, limit }) => ({ id, used, limit })),
		[
			{ id: "session-usage", used: 12, limit: 100 },
			{ id: "weekly-usage", used: 320, limit: 500 },
		],
	);
	assert.equal(parsed.resetAt, 1_700_100_000_000);
	assert.equal(parsed.extraUsageBalanceUsd, 15);
	const empty = parseAnthropicUsage({});
	assert.deepEqual(empty.windows, []);
	assert.equal(empty.plan, undefined);
});

test("queries anthropic subscription usage with a Bearer token", async () => {
	const adapter = createAnthropicStatusAdapter(8_000);
	const snapshot = await adapter.fetch({
		...statusContext("oauth-token", async (input, init) => {
			assert.equal(input.toString(), "https://claude.ai/api/usage");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer oauth-token");
			assert.equal(headers.get("user-agent"), "@hyav/pi-provider");
			return new Response(
				JSON.stringify({
					plan: "Max",
					subscribedUsage: { weekly: 20, weeklyLimit: 100 },
				}),
				{ status: 200 },
			);
		}),
		getCredentialType: async () => "oauth",
	});
	assert.deepEqual(
		snapshot.entries.map(({ id }) => id),
		["plan", "weekly-usage"],
	);
});

test("github-copilot status routes around missing usage endpoints", async () => {
	const adapter = createGithubCopilotStatusAdapter(8_000);
	const snapshot = await adapter.fetch(statusContext("copilot-token", async () => new Response("", { status: 404 })));
	assert.deepEqual(snapshot.entries, [
		{ kind: "text", id: "usage", label: "Usage", value: "unavailable for this plan" },
	]);
});

test("github-copilot status shows modelCatalog quotas", async () => {
	const snapshot = await githubCopilotStatusAdapter.fetch(
		statusContext("copilot-token", async (input, init) => {
			assert.equal(input.toString(), "https://api.individual.githubcopilot.com/usage");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer copilot-token");
			return new Response(
				JSON.stringify({
					modelCatalog: {
						planName: "Pro",
						usage: {
							modelQuotas: {
								"gpt-5.1-codex": {
									modelCopilotName: "GPT-5.1 Codex",
									usedRequestsQuantity: 20,
									allowedRequestsQuantity: 100,
								},
							},
						},
					},
				}),
				{ status: 200 },
			);
		}),
	);
	assert.deepEqual(snapshot.entries, [
		{ kind: "text", id: "plan", label: "Plan", value: "Pro" },
		{
			kind: "window",
			id: "quota-gpt-5.1-codex",
			label: "GPT-5.1 Codex",
			remainingPercent: 80,
		},
	]);
});

test("groq status reads x-ratelimit headers", async () => {
	const snapshot = await groqStatusAdapter.fetch(
		statusContext("groq-key", async (input, init) => {
			assert.equal(input.toString(), "https://api.groq.com/openai/v1/models");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer groq-key");
			return new Response(JSON.stringify({ data: [{ id: "llama-4-maverick" }] }), {
				status: 200,
				headers: {
					"x-ratelimit-limit-requests": "100",
					"x-ratelimit-remaining-requests": "80",
					"x-ratelimit-reset-requests": "1d",
				},
			});
		}),
	);
	assert.deepEqual(
		snapshot.entries.map(({ id }) => id),
		["models", "requests-per-day"],
	);
	const requestsEntry = snapshot.entries[1];
	assert.equal(requestsEntry.kind, "window");
	if (requestsEntry.kind === "window") {
		assert.equal(requestsEntry.remainingPercent, 80);
	}
});

test("openrouter status reads /auth/key with credits fallback", async () => {
	const adapter = createOpenRouterStatusAdapter(8_000);
	const snapshot = await adapter.fetch(
		statusContext("or-key", async (input: string | URL | Request) => {
			const urlString = input.toString();
			if (urlString === "https://openrouter.ai/api/v1/auth/key") {
				return new Response(
					JSON.stringify({
						data: { label: "cli", usage: 25.5, limit: null, is_free_tier: true },
					}),
					{ status: 200 },
				);
			}
			if (urlString === "https://openrouter.ai/api/v1/credits") {
				return new Response(JSON.stringify({ data: { total_credits: 0, total_usage: 0 } }), {
					status: 200,
				});
			}
			return new Response("not found", { status: 404 });
		}),
	);
	assert.deepEqual(
		snapshot.entries.map(({ id }) => id),
		["key", "credits-used", "credits-remaining", "account-tier"],
	);
});

test("xai status reads x-ratelimit headers", async () => {
	const adapter = createXaiStatusAdapter(8_000);
	const snapshot = await adapter.fetch(
		statusContext("xai-token", async (input, init) => {
			assert.equal(input.toString(), "https://api.x.ai/v1/models");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer xai-token");
			return new Response("{}", {
				status: 200,
				headers: {
					"x-ratelimit-limit-tokens": "1000",
					"x-ratelimit-remaining-tokens": "500",
				},
			});
		}),
	);
	assert.deepEqual(
		snapshot.entries.map(({ id }) => id),
		["tokens-window"],
	);
	const tokensEntry = snapshot.entries[0];
	assert.equal(tokensEntry.kind, "window");
	if (tokensEntry.kind === "window") {
		assert.equal(tokensEntry.remainingPercent, 50);
	}
});

test("status adapters require credentials and surface HTTP failures", async () => {
	for (const adapter of [
		openRouterStatusAdapter,
		groqStatusAdapter,
		xaiStatusAdapter,
		githubCopilotStatusAdapter,
		createAnthropicStatusAdapter(8_000),
	]) {
		await assert.rejects(
			adapter.fetch(statusContext(undefined, async () => new Response("unused"))),
			(error: unknown) => error instanceof ProviderDataError && error.code === "auth",
		);
	}
	await assert.rejects(
		groqStatusAdapter.fetch(statusContext("groq-key", async () => new Response("", { status: 500 }))),
		(error: unknown) => error instanceof ProviderDataError && error.code === "http500",
	);
});

test("parses moonshot balance payloads", async () => {
	const { parseMoonshotBalance } = await import("../status/moonshotai.ts");
	assert.deepEqual(
		parseMoonshotBalance({
			code: 0,
			data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3 },
			scode: "0x0",
			status: true,
		}),
		{ available: 49.58, voucher: 46.58, cash: 3 },
	);
	assert.throws(
		() => parseMoonshotBalance({ code: 0, data: { available_balance: "nan" } }),
		/returned an invalid balance response/,
	);
});

test("moonshot status reads balance for both platforms", async () => {
	const { moonshotaiStatusAdapter } = await import("../status/moonshotai.ts");
	const { moonshotaiCnStatusAdapter } = await import("../status/moonshotai-cn.ts");
	for (const [adapter, expectedUrl] of [
		[moonshotaiStatusAdapter, "https://api.moonshot.ai/v1/users/me/balance"],
		[moonshotaiCnStatusAdapter, "https://api.moonshot.cn/v1/users/me/balance"],
	] as const) {
		const snapshot = await adapter.fetch({
			...statusContext("moonshot-key", async (input, init) => {
				assert.equal(String(input), expectedUrl);
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer moonshot-key");
				return new Response(
					JSON.stringify({
						code: 0,
						data: { available_balance: 12.5, voucher_balance: 10, cash_balance: 2.5 },
					}),
					{ status: 200 },
				);
			}),
		});
		assert.deepEqual(
			snapshot.entries.map(({ id }) => id),
			["available-balance", "voucher-balance", "cash-balance"],
		);
	}
});

test("hugging face status reports plan and credits", async () => {
	const { huggingFaceStatusAdapter } = await import("../status/huggingface.ts");
	const snapshot = await huggingFaceStatusAdapter.fetch(
		statusContext("hf-token", async (input, init) => {
			assert.equal(String(input), "https://huggingface.co/api/whoami-v2");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer hf-token");
			return new Response(JSON.stringify({ type: "user", plan: "PRO", credits: 1.24 }), {
				status: 200,
			});
		}),
	);
	assert.deepEqual(snapshot.entries, [
		{ kind: "text", id: "plan", label: "Plan", value: "PRO" },
		{ kind: "amount", id: "credits", label: "Credits", value: 1.24, unit: "USD" },
	]);
});

test("parses Vercel AI Gateway credits", async () => {
	const { parseVercelCredits } = await import("../status/vercel-ai-gateway.ts");
	assert.deepEqual(parseVercelCredits({ balance: 1.25, total_used: 0.75 }), { balance: 1.25, totalUsed: 0.75 });
	assert.throws(() => parseVercelCredits({ balance: 1.25 }), /invalid credits response/);
	assert.throws(() => parseVercelCredits({ balance: "nope", total_used: 0 }), /invalid credits response/);
});

test("Vercel AI Gateway status reads credits with a Bearer key", async () => {
	const { vercelAIGatewayStatusAdapter } = await import("../status/vercel-ai-gateway.ts");
	const snapshot = await vercelAIGatewayStatusAdapter.fetch(
		statusContext("vercel-key", async (input, init) => {
			assert.equal(String(input), "https://ai-gateway.vercel.sh/v1/credits");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer vercel-key");
			return new Response(JSON.stringify({ balance: 0.5, total_used: 4.5 }), { status: 200 });
		}),
	);
	assert.deepEqual(snapshot.entries, [
		{ kind: "amount", id: "balance", label: "Balance", value: 0.5, unit: "USD" },
		{ kind: "amount", id: "total-used", label: "Total Used", value: 4.5, unit: "USD" },
	]);
	await assert.rejects(
		vercelAIGatewayStatusAdapter.fetch(
			statusContext("vercel-key", async () => new Response("", { status: 401 })),
		),
		(error: unknown) => error instanceof ProviderDataError && error.code === "auth",
	);
});
