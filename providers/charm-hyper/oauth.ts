import { hostname } from "node:os";
import { withDeadline } from "../../core/deadline.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import { HYPER_ROOT_URL, hyperJsonHeaders } from "./constants.ts";

const DEVICE_POLL_INTERVAL_SECONDS = 5;
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5_000;
const MINIMUM_POLL_INTERVAL_MS = 1_000;

const DEVICE_AUTH_URL = `${HYPER_ROOT_URL}/device/auth`;
const TOKEN_EXCHANGE_URL = `${HYPER_ROOT_URL}/token/exchange`;

type HyperOAuth = NonNullable<ProviderDefinition["oauth"]>;
type OAuthCredentials = Parameters<HyperOAuth["getApiKey"]>[0];
type DeviceAuthResponse = {
	deviceCode: string;
	expiresInSeconds: number;
	userCode: string;
	verificationUrl: string;
	intervalSeconds: number;
};
type DevicePollSuccess = { refreshToken: string; teamName: string };
type DevicePollResult =
	| { status: "pending" }
	| { status: "slow_down" }
	| { status: "failed"; message: string }
	| { status: "complete"; value: DevicePollSuccess };
type TokenExchangeResponse = {
	accessToken: string;
	refreshToken: string;
	expiresInSeconds?: number;
	expiresAtSeconds?: number;
};

class HyperOAuthHttpError extends Error {
	readonly name = "HyperOAuthHttpError";
	readonly #payload: unknown;

	constructor(
		readonly status: number,
		payload: unknown,
	) {
		super(`Charm Hyper OAuth request failed with HTTP ${status}`);
		this.#payload = payload;
	}

