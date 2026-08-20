/** Shared helpers for Provider-agnostic, OpenAI-style model-catalog checks. */

import { ProviderDataError } from "./errors.ts";
import type { PreflightAdapter } from "./preflight-manager.ts";
import { parseRetryAfter } from "./retry-after.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface CatalogPreflightConfig {
	id: string;
	providerId: string;
	name: string;
	modelsUrl: string;
	/**
	 * Key header name such as "x-goog-api-key" or "x-api-key". When set, the
	 * key-only header is used. Defaults to Authorization Bearer.
	 */
	keyHeader?: string;
	/**
	 * Provider-specific authentication for dual-mode providers. When set it
	 * decides the request auth headers from the resolved credential type.
	 */
	authHeaders?: (apiKey: string, credential: string | undefined) => Record<string, string>;
	/** Additional static headers such as {"anthropic-version": "2023-06-01"}. */
	headers?: Record<string, string>;
	/** Filter for usable entries; defaults to accepting every record with a non-empty `id`. */
	include?: (model: Record<string, unknown>) => boolean;
	/** Credentials are required; when false (mock), the check drops "auth". */
	requireAuth?: boolean;
}

export function createCatalogPreflightAdapter(
	config: CatalogPreflightConfig,
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
			const credential = context.getCredentialType
				? await context.getCredentialType().catch(() => undefined)
				: undefined;
			const headers: Record<string, string> = {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				...(config.headers ?? {}),
			};
			if (apiKey && apiKey !== "proxy-managed") {
				if (config.authHeaders) {
					Object.assign(headers, config.authHeaders(apiKey, credential));
				} else if (config.keyHeader) {
					headers[config.keyHeader] = apiKey;
				} else {
					headers.Authorization = `Bearer ${apiKey}`;
				}
			}
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
					.filter((model) => config.include?.(model) ?? true)
					.map((model) => (typeof model.id === "string" ? model.id.trim() : undefined))
					.filter((id): id is string => id !== undefined && id !== ""),
			);
			const checks = config.requireAuth === false ? ["endpoint", "catalog"] : ["endpoint", "catalog", "auth"];
			return {
				passed: modelIds.has(context.model.id),
				checks,
				updatedAt: context.now(),
				httpStatus: response.status,
			};
		},
	};
}

/** Recognize the dependencies mock tag "mock" as a placeholder key. */
export function isUsableApiKey(apiKey: string | undefined): apiKey is string {
	return apiKey !== undefined && apiKey !== "" && apiKey !== "proxy-managed" && apiKey !== "mock";
}

export function collectCatalogIds(
	payload: unknown,
	include?: (model: Record<string, unknown>) => boolean,
): Set<string> {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new ProviderDataError("Catalog response returned invalid catalog data", "badjson");
	}
	return new Set(
		payload.data
			.filter(isRecord)
			.filter((model) => include?.(model) ?? true)
			.map((model) => (typeof model.id === "string" ? model.id.trim() : undefined))
			.filter((id): id is string => id !== undefined && id !== ""),
	);
}

/**
 * Workspace endpoint selected from the model's own baseUrl. Returns undefined
 * when the convention cannot be resolved (e.g. Anthropic base without /v1).
 */
export function workspaceModelsUrl(modelBaseUrl: string | undefined): string | undefined {
	if (!modelBaseUrl) return undefined;
	const trimmed = modelBaseUrl.replace(/\/+$/, "");
	if (trimmed.startsWith("https://api.anthropic.com")) return `${trimmed}/v1/models`;
	if (trimmed.includes("/v1")) return `${trimmed}/models`;
	return undefined;
}
