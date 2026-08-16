import assert from "node:assert/strict";
import test from "node:test";
import { ProviderDataError } from "../core/errors.ts";
import { PreflightManager } from "../core/preflight-manager.ts";
import { parseRetryAfter } from "../core/retry-after.ts";
import { normalizeStatusSnapshot, StatusManager } from "../core/status-manager.ts";
import { HYPER_USER_AGENT } from "../providers/charm-hyper.ts";
import { hyperStatusAdapter, parseHyperTeamName } from "../status/charm-hyper.ts";
import { deepSeekStatusAdapter, parseDeepSeekBalance } from "../status/deepseek.ts";
import { openAICodexStatusAdapter, parseCodexUsage } from "../status/openai-codex.ts";
import { openCodeGoStatusAdapter, parseOpenCodeGoUsage } from "../status/opencode-go.ts";

function statusContext(key: string | undefined, fetch: typeof globalThis.fetch) {
	return {
		getApiKey: async () => key,
		fetch,
		now: () => 1_700_000_000_000,
	};
}

function base64Url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function codexToken(accountId = "account-123"): string {
	return `${base64Url({ alg: "none" })}.${base64Url({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

test("reads a safe Hyper OAuth team name without exposing credentials", () => {
	assert.equal(parseHyperTeamName({ type: "oauth", teamName: "Team One" }), "Team One");
	assert.equal(parseHyperTeamName({ type: "api_key", teamName: "Team One" }), undefined);
	assert.equal(parseHyperTeamName({ type: "oauth", teamName: "\u0000secret" }), undefined);
});

test("queries Hyper credits with a versioned User-Agent and validates the balance", async () => {
	const snapshot = await hyperStatusAdapter.fetch(
		statusContext("hyper-key", async (input, init) => {
			assert.equal(input.toString(), "https://hyper.charm.land/v1/credits");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer hyper-key");
			assert.equal(headers.get("accept"), "application/json");
			assert.equal(headers.get("content-type"), "application/json");
			assert.equal(headers.get("user-agent"), HYPER_USER_AGENT);
			return new Response(JSON.stringify({ balance: 75 }), { status: 200 });
		}),
	);
	assert.deepEqual(snapshot.entries, [
		{ kind: "amount", id: "balance", label: "Balance", value: 75, unit: "credits" },
	]);

	await assert.rejects(
		hyperStatusAdapter.fetch(statusContext("hyper-key", async () => new Response(JSON.stringify({ balance: "75" })))),
		(error: unknown) => error instanceof ProviderDataError && error.code === "badjson",
	);
	await assert.rejects(
		hyperStatusAdapter.fetch(
			statusContext("hyper-key", async () => new Response(JSON.stringify({ balance: 75, unexpected: true }))),
		),
		(error: unknown) => error instanceof ProviderDataError && error.code === "badjson",
	);
});

test("parses OpenCode Go usage windows", () => {
	assert.deepEqual(
		parseOpenCodeGoUsage({
			useBalance: true,
			rollingUsage: { status: "ok", resetInSec: 2_400, usagePercent: 35 },
			weeklyUsage: { status: "ok", resetInSec: 259_200, usagePercent: 20 },
			monthlyUsage: { status: "rate-limited", resetInSec: 1_728_000, usagePercent: 100 },
		}),
		{
			useBalance: true,
			rollingUsage: { status: "ok", resetInSec: 2_400, usagePercent: 35 },
			weeklyUsage: { status: "ok", resetInSec: 259_200, usagePercent: 20 },
			monthlyUsage: { status: "rate-limited", resetInSec: 1_728_000, usagePercent: 100 },
		},
	);
});

test("fetches OpenCode Go usage with a bearer key and renders all windows", async () => {
	const snapshot = await openCodeGoStatusAdapter.fetch(
		statusContext("opencode-go-key", async (input, init) => {
			assert.equal(input.toString(), "https://opencode.ai/zen/go/v1/usage");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer opencode-go-key");
			assert.equal(headers.get("accept"), "application/json");
			return new Response(
				JSON.stringify({
					useBalance: false,
					rollingUsage: { status: "ok", resetInSec: 2_400, usagePercent: 35 },
					weeklyUsage: { status: "ok", resetInSec: 259_200, usagePercent: 20 },
					monthlyUsage: { status: "rate-limited", resetInSec: 1_728_000, usagePercent: 100 },
				}),
				{ status: 200 },
			);
		}),
	);
	assert.deepEqual(snapshot.entries, [
		{ kind: "text", id: "plan", label: "Plan", value: "Go" },
		{ kind: "window", id: "rolling-window", label: "5h", remainingPercent: 65, resetAt: 1_700_002_400_000 },
		{ kind: "window", id: "weekly-window", label: "Weekly", remainingPercent: 80, resetAt: 1_700_259_200_000 },
		{ kind: "window", id: "monthly-window", label: "Monthly", remainingPercent: 0, resetAt: 1_701_728_000_000 },
		{ kind: "text", id: "zen-balance-fallback", label: "Zen balance fallback", value: "disabled" },
	]);
});

test("classifies OpenCode Go auth, rate limits, and malformed usage", async () => {
	await assert.rejects(
		openCodeGoStatusAdapter.fetch(statusContext(undefined, async () => new Response("unused"))),
		(error: unknown) => error instanceof ProviderDataError && error.code === "auth",
	);
	await assert.rejects(
		openCodeGoStatusAdapter.fetch(
			statusContext("key", async () => new Response(JSON.stringify({ useBalance: false }), { status: 200 })),
		),
		(error: unknown) => error instanceof ProviderDataError && error.code === "badjson",
	);
	await assert.rejects(
		openCodeGoStatusAdapter.fetch(
			statusContext("key", async () => new Response("busy", { status: 429, headers: { "retry-after": "12" } })),
		),
		(error: unknown) =>
			error instanceof ProviderDataError && error.code === "http429" && error.retryAt === 1_700_000_012_000,
	);
});

test("parses DeepSeek total balances without requiring grant or top-up fields", () => {
	assert.deepEqual(
		parseDeepSeekBalance({
			is_available: true,
			balance_infos: [
				{ currency: "CNY", total_balance: "80" },
				{ currency: "USD", total_balance: "15.50", granted_balance: "1.50", topped_up_balance: "14.00" },
			],
		}),
		[
			{ currency: "CNY", totalBalance: 80 },
			{ currency: "USD", totalBalance: 15.5 },
		],
	);
});

test("queries and renders the preferred DeepSeek USD total", async () => {
	const request = await deepSeekStatusAdapter.fetch(
		statusContext("deepseek-key", async (input, init) => {
			assert.equal(input.toString(), "https://api.deepseek.com/user/balance");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer deepseek-key");
			return new Response(
				JSON.stringify({
					balance_infos: [
						{ currency: "CNY", total_balance: "80" },
						{ currency: "USD", total_balance: "15.50" },
					],
				}),
				{ status: 200 },
			);
		}),
	);
	assert.deepEqual(request.entries, [{ kind: "amount", id: "balance", label: "Balance", value: 15.5, unit: "USD" }]);
});

test("classifies missing DeepSeek credentials and malformed responses", async () => {
	await assert.rejects(
		deepSeekStatusAdapter.fetch(statusContext(undefined, async () => new Response("unused"))),
		(error: unknown) => error instanceof ProviderDataError && error.code === "auth",
	);
	await assert.rejects(
		deepSeekStatusAdapter.fetch(
			statusContext("key", async () => new Response(JSON.stringify({ balance_infos: [{}] }), { status: 200 })),
		),
		(error: unknown) => error instanceof ProviderDataError && error.code === "badjson",
	);
});

test("parses Retry-After seconds and dates without creating an infinite retry time", () => {
	const now = 1_700_000_000_000;
	assert.equal(parseRetryAfter("12", now), now + 12_000);
	const future = Date.parse(new Date(now + 30_000).toUTCString());
	assert.equal(parseRetryAfter(new Date(now + 30_000).toUTCString(), now), future);
	assert.equal(parseRetryAfter(new Date(now - 30_000).toUTCString(), now), now);
	assert.equal(parseRetryAfter("-1", now), undefined);
	assert.equal(parseRetryAfter("not-a-delay", now), undefined);

	const extreme = parseRetryAfter("999999999999999999999999999999", now);
	assert.ok(extreme === undefined || Number.isFinite(extreme));
	if (extreme !== undefined) assert.ok(extreme <= now + 24 * 60 * 60 * 1_000);
});

test("reads Retry-After from Codex rate-limit errors", async () => {
	const token = codexToken();
	await assert.rejects(
		openAICodexStatusAdapter.fetch(
			statusContext(token, async () => new Response("busy", { status: 429, headers: { "retry-after": "12" } })),
		),
		(error: unknown) =>
			error instanceof ProviderDataError && error.code === "http429" && error.retryAt === 1_700_000_012_000,
	);
});

test("drops a cached status snapshot when the credential changes", async () => {
	let key = "first-key";
	const manager = new StatusManager(
		[
			{
				id: "credential-status",
				providerId: "credential-provider",
				name: "Credential Provider",
				cacheTtlMs: 60_000,
				requestTimeoutMs: 1_000,
				fetch: async (context) => {
					if ((await context.getApiKey()) !== "first-key") {
						throw new ProviderDataError("credential changed", "auth", undefined, 401);
					}
					return {
						entries: [{ kind: "amount", id: "balance", label: "Balance", value: 1, unit: "credits" }],
						updatedAt: 1,
					};
				},
			},
		],
		(async () => new Response("unused")) as typeof globalThis.fetch,
		() => 1,
	);
	const context = {
		model: { provider: "credential-provider" },
		modelRegistry: { getApiKeyForProvider: async () => key },
		getCredentialKey: async () => key,
	};

	assert.equal(await manager.update(context, { force: true }), "refreshed");
	assert.ok(manager.getSnapshot("credential-provider"));
	key = "second-key";
	assert.equal(await manager.update(context, { force: true }), "failed");
	assert.equal(manager.getSnapshot("credential-provider"), undefined);
});

test("preserves structured status errors from an isolated extension context", async () => {
	const now = 1_700_000_000_000;
	const manager = new StatusManager(
		[
			{
				id: "isolated-status",
				providerId: "isolated-provider",
				name: "Isolated Provider",
				cacheTtlMs: 0,
				requestTimeoutMs: 1_000,
				fetch: async () => {
					throw { name: "ProviderDataError", code: "http429", retryAt: now + 12_000 };
				},
			},
		],
		(async () => new Response("unused")) as typeof globalThis.fetch,
		() => now,
	);

	await manager.update({
		model: { provider: "isolated-provider" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
	});
	assert.deepEqual(manager.getDiagnostics("isolated-provider").lastError, {
		code: "http429",
		retryAt: now + 12_000,
	});
});

test("preserves structured preflight errors from an isolated extension context", async () => {
	const manager = new PreflightManager(
		[
			{
				id: "isolated-preflight",
				providerId: "isolated-preflight-provider",
				name: "Isolated Provider",
				cacheTtlMs: 0,
				requestTimeoutMs: 1_000,
				fetch: async () => {
					throw { name: "ProviderDataError", code: "http429", retryAt: 1_700_000_012_000 };
				},
			},
		],
		(async () => new Response("unused")) as typeof globalThis.fetch,
		() => 1_700_000_000_000,
	);

	await manager.update({
		model: { provider: "isolated-preflight-provider", id: "model" } as any,
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
	});
	assert.deepEqual(manager.getDiagnostics("isolated-preflight-provider", "model").lastError, {
		code: "http429",
		retryAt: 1_700_000_012_000,
	});
});

test("keeps HTTP status in structured status diagnostics", async () => {
	const manager = new StatusManager(
		[
			{
				id: "http-status",
				providerId: "http-status-provider",
				name: "HTTP Status Provider",
				cacheTtlMs: 0,
				requestTimeoutMs: 1_000,
				fetch: async () => {
					throw new ProviderDataError("rate limited", "http429", 1_700_000_012_000, 429);
				},
			},
		],
		(async () => new Response("unused")) as typeof globalThis.fetch,
		() => 1_700_000_000_000,
	);

	await manager.update({
		model: { provider: "http-status-provider" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
	});
	assert.deepEqual(manager.getDiagnostics("http-status-provider").lastError, {
		code: "http429",
		httpStatus: 429,
		retryAt: 1_700_000_012_000,
	});
});

test("honors Retry-After before a forced status refresh", async () => {
	let now = 1_700_000_000_000;
	let requests = 0;
	const manager = new StatusManager(
		[
			{
				id: "retry-status",
				providerId: "retry-provider",
				name: "Retry Provider",
				cacheTtlMs: 0,
				requestTimeoutMs: 1_000,
				fetch: async (context) => {
					requests++;
					if (requests === 1) {
						throw new ProviderDataError("rate limited", "http429", parseRetryAfter("12", context.now()));
					}
					return { entries: [], updatedAt: context.now() };
				},
			},
		],
		(async () => new Response("unused")) as typeof globalThis.fetch,
		() => now,
	);
	const context = {
		model: { provider: "retry-provider" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
	};

	await manager.update(context);
	await manager.update(context, { force: true });
	assert.equal(requests, 1);

	now += 12_001;
	await manager.update(context, { force: true });
	assert.equal(requests, 2);
});

test("maps Codex plan and main rate-limit windows to status entries", () => {
	const parsed = parseCodexUsage({
		plan_type: "pro",
		rate_limit: {
			primary_window: { used_percent: 18, limit_window_seconds: 18_000, reset_at: 1_700_007_200 },
			secondary_window: { used_percent: 36, limit_window_seconds: 604_800, reset_at: 1_700_345_600 },
		},
	});
	assert.equal(parsed.planType, "pro");
	assert.equal(parsed.primaryWindow?.usedPercent, 18);
	assert.equal(parsed.secondaryWindow?.windowSeconds, 604_800);
});

test("fetches Codex usage with the account ID claim and ignores extra rate-limit buckets", async () => {
	const token = codexToken();
	const snapshot = await openAICodexStatusAdapter.fetch(
		statusContext(token, async (input, init) => {
			assert.equal(input.toString(), "https://chatgpt.com/backend-api/wham/usage");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), `Bearer ${token}`);
			assert.equal(headers.get("chatgpt-account-id"), "account-123");
			assert.equal(headers.get("originator"), "pi");
			return new Response(
				JSON.stringify({
					plan_type: "prolite",
					rate_limit: {
						primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1_700_007_200 },
						secondary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_at: 1_700_345_600 },
					},
					additional_rate_limits: [{ limit_name: "other", metered_feature: "other" }],
				}),
				{ status: 200 },
			);
		}),
	);
	assert.deepEqual(snapshot.entries, [
		{ kind: "text", id: "plan", label: "Plan", value: "Pro Lite" },
		{ kind: "window", id: "primary-window", label: "5h", remainingPercent: 90, resetAt: 1_700_007_200_000 },
		{ kind: "window", id: "weekly-window", label: "Weekly", remainingPercent: 80, resetAt: 1_700_345_600_000 },
	]);
});

test("keeps Codex window IDs unique when primary and secondary durations share a category", async () => {
	const token = codexToken();
	const snapshot = await openAICodexStatusAdapter.fetch(
		statusContext(
			token,
			async () =>
				new Response(
					JSON.stringify({
						plan_type: "plus",
						rate_limit: {
							primary_window: {
								used_percent: 1,
								limit_window_seconds: 604_800,
								reset_at: 1_700_345_600,
							},
							secondary_window: {
								used_percent: 2,
								limit_window_seconds: 604_800,
								reset_at: 1_700_345_601,
							},
						},
					}),
					{ status: 200 },
				),
		),
	);
	const normalized = normalizeStatusSnapshot(snapshot);
	const windows = normalized.entries.filter((entry) => entry.kind === "window");

	assert.deepEqual(
		windows.map(({ id }) => id),
		["weekly-window", "weekly-window-secondary"],
	);
});

test("classifies a lone weekly primary window by its duration", async () => {
	const token = codexToken();
	const snapshot = await openAICodexStatusAdapter.fetch(
		statusContext(
			token,
			async () =>
				new Response(
					JSON.stringify({
						plan_type: "plus",
						rate_limit: {
							primary_window: {
								used_percent: 1,
								limit_window_seconds: 604_800,
								reset_at: 1_700_345_600,
							},
							secondary_window: null,
						},
					}),
					{ status: 200 },
				),
		),
	);

	assert.deepEqual(snapshot.entries, [
		{ kind: "text", id: "plan", label: "Plan", value: "Plus" },
		{ kind: "window", id: "weekly-window", label: "Weekly", remainingPercent: 99, resetAt: 1_700_345_600_000 },
	]);
});

test("rejects Codex API-key mode and malformed OAuth tokens without exposing secrets", async () => {
	await assert.rejects(
		openAICodexStatusAdapter.fetch(statusContext("not-a-jwt", async () => new Response("unused"))),
		(error: unknown) =>
			error instanceof ProviderDataError && error.code === "auth" && !error.message.includes("not-a-jwt"),
	);
	await assert.rejects(
		openAICodexStatusAdapter.fetch(statusContext("key", async () => new Response("unused"))),
		(error: unknown) => error instanceof ProviderDataError && error.code === "auth",
	);
});
