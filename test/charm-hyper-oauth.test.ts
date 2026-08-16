import assert from "node:assert/strict";
import test from "node:test";
import { HYPER_USER_AGENT } from "../providers/charm-hyper/constants.ts";
import { createCharmHyperOAuth } from "../providers/charm-hyper/oauth.ts";

test("completes Charm Hyper OAuth device login and exposes the access token", async () => {
	const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
	let pollCount = 0;
	const oauth = createCharmHyperOAuth(
		async (input, init) => {
			const url = input.toString();
			requests.push({
				url,
				method: init?.method ?? "GET",
				headers: new Headers(init?.headers),
				...(typeof init?.body === "string" ? { body: init.body } : {}),
			});
			if (url.endsWith("/device/auth")) {
				return new Response(
					JSON.stringify({
						device_code: "device-code",
						expires_in: 900,
						user_code: "ABCD-EFGH",
						verification_url: "https://hyper.charm.land/device",
						interval: 1,
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/device/auth/device-code")) {
				pollCount++;
				return new Response(
					JSON.stringify({
						refresh_token: "device-refresh",
						team_id: "team-1",
						team_name: "Team One",
						user_id: "user-1",
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/token/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "access-token",
						token_type: "Bearer",
						refresh_token: "exchanged-refresh",
						expiry: "2099-01-01T00:00:00.000Z",
						expires_in: 3_600,
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unexpected URL: ${url}`);
		},
		() => 1_000_000,
	);
	let deviceCode: unknown;

	const credentials = await oauth.login({
		onAuth() {},
		onDeviceCode(info: {
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}) {
			deviceCode = info;
		},
		onPrompt: async () => "",
		onSelect: async () => undefined,
		signal: undefined,
	} as any);

	assert.deepEqual(deviceCode, {
		userCode: "ABCD-EFGH",
		verificationUri: "https://hyper.charm.land/device",
		intervalSeconds: 1,
		expiresInSeconds: 900,
	});
	assert.equal(pollCount, 1);
	assert.equal(credentials.type, "oauth");
	assert.equal(credentials.access, "access-token");
	assert.equal(credentials.refresh, "exchanged-refresh");
	assert.equal(credentials.expires, 4_570_000);
	assert.equal(credentials.teamName, "Team One");
	assert.equal(oauth.getApiKey(credentials), "access-token");
	assert.equal(requests[0]?.method, "POST");
	assert.equal(requests[0]?.headers.get("user-agent"), HYPER_USER_AGENT);
	assert.equal(JSON.parse(requests[2]?.body ?? "{}").refresh_token, "device-refresh");
});

test("rejects an ambiguous Charm Hyper device response instead of accepting unknown fields", async () => {
	let tokenExchangeCalled = false;
	const oauth = createCharmHyperOAuth(
		async (input) => {
			const url = input.toString();
			if (url.endsWith("/device/auth")) {
				return new Response(
					JSON.stringify({
						device_code: "device-code",
						expires_in: 900,
						user_code: "ABCD-EFGH",
						verification_url: "https://hyper.charm.land/device",
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/device/auth/device-code")) {
				return new Response(
					JSON.stringify({
						refresh_token: "device-refresh",
						team_id: "team-1",
						team_name: "Team One",
						user_id: "user-1",
						error: "access_denied",
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/token/exchange")) {
				tokenExchangeCalled = true;
				return new Response(
					JSON.stringify({
						access_token: "access-token",
						token_type: "Bearer",
						refresh_token: "refresh-token",
						expiry: "2099-01-01T00:00:00.000Z",
						expires_in: 3_600,
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unexpected URL: ${url}`);
		},
		() => 1_000_000,
	);

	await assert.rejects(
		oauth.login({
			onAuth() {},
			onDeviceCode() {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
			signal: undefined,
		} as any),
		(error: unknown) => error instanceof Error && /device token response is invalid/.test(error.message),
	);
	assert.equal(tokenExchangeCalled, false);
});

test("prompts reauthentication when Charm Hyper rejects a refresh token", async () => {
	const oauth = createCharmHyperOAuth(
		async () => {
			return new Response(JSON.stringify({ error: "could not get refresh token: not found" }), { status: 401 });
		},
		() => 1_000_000,
	);

	await assert.rejects(
		oauth.refreshToken(
			{ type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1_000_000 },
			new AbortController().signal,
		),
		(error: unknown) => error instanceof Error && /re-authenticate/.test(error.message),
	);
});

test("honors Pi cancellation before refreshing a Charm Hyper token", async () => {
	let requests = 0;
	const oauth = createCharmHyperOAuth(
		async () => {
			requests++;
			return new Response(
				JSON.stringify({
					access_token: "new-access",
					token_type: "Bearer",
					refresh_token: "new-refresh",
					expiry: "2099-01-01T00:00:00.000Z",
					expires_in: 3_600,
				}),
				{ status: 200 },
			);
		},
		() => 1_000_000,
	);
	const controller = new AbortController();
	controller.abort(new DOMException("The operation was aborted", "AbortError"));

	await assert.rejects(
		oauth.refreshToken(
			{ type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1_000_000 },
			controller.signal,
		),
		{ name: "AbortError" },
	);
	assert.equal(requests, 0);
});
