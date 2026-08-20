import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension } from "@hyav/pi-provider";
import { createCatalogPreflightAdapter } from "../core/catalog-preflight.ts";
import { isAnthropicApiKey } from "../status/anthropic.ts";

export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
export const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * Anthropic accepts API keys via x-api-key and short-lived OAuth/WIF tokens via
 * Authorization Bearer. Only the user's own default clause receives the key, no
 * unknown/third-party endpoint.
 */
function anthropicAuthHeaders(apiKey: string, credential: string | undefined): Record<string, string> {
	if (credential === "oauth" && !isAnthropicApiKey(apiKey)) return { Authorization: `Bearer ${apiKey}` };
	return { "x-api-key": apiKey };
}

export const anthropicPreflightAdapter: PreflightAdapter = createCatalogPreflightAdapter(
	{
		id: "anthropic-preflight",
		providerId: "anthropic",
		name: "Anthropic",
		modelsUrl: ANTHROPIC_MODELS_URL,
		headers: { "anthropic-version": ANTHROPIC_API_VERSION },
		authHeaders: anthropicAuthHeaders,
	},
	8_000,
);

export function createAnthropicPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...anthropicPreflightAdapter, requestTimeoutMs };
}

const anthropicPreflightExtension = definePreflightExtension({
	id: "anthropic-preflight",
	providerId: "anthropic",
	create: ({ statusRequestTimeoutMs }) => createAnthropicPreflightAdapter(statusRequestTimeoutMs),
});

export default anthropicPreflightExtension;
