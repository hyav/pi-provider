import type { PreflightAdapter } from "@hyav/pi-provider";
import {
	definePreflightExtension,
	hasBaseUrlOrigin,
	MAX_PROVIDER_MODEL_COUNT,
	ProviderDataError,
	parseRetryAfter,
} from "@hyav/pi-provider";
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
	supportsModel: (model) => hasBaseUrlOrigin(model.baseUrl, XAI_MODELS_URL),
	async fetch(context) {
		const apiKey = await context.getApiKey();
		if (!apiKey || apiKey === "proxy-managed") {
			// xAI authenticates every route, including /v1/models, so without a
			// credential the catalog request cannot succeed. Fail closed instead
			// of reporting a catalog match as a usable model.
			return { passed: false, checks: ["auth"], updatedAt: context.now() };
		}
		const authHeaders: Record<string, string> = {
			Accept: "application/json",
			"Accept-Encoding": "identity",
			"User-Agent": "@hyav/pi-provider",
			Authorization: `Bearer ${apiKey}`,
		};
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
		if (payload.data.length > MAX_PROVIDER_MODEL_COUNT) {
			throw new ProviderDataError("xAI preflight catalog exceeds the maximum model count", "badjson");
		}
		const modelIds = new Set(
			payload.data
				.filter(isRecord)
				.map((model) => (typeof model.id === "string" ? model.id.trim() : undefined))
				.filter((id): id is string => id !== undefined && id !== ""),
		);
		return {
			passed: modelIds.has(context.model.id),
			checks: ["endpoint", "catalog", "auth"],
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
