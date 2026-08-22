import type { StatusAdapter, StatusEntry, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError } from "@hyav/pi-provider";
import { resolveCommandCodeApiKey } from "../providers/command-code/auth.ts";
import { COMMAND_CODE_PROVIDER_ID, COMMAND_CODE_PROVIDER_NAME } from "../providers/command-code/catalog.ts";

export const COMMAND_CODE_USAGE_ENDPOINTS = [
	"https://api.commandcode.ai/api/usage",
	"https://api.commandcode.ai/provider/v1/user",
	"https://api.commandcode.ai/provider/v1/usage",
	"https://api.commandcode.ai/user/balance",
	"https://commandcode.ai/api/usage",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFiniteAmount(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseCommandCodeUsage(payload: unknown): StatusEntry[] | undefined {
	if (!isRecord(payload)) return undefined;

	const entries: StatusEntry[] = [];

	// Plan type
	if (typeof payload.plan === "string" && payload.plan.trim() !== "") {
		entries.push({
			kind: "text",
			id: "plan",
			label: "Plan",
			value: payload.plan.trim(),
		});
	} else if (typeof payload.planType === "string" && payload.planType.trim() !== "") {
		entries.push({
			kind: "text",
			id: "plan",
			label: "Plan",
			value: payload.planType.trim(),
		});
	}

	// Balance / Credits
	const balance =
		parseFiniteAmount(payload.balance) ??
		parseFiniteAmount(payload.credits) ??
		parseFiniteAmount(payload.remaining) ??
		parseFiniteAmount(payload.total_balance);

	if (balance !== undefined) {
		const unit =
			typeof payload.currency === "string"
				? payload.currency.trim()
				: typeof payload.unit === "string"
					? payload.unit.trim()
					: "USD";
		entries.push({
			kind: "amount",
			id: "balance",
			label: "Balance",
			value: balance,
			unit,
		});
	}

	// Usage window / percent
	const usagePercent =
		parseFiniteAmount(payload.usedPercent) ??
		parseFiniteAmount(payload.usage_percent) ??
		parseFiniteAmount(payload.used_percent);

	if (usagePercent !== undefined && usagePercent >= 0 && usagePercent <= 100) {
		const resetAt =
			typeof payload.resetAt === "number"
				? payload.resetAt
				: typeof payload.reset_at === "number"
					? payload.reset_at * (payload.reset_at < 1e11 ? 1000 : 1)
					: undefined;
		entries.push({
			kind: "window",
			id: "usage-window",
			label: "Usage",
			remainingPercent: Math.max(0, Math.min(100, 100 - usagePercent)),
			...(resetAt ? { resetAt } : {}),
		});
	}

	return entries.length > 0 ? entries : undefined;
}

export function createCommandCodeStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return {
		id: `${COMMAND_CODE_PROVIDER_ID}-status`,
		providerId: COMMAND_CODE_PROVIDER_ID,
		name: COMMAND_CODE_PROVIDER_NAME,
		cacheTtlMs: 60_000,
		requestTimeoutMs,
		async fetch(context): Promise<StatusSnapshot> {
			let key = await context.getApiKey();
			if (!key || key === "proxy-managed") {
				key = resolveCommandCodeApiKey();
			}

			if (!key || key === "proxy-managed") {
				throw new ProviderDataError(`${COMMAND_CODE_PROVIDER_NAME} status requires an API key`, "auth");
			}

			// Try endpoints sequentially with timeout & error handling
			for (const url of COMMAND_CODE_USAGE_ENDPOINTS) {
				try {
					const response = await context.fetch(url, {
						headers: {
							Accept: "application/json",
							"Accept-Encoding": "identity",
							Authorization: `Bearer ${key}`,
						},
						signal: context.signal,
					});

					if (response.status === 401 || response.status === 403) {
						throw new ProviderDataError(
							`${COMMAND_CODE_PROVIDER_NAME} authentication failed: HTTP ${response.status}`,
							"auth",
						);
					}

					if (response.ok) {
						let payload: unknown;
						try {
							payload = await response.json();
						} catch {
							continue;
						}

						const entries = parseCommandCodeUsage(payload);
						if (entries && entries.length > 0) {
							return {
								entries,
								updatedAt: context.now(),
							};
						}
					}
				} catch (error) {
					if (error instanceof ProviderDataError && error.code === "auth") {
						throw error;
					}
					// Otherwise try next candidate endpoint
				}
			}

			// Graceful fallback when internal usage endpoint is unavailable or WAF protected
			return {
				entries: [
					{
						kind: "text",
						id: "status",
						label: "Account",
						value: "Active",
					},
					{
						kind: "text",
						id: "usage",
						label: "Usage",
						value: "Web Console only",
					},
				],
				updatedAt: context.now(),
			};
		},
	};
}

export const commandCodeStatusAdapter = createCommandCodeStatusAdapter(8_000);

const commandCodeStatusExtension = defineStatusExtension({
	id: `${COMMAND_CODE_PROVIDER_ID}-status`,
	providerId: COMMAND_CODE_PROVIDER_ID,
	create: ({ statusRequestTimeoutMs }) => createCommandCodeStatusAdapter(statusRequestTimeoutMs),
});

export default commandCodeStatusExtension;
