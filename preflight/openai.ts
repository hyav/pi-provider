import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension } from "@hyav/pi-provider";
import { createCatalogPreflightAdapter } from "../core/catalog-preflight.ts";

export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

export const openAIPreflightAdapter: PreflightAdapter = createCatalogPreflightAdapter(
	{
		id: "openai-preflight",
		providerId: "openai",
		name: "OpenAI",
		modelsUrl: OPENAI_MODELS_URL,
	},
	8_000,
);

export function createOpenAIPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...openAIPreflightAdapter, requestTimeoutMs };
}

const openAIPreflightExtension = definePreflightExtension({
	id: "openai-preflight",
	providerId: "openai",
	create: ({ statusRequestTimeoutMs }) => createOpenAIPreflightAdapter(statusRequestTimeoutMs),
});

export default openAIPreflightExtension;
