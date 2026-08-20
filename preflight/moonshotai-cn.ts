import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension } from "@hyav/pi-provider";
import { createMoonshotPreflightAdapter, MOONSHOT_CN_MODELS_URL } from "./moonshotai.ts";

export const moonshotaiCnPreflightAdapter: PreflightAdapter = createMoonshotPreflightAdapter(
	MOONSHOT_CN_MODELS_URL,
	8_000,
	"moonshotai-cn-preflight",
	"moonshotai-cn",
);

export function createMoonshotaiCnPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return createMoonshotPreflightAdapter(
		MOONSHOT_CN_MODELS_URL,
		requestTimeoutMs,
		"moonshotai-cn-preflight",
		"moonshotai-cn",
	);
}

const moonshotaiCnPreflightExtension = definePreflightExtension({
	id: "moonshotai-cn-preflight",
	providerId: "moonshotai-cn",
	create: ({ statusRequestTimeoutMs }) => createMoonshotaiCnPreflightAdapter(statusRequestTimeoutMs),
});

export default moonshotaiCnPreflightExtension;
