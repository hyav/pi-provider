import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension } from "@hyav/pi-provider";
import { createCatalogPreflightAdapter } from "../core/catalog-preflight.ts";

export const CEREBRAS_MODELS_URL = "https://api.cerebras.ai/v1/models";

export const cerebrasPreflightAdapter: PreflightAdapter = createCatalogPreflightAdapter(
	{
		id: "cerebras-preflight",
		providerId: "cerebras",
		name: "Cerebras",
		modelsUrl: CEREBRAS_MODELS_URL,
	},
	8_000,
);

export function createCerebrasPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...cerebrasPreflightAdapter, requestTimeoutMs };
}

const cerebrasPreflightExtension = definePreflightExtension({
	id: "cerebras-preflight",
	providerId: "cerebras",
	create: ({ statusRequestTimeoutMs }) => createCerebrasPreflightAdapter(statusRequestTimeoutMs),
});

export default cerebrasPreflightExtension;
