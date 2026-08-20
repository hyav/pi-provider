import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";
import { XAI_MODELS_URL } from "../status/xai.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const xaiPreflightAdapter: PreflightAdapter = {
	id: "xai-preflight",
	providerId: "xai",
	name: "xAI",
	cacheTtlMs: 30_000,
	requestTimeoutMs: 8_000,
	async fetch(context) {
		const apiKey = await context.getApiKey();
		const authHeaders: Record<string, string> = {
			Accept: "application/json",
			"Accept-Encoding": "identity",
			"User-Agent": "@hyav/pi-provider",
		};
		if (apiKey && apiKey !== "proxy-managed") authHeaders.Authorization = `Bearer ${apiKey}`;
		const response = await context.fetch(XAI_MODELS_URL, {
			headers: authHeaders,
			signal: context.signal,
		});
		if (!response.ok) {
			throw new ProviderDataError(
				`xAI preflight failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("xAI preflight returned invalid JSON", "badjson");
		}
		if (!isRecord(payload) || !Array.isArray(payload.data)) {
			throw new ProviderDataError("xAI preflight returned invalid catalog data", "badjson");
		}
		const modelIds = new Set(
			payload.data
				.filter(isRecord)
				.map((model) => (typeof model.id === "string" ? model.id.trim() : undefined))
				.filter((id): id is string => id !== undefined && id !== ""),
		);
		const checks = apiKey && apiKey !== "proxy-managed" ? ["endpoint", "catalog", "auth"] : ["endpoint", "catalog"];
		return {
			passed: modelIds.has(context.model.id),
			checks,
			updatedAt: context.now(),
			httpStatus: response.status,
		};
	},
};

export function createXaiPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...xaiPreflightAdapter, requestTimeoutMs };
}

const xaiPreflightExtension = definePreflightExtension({
	id: "xai-preflight",
	providerId: "xai",
	create: ({ statusRequestTimeoutMs }) => createXaiPreflightAdapter(statusRequestTimeoutMs),
});

export default xaiPreflightExtension;