	matchesPayload(predicate: (payload: unknown) => boolean): boolean {
		return predicate(this.#payload);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

async function fetchJsonResponse(
	fetchFn: typeof globalThis.fetch,
	url: string,
	init: RequestInit,
	externalSignal: AbortSignal | undefined,
): Promise<{ status: number; ok: boolean; payload: unknown }> {
	return withDeadline(
		async (signal) => {
			const response = await fetchFn(url, { ...init, signal });
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new Error(`Charm Hyper OAuth returned invalid JSON from ${url}`);
			}
			return { status: response.status, ok: response.ok, payload };
		},
		OAUTH_REQUEST_TIMEOUT_MS,
		externalSignal,
	);
}

async function fetchJson(
	fetchFn: typeof globalThis.fetch,
	url: string,
	init: RequestInit,
	externalSignal?: AbortSignal,
): Promise<unknown> {
	const response = await fetchJsonResponse(fetchFn, url, init, externalSignal);
	if (!response.ok) throw new HyperOAuthHttpError(response.status, response.payload);
	return response.payload;
}

function parseDeviceAuthResponse(payload: unknown): DeviceAuthResponse {
	if (
		!isRecord(payload) ||
		!hasOnlyKeys(payload, ["device_code", "expires_in", "user_code", "verification_url", "interval"]) ||
		!nonEmptyString(payload.device_code) ||
		!positiveInteger(payload.expires_in) ||
		!nonEmptyString(payload.user_code) ||
		!nonEmptyString(payload.verification_url) ||
		(payload.interval !== undefined && !positiveInteger(payload.interval))
	) {
		throw new Error("Charm Hyper device auth response is invalid");
	}
	return {
		deviceCode: payload.device_code,
		expiresInSeconds: payload.expires_in,
		userCode: payload.user_code,
		verificationUrl: payload.verification_url,
		intervalSeconds: payload.interval ?? DEVICE_POLL_INTERVAL_SECONDS,
	};
}

function parseDevicePollResponse(payload: unknown): DevicePollResult {
	if (
		isRecord(payload) &&
		hasOnlyKeys(payload, ["refresh_token", "team_id", "team_name", "user_id"]) &&
		nonEmptyString(payload.refresh_token) &&
		nonEmptyString(payload.team_name) &&
		nonEmptyString(payload.team_id) &&
		nonEmptyString(payload.user_id)
	) {
		return { status: "complete", value: { refreshToken: payload.refresh_token, teamName: payload.team_name } };
	}
	if (!isRecord(payload) || !hasOnlyKeys(payload, ["error", "error_description"]) || !nonEmptyString(payload.error)) {
		throw new Error("Charm Hyper device token response is invalid");
	}
	if (
		payload.error !== "authorization_pending" &&
		payload.error !== "slow_down" &&
		payload.error !== "access_denied" &&
		payload.error !== "expired_token" &&
		payload.error !== "invalid_request" &&
		payload.error !== "invalid_grant"
	) {
		throw new Error("Charm Hyper device token response is invalid");
	}
	if (payload.error_description !== undefined && !nonEmptyString(payload.error_description)) {
		throw new Error("Charm Hyper device token response is invalid");
	}
	if (payload.error === "authorization_pending") return { status: "pending" };
	if (payload.error === "slow_down") return { status: "slow_down" };
	const description = nonEmptyString(payload.error_description) ? payload.error_description : payload.error;
	return { status: "failed", message: `Charm Hyper device authorization failed: ${description}` };
}

function parseTokenExchangeResponse(payload: unknown): TokenExchangeResponse {
	if (
		!isRecord(payload) ||
		!nonEmptyString(payload.access_token) ||
		!nonEmptyString(payload.token_type) ||
		!nonEmptyString(payload.refresh_token) ||
		!nonEmptyString(payload.expiry)
	) {
		throw new Error("Charm Hyper token exchange response is invalid");
	}
	if (Object.hasOwn(payload, "expires_in")) {
		if (
			!hasOnlyKeys(payload, ["access_token", "token_type", "refresh_token", "expiry", "expires_in"]) ||
			!positiveInteger(payload.expires_in) ||
			Object.hasOwn(payload, "expires_at")
		) {
			throw new Error("Charm Hyper token exchange response has an invalid expiry");
		}
		return {
			accessToken: payload.access_token,
			refreshToken: payload.refresh_token,
			expiresInSeconds: payload.expires_in,
		};
	}
	if (Object.hasOwn(payload, "expires_at")) {
		if (
			!hasOnlyKeys(payload, ["access_token", "token_type", "refresh_token", "expiry", "expires_at"]) ||
			!positiveInteger(payload.expires_at)
		) {
			throw new Error("Charm Hyper token exchange response has an invalid expiry");
		}
		return {
			accessToken: payload.access_token,
			refreshToken: payload.refresh_token,
			expiresAtSeconds: payload.expires_at,
		};
	}
	throw new Error("Charm Hyper token exchange response has an invalid expiry");
}

async function initiateDeviceAuth(
	fetchFn: typeof globalThis.fetch,
	signal: AbortSignal | undefined,
): Promise<DeviceAuthResponse> {
	const payload = await fetchJson(
		fetchFn,
		DEVICE_AUTH_URL,
		{
			method: "POST",
			headers: hyperJsonHeaders(),
			body: JSON.stringify({ device_name: deviceName() }),
		},
		signal,
	);
	return parseDeviceAuthResponse(payload);
}

function deviceName(): string {
	const host = hostname();
	return host ? `Pi (${host})` : "Pi";
}

async function pollDeviceAuth(
	fetchFn: typeof globalThis.fetch,
	deviceAuth: DeviceAuthResponse,
	now: () => number,
	signal: AbortSignal | undefined,
): Promise<DevicePollSuccess> {
	const deadline = now() + deviceAuth.expiresInSeconds * 1_000;
	let intervalMs = Math.max(MINIMUM_POLL_INTERVAL_MS, Math.floor(deviceAuth.intervalSeconds * 1_000));
	let slowDownResponses = 0;

	while (now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");
		const response = await fetchJsonResponse(
			fetchFn,
			`${DEVICE_AUTH_URL}/${encodeURIComponent(deviceAuth.deviceCode)}`,
			{ headers: hyperJsonHeaders() },
			signal,
		);
		const result = parseDevicePollResponse(response.payload);
		if (result.status === "complete") return result.value;
		if (result.status === "failed") throw new Error(result.message);
		if (result.status === "slow_down") {
			slowDownResponses++;
			intervalMs += SLOW_DOWN_INTERVAL_INCREMENT_MS;
		}
		const remainingMs = deadline - now();
		if (remainingMs <= 0) break;
		await abortableSleep(Math.min(intervalMs, remainingMs), signal);
	}

	throw new Error(
		slowDownResponses > 0
			? "Charm Hyper device flow timed out after slow_down responses"
			: "Charm Hyper device flow timed out",
	);
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Login cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function exchangeRefreshToken(
	fetchFn: typeof globalThis.fetch,
	refreshToken: string,
	signal: AbortSignal | undefined,
): Promise<TokenExchangeResponse> {
	const payload = await fetchJson(
		fetchFn,
		TOKEN_EXCHANGE_URL,
		{
			method: "POST",
			headers: hyperJsonHeaders(),
			body: JSON.stringify({ refresh_token: refreshToken }),
		},
		signal,
	);
	return parseTokenExchangeResponse(payload);
}

function tokenExpiresAtMs(token: TokenExchangeResponse, now: () => number): number {
	const currentTime = now();
	const expiresAt =
		token.expiresInSeconds !== undefined
			? currentTime + token.expiresInSeconds * 1_000
			: (token.expiresAtSeconds ?? 0) * 1_000;
	if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
		throw new Error("Charm Hyper token exchange response contains an expired token");
	}
	const bufferMs = Math.min(TOKEN_EXPIRY_BUFFER_MS, Math.floor((expiresAt - currentTime) / 2));
	return expiresAt - bufferMs;
}

function tokenToCredentials(
	token: TokenExchangeResponse,
	fallbackRefreshToken: string,
	now: () => number,
	metadata: { teamName?: string } = {},
): OAuthCredentials {
	return {
		type: "oauth",
		refresh: token.refreshToken || fallbackRefreshToken,
		access: token.accessToken,
		expires: tokenExpiresAtMs(token, now),
		...metadata,
	};
}

function isRejectedRefreshToken(error: unknown): error is HyperOAuthHttpError {
	return (
		error instanceof HyperOAuthHttpError &&
		error.status === 401 &&
		error.matchesPayload((payload) => isRecord(payload) && payload.error === "could not get refresh token: not found")
	);
}

export function createCharmHyperOAuth(fetchFn: typeof globalThis.fetch, now: () => number = Date.now): HyperOAuth {
	return {
		name: "Charm Hyper",
		login: async (callbacks) => {
			const deviceAuth = await initiateDeviceAuth(fetchFn, callbacks.signal);
			callbacks.onDeviceCode({
				userCode: deviceAuth.userCode,
				verificationUri: deviceAuth.verificationUrl,
				intervalSeconds: deviceAuth.intervalSeconds,
				expiresInSeconds: deviceAuth.expiresInSeconds,
			});
			const deviceToken = await pollDeviceAuth(fetchFn, deviceAuth, now, callbacks.signal);
			const token = await exchangeRefreshToken(fetchFn, deviceToken.refreshToken, callbacks.signal);
			return tokenToCredentials(token, deviceToken.refreshToken, now, { teamName: deviceToken.teamName });
		},
		refreshToken: async (credentials, signal) => {
			try {
				const token = await exchangeRefreshToken(fetchFn, credentials.refresh, signal);
				const teamName = typeof credentials.teamName === "string" ? credentials.teamName : undefined;
				return tokenToCredentials(token, credentials.refresh, now, teamName ? { teamName } : {});
			} catch (error) {
				if (isRejectedRefreshToken(error)) {
					throw new Error("Your Charm Hyper session is no longer valid. Run /login to re-authenticate.", {
						cause: error,
					});
				}
				throw error;
			}
		},
		getApiKey: (credentials) => credentials.access,
	};
}
