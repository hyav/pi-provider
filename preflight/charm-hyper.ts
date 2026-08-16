import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";
import { hyperJsonHeaders } from "../providers/charm-hyper/constants.ts";
import { HYPER_MODELS_URL, HYPER_PROVIDER_URL, parseHyperModels } from "../providers/charm-hyper.ts";

export function createCharmHyperPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return {
		id: "charm-hyper-preflight",
		providerId: "charm-hyper",
		name: "Charm Hyper",
		cacheTtlMs: 30_000,
		requestTimeoutMs,
		async fetch(context) {
			const apiKey = await context.getApiKey();
			if (!apiKey) return { passed: false, checks: ["auth"], updatedAt: context.now() };
			const headers = new Headers(hyperJsonHeaders());
			if (apiKey !== "proxy-managed") headers.set("Authorization", `Bearer ${apiKey}`);
			let endpoint = HYPER_PROVIDER_URL;
			let response = await context.fetch(endpoint, { headers, signal: context.signal });
			if (response.status === 404) {
				endpoint = HYPER_MODELS_URL;
				response = await context.fetch(endpoint, { headers, signal: context.signal });
			}
			if (!response.ok) {
				throw new ProviderDataError(
					`Charm Hyper preflight failed: HTTP ${response.status}`,
					`http${response.status}`,
					parseRetryAfter(response.headers.get("retry-after"), context.now()),
					response.status,
				);
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new ProviderDataError(`Charm Hyper preflight returned invalid JSON from ${endpoint}`, "badjson");
			}
			const models = parseHyperModels(payload);
			if (models.length === 0) {
				throw new ProviderDataError("Charm Hyper preflight returned invalid catalog data", "badjson");
			}
			const modelIds = new Set(models.map(({ id }) => id.toLowerCase()));
			const modelMatched = modelIds.has(context.model.id.toLowerCase());
			return {
				passed: modelMatched,
				checks: ["endpoint", "auth", "catalog"],
				updatedAt: context.now(),
				httpStatus: response.status,
			};
		},
	};
}

const charmHyperPreflightExtension = definePreflightExtension({
	id: "charm-hyper-preflight",
	providerId: "charm-hyper",
	create: ({ statusRequestTimeoutMs }) => createCharmHyperPreflightAdapter(statusRequestTimeoutMs),
});

export default charmHyperPreflightExtension;
