import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension } from "@hyav/pi-provider";
import { createCatalogPreflightAdapter } from "../core/catalog-preflight.ts";

export const MISTRAL_MODELS_URL = "https://api.mistral.ai/v1/models";

export const mistralPreflightAdapter: PreflightAdapter = createCatalogPreflightAdapter(
	{
		id: "mistral-preflight",
		providerId: "mistral",
		name: "Mistral",
		modelsUrl: MISTRAL_MODELS_URL,
	},
	8_000,
);

export function createMistralPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...mistralPreflightAdapter, requestTimeoutMs };
}

const mistralPreflightExtension = definePreflightExtension({
	id: "mistral-preflight",
	providerId: "mistral",
	create: ({ statusRequestTimeoutMs }) => createMistralPreflightAdapter(statusRequestTimeoutMs),
});

export default mistralPreflightExtension;
