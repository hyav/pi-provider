import { definePreflightExtension } from "../core/adapter-extensions.ts";
import { ProviderDataError } from "../core/errors.ts";
import type { PreflightAdapter } from "../core/preflight-manager.ts";
import { parseRetryAfter } from "../core/retry-after.ts";

export const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const deepSeekPreflightAdapter: PreflightAdapter = {
	id: "deepseek-preflight",
	providerId: "deepseek",
	name: "DeepSeek",
	cacheTtlMs: 30_000,
	requestTimeoutMs: 8_000,
	async fetch(context) {
		const apiKey = await context.getApiKey();
		if (!apiKey || apiKey === "proxy-managed") {
			return { passed: false, checks: ["auth"], updatedAt: context.now() };
		}
		const response = await context.fetch(DEEPSEEK_MODELS_URL, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				Authorization: `Bearer ${apiKey}`,
			},
			signal: context.signal,
		});
		if (!response.ok) {
			throw new ProviderDataError(
				`DeepSeek preflight failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("DeepSeek preflight returned invalid JSON", "badjson");
		}
		if (!isRecord(payload) || !Array.isArray(payload.data)) {
			throw new ProviderDataError("DeepSeek preflight returned invalid catalog data", "badjson");
		}
		const modelIds = new Set(
			payload.data
				.filter(isRecord)
				.map((model) => (typeof model.id === "string" ? model.id.trim() : undefined))
				.filter((id): id is string => id !== undefined && id !== ""),
		);
		return {
			passed: modelIds.has(context.model.id),
			checks: ["endpoint", "auth", "catalog"],
			updatedAt: context.now(),
			httpStatus: response.status,
		};
	},
};

export function createDeepSeekPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...deepSeekPreflightAdapter, requestTimeoutMs };
}

const deepSeekPreflightExtension = definePreflightExtension({
	id: "deepseek-preflight",
	providerId: "deepseek",
	create: ({ statusRequestTimeoutMs }) => createDeepSeekPreflightAdapter(statusRequestTimeoutMs),
});

export default deepSeekPreflightExtension;
