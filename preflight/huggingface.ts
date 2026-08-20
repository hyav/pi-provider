import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension } from "@hyav/pi-provider";
import { createCatalogPreflightAdapter } from "../core/catalog-preflight.ts";

export const HF_ROUTER_MODELS_URL = "https://router.huggingface.co/v1/models";

export const huggingFacePreflightAdapter: PreflightAdapter = createCatalogPreflightAdapter(
	{
		id: "huggingface-preflight",
		providerId: "huggingface",
		name: "Hugging Face",
		modelsUrl: HF_ROUTER_MODELS_URL,
	},
	8_000,
);

export function createHuggingFacePreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...huggingFacePreflightAdapter, requestTimeoutMs };
}

const huggingFacePreflightExtension = definePreflightExtension({
	id: "huggingface-preflight",
	providerId: "huggingface",
	create: ({ statusRequestTimeoutMs }) => createHuggingFacePreflightAdapter(statusRequestTimeoutMs),
});

export default huggingFacePreflightExtension;
