import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension } from "@hyav/pi-provider";
import { createCatalogPreflightAdapter } from "../core/catalog-preflight.ts";

export const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

export const nvidiaPreflightAdapter: PreflightAdapter = createCatalogPreflightAdapter(
	{
		id: "nvidia-preflight",
		providerId: "nvidia",
		name: "NVIDIA NIM",
		modelsUrl: NVIDIA_MODELS_URL,
	},
	8_000,
);

export function createNvidiaPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...nvidiaPreflightAdapter, requestTimeoutMs };
}

const nvidiaPreflightExtension = definePreflightExtension({
	id: "nvidia-preflight",
	providerId: "nvidia",
	create: ({ statusRequestTimeoutMs }) => createNvidiaPreflightAdapter(statusRequestTimeoutMs),
});

export default nvidiaPreflightExtension;
