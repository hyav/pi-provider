import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";
import { extractCodexAccountId } from "../status/openai-codex.ts";

export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
export const CODEX_MODELS_CLIENT_VERSION = "0.144.1";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codexModelIds(payload: unknown): Set<string> {
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw new ProviderDataError("OpenAI Codex preflight returned invalid catalog data", "badjson");
	}
	return new Set(
		payload.models
			.filter(isRecord)
			.filter((model) => model.visibility === "list" && model.supported_in_api !== false)
			.map((model) => (typeof model.slug === "string" ? model.slug.trim() : undefined))
			.filter((id): id is string => id !== undefined && id !== ""),
	);
}

export const openAICodexPreflightAdapter: PreflightAdapter = {
	id: "openai-codex-preflight",
	providerId: "openai-codex",
	name: "OpenAI Codex",
	cacheTtlMs: 30_000,
	requestTimeoutMs: 8_000,
	async fetch(context) {
		const apiKey = await context.getApiKey();
		if (!apiKey || apiKey === "proxy-managed") {
			return { passed: false, checks: ["auth"], updatedAt: context.now() };
		}
		const accountId = extractCodexAccountId(apiKey);
		if (!accountId) {
			throw new ProviderDataError("OpenAI Codex OAuth token has no account ID", "auth");
		}
		const url = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(CODEX_MODELS_CLIENT_VERSION)}`;
		const response = await context.fetch(url, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				Authorization: `Bearer ${apiKey}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
				"User-Agent": "@hyav/pi-provider",
			},
			signal: context.signal,
		});
		if (!response.ok) {
			throw new ProviderDataError(
				`OpenAI Codex preflight failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("OpenAI Codex preflight returned invalid JSON", "badjson");
		}
		const modelIds = codexModelIds(payload);
		return {
			passed: modelIds.has(context.model.id),
			checks: ["endpoint", "auth", "catalog"],
			updatedAt: context.now(),
			httpStatus: response.status,
		};
	},
};

export function createOpenAICodexPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...openAICodexPreflightAdapter, requestTimeoutMs };
}

const openAICodexPreflightExtension = definePreflightExtension({
	id: "openai-codex-preflight",
	providerId: "openai-codex",
	create: ({ statusRequestTimeoutMs }) => createOpenAICodexPreflightAdapter(statusRequestTimeoutMs),
});

export default openAICodexPreflightExtension;
