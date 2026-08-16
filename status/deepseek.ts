import type { StatusAdapter, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

interface DeepSeekBalanceInfo {
	currency: string;
	totalBalance: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFiniteAmount(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseDeepSeekBalance(payload: unknown): DeepSeekBalanceInfo[] {
	if (!isRecord(payload) || !Array.isArray(payload.balance_infos)) {
		throw new ProviderDataError("DeepSeek status returned an invalid balance response", "badjson");
	}
	return payload.balance_infos.map((value) => {
		if (!isRecord(value) || typeof value.currency !== "string" || value.currency.trim() === "") {
			throw new ProviderDataError("DeepSeek status returned an invalid balance response", "badjson");
		}
		const totalBalance = parseFiniteAmount(value.total_balance);
		if (totalBalance === undefined || /[\u0000-\u001f\u007f]/.test(value.currency)) {
			throw new ProviderDataError("DeepSeek status returned an invalid balance response", "badjson");
		}
		return { currency: value.currency.trim(), totalBalance };
	});
}

export const deepSeekStatusAdapter: StatusAdapter = {
	id: "deepseek-status",
	providerId: "deepseek",
	name: "DeepSeek",
	cacheTtlMs: 30_000,
	requestTimeoutMs: 8_000,
	async fetch(context): Promise<StatusSnapshot> {
		const key = await context.getApiKey();
		if (!key || key === "proxy-managed") {
			throw new ProviderDataError("DeepSeek status requires an API key", "auth");
		}
		const response = await context.fetch(DEEPSEEK_BALANCE_URL, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				Authorization: `Bearer ${key}`,
			},
			signal: context.signal,
		});
		if (!response.ok) {
			throw new ProviderDataError(
				`DeepSeek status failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("DeepSeek status returned invalid JSON", "badjson");
		}
		const balances = parseDeepSeekBalance(payload);
		const balance = balances.find(({ currency }) => currency === "USD") ?? balances[0];
		return {
			entries: balance
				? [
						{
							kind: "amount",
							id: "balance",
							label: "Balance",
							value: balance.totalBalance,
							unit: balance.currency,
						},
					]
				: [{ kind: "text", id: "balance", label: "Balance", value: "not available" }],
			updatedAt: context.now(),
		};
	},
};

export function createDeepSeekStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...deepSeekStatusAdapter, requestTimeoutMs };
}

const deepSeekStatusExtension = defineStatusExtension({
	id: "deepseek-status",
	providerId: "deepseek",
	create: ({ statusRequestTimeoutMs }) => createDeepSeekStatusAdapter(statusRequestTimeoutMs),
});

export default deepSeekStatusExtension;
