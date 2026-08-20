import type { StatusAdapter, StatusEntry, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";

/**
 * Moonshot (Kimi) balance checks. International and China platforms keep
 * fully independent API keys; the same response shape is shared by both
 * endpoints, so the adapter body is factored once.
 */
export const MOONSHOT_BALANCE_URL = "https://api.moonshot.ai/v1/users/me/balance";
export const MOONSHOT_CN_BALANCE_URL = "https://api.moonshot.cn/v1/users/me/balance";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface MoonshotBalance {
	available: number;
	voucher?: number;
	cash?: number;
}

export function parseMoonshotBalance(payload: unknown): MoonshotBalance {
	if (!isRecord(payload) || !isRecord(payload.data)) {
		throw new ProviderDataError("Moonshot status returned an invalid balance response", "badjson");
	}
	const code = payload.code;
	if (code !== 0 && code !== undefined) {
		throw new ProviderDataError("Moonshot status returned an unsuccessful balance response", "provider");
	}
	const available = finiteNumber(payload.data.available_balance);
	if (available === undefined) {
		throw new ProviderDataError("Moonshot status returned an invalid balance response", "badjson");
	}
	const voucher = finiteNumber(payload.data.voucher_balance);
	const cash = finiteNumber(payload.data.cash_balance);
	// Voucher balances are documented as non-negative; cash may be negative.
	if (voucher !== undefined && voucher < 0) {
		throw new ProviderDataError("Moonshot status returned an invalid balance response", "badjson");
	}
	return {
		available,
		...(voucher !== undefined ? { voucher } : {}),
		...(cash !== undefined ? { cash } : {}),
	};
}

export interface MoonshotStatusConfig {
	id: string;
	providerId: string;
	name: string;
	balanceUrl: string;
	/** Official docs: international balances are USD; China balances are CNY. */
	unit: string;
}

export function createMoonshotStatusAdapter(config: MoonshotStatusConfig, requestTimeoutMs: number): StatusAdapter {
	const unit = config.unit;
	return {
		id: config.id,
		providerId: config.providerId,
		name: config.name,
		cacheTtlMs: 60_000,
		requestTimeoutMs,
		async fetch(context): Promise<StatusSnapshot> {
			const key = await context.getApiKey();
			if (!key || key === "proxy-managed") {
				throw new ProviderDataError(`${config.name} status requires an API key`, "auth");
			}
			const response = await context.fetch(config.balanceUrl, {
				headers: {
					Accept: "application/json",
					"Accept-Encoding": "identity",
					Authorization: `Bearer ${key}`,
					"User-Agent": "@hyav/pi-provider",
				},
				signal: context.signal,
			});
			if (!response.ok) {
				throw new ProviderDataError(
					`${config.name} status failed: HTTP ${response.status}`,
					`http${response.status}`,
					parseRetryAfter(response.headers.get("retry-after"), context.now()),
					response.status,
				);
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new ProviderDataError(`${config.name} status returned invalid JSON`, "badjson");
			}
			const balance = parseMoonshotBalance(payload);
			const entries: StatusEntry[] = [
				{
					kind: "amount",
					id: "available-balance",
					label: "Available balance",
					value: balance.available,
					unit,
				},
			];
			if (balance.voucher !== undefined) {
				entries.push({
					kind: "amount",
					id: "voucher-balance",
					label: "Voucher balance",
					value: balance.voucher,
					unit,
				});
			}
			if (balance.cash !== undefined) {
				entries.push({
					kind: "amount",
					id: "cash-balance",
					label: "Cash balance",
					value: balance.cash,
					unit,
				});
			}
			return { entries, updatedAt: context.now() };
		},
	};
}

export const moonshotaiStatusAdapter = createMoonshotStatusAdapter(
	{
		id: "moonshotai-status",
		providerId: "moonshotai",
		name: "Moonshot (Kimi)",
		balanceUrl: MOONSHOT_BALANCE_URL,
		unit: "USD",
	},
	8_000,
);

export function createMoonshotaiStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...moonshotaiStatusAdapter, requestTimeoutMs };
}

const moonshotaiStatusExtension = defineStatusExtension({
	id: "moonshotai-status",
	providerId: "moonshotai",
	create: ({ statusRequestTimeoutMs }) => createMoonshotaiStatusAdapter(statusRequestTimeoutMs),
});

export default moonshotaiStatusExtension;
