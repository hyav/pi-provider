import type { PreflightAdapter } from "@hyav/pi-provider";
import { createOpenCodeCatalogPreflightAdapter, definePreflightExtension } from "@hyav/pi-provider";

export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

export function createOpenCodeGoPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return createOpenCodeCatalogPreflightAdapter(
		{
			id: "opencode-go-preflight",
			providerId: "opencode-go",
			name: "OpenCode Go",
			modelsUrl: OPENCODE_GO_MODELS_URL,
		},
		requestTimeoutMs,
	);
}

export const openCodeGoPreflightAdapter = createOpenCodeGoPreflightAdapter(8_000);

const openCodeGoPreflightExtension = definePreflightExtension({
	id: "opencode-go-preflight",
	providerId: "opencode-go",
	create: ({ statusRequestTimeoutMs }) => createOpenCodeGoPreflightAdapter(statusRequestTimeoutMs),
});

export default openCodeGoPreflightExtension;
