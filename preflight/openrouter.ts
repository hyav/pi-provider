import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";
import { OPENROUTER_KEY_URL } from "../status/openrouter.ts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function collectModelIds(context: Parameters<PreflightAdapter["fetch"]>[0]): Promise<Set<string>> {
	const response = await context.fetch(OPENROUTER_MODELS_URL, {
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "identity",
			"User-Agent": "@hyav/pi-provider",
		},
		signal: context.signal,
	});
	if (!response.ok) {
		throw new ProviderDataError(
			`OpenRouter preflight failed: HTTP ${response.status}`,
			`http${response.status}`,
			parseRetryAfter(response.headers.get("retry-after"), context.now()),
			response.status,
		);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new ProviderDataError("OpenRouter preflight returned invalid JSON", "badjson");
	}
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new ProviderDataError("OpenRouter preflight returned invalid catalog data", "badjson");
	}
	return new Set(
		payload.data
			.filter(isRecord)
			.map((model) => (typeof model.id === "string" ? model.id.trim() : undefined))
			.filter((id): id is string => id !== undefined && id !== ""),
	);
}

async function checkCredential(context: Parameters<PreflightAdapter["fetch"]>[0], apiKey: string): Promise<number> {
	const response = await context.fetch(OPENROUTER_KEY_URL, {
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "identity",
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": "@hyav/pi-provider",
		},
		signal: context.signal,
	});
	if (response.status === 404) return response.status;
	if (!response.ok) {
		throw new ProviderDataError(
			`OpenRouter preflight failed: HTTP ${response.status}`,
			`http${response.status}`,
			parseRetryAfter(response.headers.get("retry-after"), context.now()),
			response.status,
		);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new ProviderDataError("OpenRouter preflight returned invalid JSON", "badjson");
	}
	if (!isRecord(payload) || !isRecord(payload.data) || typeof payload.data.label !== "string") {
		throw new ProviderDataError("OpenRouter preflight returned an invalid key response", "badjson");
	}
	return response.status;
}

export const openRouterPreflightAdapter: PreflightAdapter = {
	id: "openrouter-preflight",
	providerId: "openrouter",
	name: "OpenRouter",
	cacheTtlMs: 30_000,
	requestTimeoutMs: 8_000,
	async fetch(context) {
		const modelIds = await collectModelIds(context);
		const apiKey = await context.getApiKey();
		const checks: string[] = ["endpoint", "catalog"];
		if (!apiKey || apiKey === "proxy-managed") {
			return { passed: modelIds.has(context.model.id), checks: [...checks, "auth"], updatedAt: context.now() };
		}
		// Management keys use /api/v1/credits as the only key endpoint and get 404 here.
		const authStatus = await checkCredential(context, apiKey);
		const authPassed = authStatus !== 404;
		checks.push("auth");
		return {
			passed: modelIds.has(context.model.id) && authPassed,
			checks,
			updatedAt: context.now(),
		};
	},
};

export function createOpenRouterPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...openRouterPreflightAdapter, requestTimeoutMs };
}

const openRouterPreflightExtension = definePreflightExtension({
	id: "openrouter-preflight",
	providerId: "openrouter",
	create: ({ statusRequestTimeoutMs }) => createOpenRouterPreflightAdapter(statusRequestTimeoutMs),
});

export default openRouterPreflightExtension;
