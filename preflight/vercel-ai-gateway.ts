import type { PreflightAdapter, PreflightSnapshot } from "@hyav/pi-provider";
import { definePreflightExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";
import { VERCEL_PROVIDER_ID } from "../core/vercel-constants.ts";

export const VERCEL_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseVercelModelIds(payload: unknown): Set<string> {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new ProviderDataError("Vercel AI Gateway preflight returned invalid catalog data", "badjson");
	}

	const modelIds = new Set<string>();
	for (const value of payload.data) {
		if (!isRecord(value)) continue;
		// Mixed-type gateway catalogs can include non-language entries.
		if (value.type !== undefined && value.type !== "language") continue;
		if (typeof value.id !== "string") continue;
		const id = value.id.trim();
		if (id !== "") modelIds.add(id);
	}

	if (modelIds.size === 0) {
		throw new ProviderDataError("Vercel AI Gateway preflight returned an empty catalog", "badjson");
	}
	return modelIds;
}

export function createVercelAIGatewayPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return {
		id: "vercel-ai-gateway-preflight",
		providerId: VERCEL_PROVIDER_ID,
		name: "Vercel AI Gateway",
		cacheTtlMs: 30_000,
		requestTimeoutMs,
		async fetch(context): Promise<PreflightSnapshot> {
			const key = await context.getApiKey();
			if (!key || key === "proxy-managed") {
				return { passed: false, checks: ["auth"], updatedAt: context.now() };
			}

			const response = await context.fetch(VERCEL_MODELS_URL, {
				headers: {
					Accept: "application/json",
					"Accept-Encoding": "identity",
				},
				signal: context.signal,
			});
			if (!response.ok) {
				throw new ProviderDataError(
					`Vercel AI Gateway preflight failed: HTTP ${response.status}`,
					`http${response.status}`,
					parseRetryAfter(response.headers.get("retry-after"), context.now()),
					response.status,
				);
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new ProviderDataError("Vercel AI Gateway preflight returned invalid JSON", "badjson");
			}

			return {
				passed: parseVercelModelIds(payload).has(context.model.id),
				checks: ["endpoint", "auth", "catalog"],
				updatedAt: context.now(),
				httpStatus: response.status,
			};
		},
	};
}

export const vercelAIGatewayPreflightAdapter = createVercelAIGatewayPreflightAdapter(8_000);

const vercelAIGatewayPreflightExtension = definePreflightExtension({
	id: "vercel-ai-gateway-preflight",
	providerId: VERCEL_PROVIDER_ID,
	create: ({ statusRequestTimeoutMs }) => createVercelAIGatewayPreflightAdapter(statusRequestTimeoutMs),
});

export default vercelAIGatewayPreflightExtension;
