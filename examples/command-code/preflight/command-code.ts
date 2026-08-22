import type { PreflightAdapter } from "@hyav/pi-provider";
import { createOpenCodeCatalogPreflightAdapter, definePreflightExtension } from "@hyav/pi-provider";
import { syncCommandCodeEnv } from "../providers/command-code/auth.ts";
import {
	COMMAND_CODE_MODELS_URL,
	COMMAND_CODE_PROVIDER_ID,
	COMMAND_CODE_PROVIDER_NAME,
} from "../providers/command-code/catalog.ts";

export function createCommandCodePreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	syncCommandCodeEnv();
	return createOpenCodeCatalogPreflightAdapter(
		{
			id: `${COMMAND_CODE_PROVIDER_ID}-preflight`,
			providerId: COMMAND_CODE_PROVIDER_ID,
			name: COMMAND_CODE_PROVIDER_NAME,
			modelsUrl: COMMAND_CODE_MODELS_URL,
		},
		requestTimeoutMs,
	);
}

export const commandCodePreflightAdapter = createCommandCodePreflightAdapter(8_000);

const commandCodePreflightExtension = definePreflightExtension({
	id: `${COMMAND_CODE_PROVIDER_ID}-preflight`,
	providerId: COMMAND_CODE_PROVIDER_ID,
	create: ({ statusRequestTimeoutMs }) => createCommandCodePreflightAdapter(statusRequestTimeoutMs),
});

export default commandCodePreflightExtension;
