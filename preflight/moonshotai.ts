import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension } from "@hyav/pi-provider";
import { createCatalogPreflightAdapter } from "../core/catalog-preflight.ts";

export const MOONSHOT_MODELS_URL = "https://api.moonshot.ai/v1/models";
export const MOONSHOT_CN_MODELS_URL = "https://api.moonshot.cn/v1/models";

export function createMoonshotPreflightAdapter(
	modelsUrl: string,
	requestTimeoutMs: number,
	id: "moonshotai-preflight" | "moonshotai-cn-preflight" = "moonshotai-preflight",
	providerId: "moonshotai" | "moonshotai-cn" = "moonshotai",
): PreflightAdapter {
	return createCatalogPreflightAdapter(
		{
			id,
			providerId,
			name: providerId === "moonshotai-cn" ? "Moonshot CN (Kimi)" : "Moonshot (Kimi)",
			modelsUrl,
		},
		requestTimeoutMs,
	);
}

export const moonshotaiPreflightAdapter = createMoonshotPreflightAdapter(MOONSHOT_MODELS_URL, 8_000);

export function createMoonshotaiPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...moonshotaiPreflightAdapter, requestTimeoutMs };
}

const moonshotaiPreflightExtension = definePreflightExtension({
	id: "moonshotai-preflight",
	providerId: "moonshotai",
	create: ({ statusRequestTimeoutMs }) => createMoonshotPreflightAdapter(MOONSHOT_MODELS_URL, statusRequestTimeoutMs),
});

export default moonshotaiPreflightExtension;
