import type { StatusAdapter } from "@hyav/pi-provider";
import { defineStatusExtension } from "@hyav/pi-provider";
import { createMoonshotStatusAdapter, MOONSHOT_CN_BALANCE_URL } from "./moonshotai.ts";

export const moonshotaiCnStatusAdapter: StatusAdapter = createMoonshotStatusAdapter(
	{
		id: "moonshotai-cn-status",
		providerId: "moonshotai-cn",
		name: "Moonshot CN (Kimi)",
		balanceUrl: MOONSHOT_CN_BALANCE_URL,
	},
	8_000,
);

export function createMoonshotaiCnStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...moonshotaiCnStatusAdapter, requestTimeoutMs };
}

const moonshotaiCnStatusExtension = defineStatusExtension({
	id: "moonshotai-cn-status",
	providerId: "moonshotai-cn",
	create: ({ statusRequestTimeoutMs }) => createMoonshotaiCnStatusAdapter(statusRequestTimeoutMs),
});

export default moonshotaiCnStatusExtension;
