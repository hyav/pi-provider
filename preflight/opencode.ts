import { definePreflightExtension } from "../core/adapter-extensions.ts";
import { createOpenCodeCatalogPreflightAdapter } from "../core/opencode-preflight.ts";
import type { PreflightAdapter } from "../core/preflight-manager.ts";

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
