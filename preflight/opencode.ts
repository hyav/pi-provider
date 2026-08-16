import type { PreflightAdapter } from "@hyav/pi-provider";
import { createOpenCodeCatalogPreflightAdapter, definePreflightExtension } from "@hyav/pi-provider";

export const OPENCODE_MODELS_URL = "https://opencode.ai/zen/v1/models";

export function createOpenCodePreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return createOpenCodeCatalogPreflightAdapter(
		{
			id: "opencode-preflight",
			providerId: "opencode",
			name: "OpenCode Zen",
			modelsUrl: OPENCODE_MODELS_URL,
		},
		requestTimeoutMs,
	);
}

export const openCodePreflightAdapter = createOpenCodePreflightAdapter(8_000);

const openCodePreflightExtension = definePreflightExtension({
	id: "opencode-preflight",
	providerId: "opencode",
	create: ({ statusRequestTimeoutMs }) => createOpenCodePreflightAdapter(statusRequestTimeoutMs),
});

export default openCodePreflightExtension;
