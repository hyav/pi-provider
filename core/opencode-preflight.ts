import { ProviderDataError } from "../core/errors.ts";
import type { PreflightAdapter } from "../core/preflight-manager.ts";
import { parseRetryAfter } from "../core/retry-after.ts";

interface OpenCodePreflightConfig {
	id: string;
	providerId: string;
	name: string;
	modelsUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createOpenCodeCatalogPreflightAdapter(
	config: OpenCodePreflightConfig,
	requestTimeoutMs: number,
): PreflightAdapter {
	return {
		id: config.id,
		providerId: config.providerId,
		name: config.name,
		cacheTtlMs: 30_000,
		requestTimeoutMs,
		async fetch(context) {
			const apiKey = await context.getApiKey();
			const headers: Record<string, string> = {
				Accept: "application/json",
				"Accept-Encoding": "identity",
			};
			if (apiKey && apiKey !== "proxy-managed") headers.Authorization = `Bearer ${apiKey}`;

			const response = await context.fetch(config.modelsUrl, { headers, signal: context.signal });
			if (!response.ok) {
				throw new ProviderDataError(
					`${config.name} preflight failed: HTTP ${response.status}`,
					`http${response.status}`,
					parseRetryAfter(response.headers.get("retry-after"), context.now()),
					response.status,
				);
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new ProviderDataError(`${config.name} preflight returned invalid JSON`, "badjson");
			}
			if (!isRecord(payload) || !Array.isArray(payload.data)) {
				throw new ProviderDataError(`${config.name} preflight returned invalid catalog data`, "badjson");
			}
			const modelIds = new Set(
				payload.data
					.filter(isRecord)
					.map((model) => (typeof model.id === "string" ? model.id.trim() : undefined))
					.filter((id): id is string => id !== undefined && id !== ""),
			);
			return {
				passed: modelIds.has(context.model.id),
				checks: ["endpoint", "catalog"],
				updatedAt: context.now(),
				httpStatus: response.status,
			};
		},
	};
}
