import type { StatusAdapter, StatusEntry, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";

/**
 * Anthropic usage endpoint for subscription quotas (Claude Pro/Max) and extra
 * usage credit. Not part of the public platform API contract, so the URL is
 * overridable: ANTHROPIC_USAGE_URL, or set it to an empty string to disable.
 */
export const ANTHROPIC_USAGE_URL =
	typeof process !== "undefined" && process.env.ANTHROPIC_USAGE_URL !== undefined
		? process.env.ANTHROPIC_USAGE_URL
		: "https://claude.ai/api/usage";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const MAX_LABEL_LENGTH = 64;

function safeLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	return trimmed;
}

export interface AnthropicUsageWindow {
	id: string;
	label: string;
	used: number;
	limit: number;
}

export function parseAnthropicUsage(payload: unknown): {
	plan?: string;
	resetAt?: number;
	windows: AnthropicUsageWindow[];
	extraUsageBalanceUsd?: number;
} {
	if (!isRecord(payload)) {
		throw new ProviderDataError("Anthropic status returned an invalid usage response", "badjson");
	}
	const subscribed = isRecord(payload.subscribedUsage) ? payload.subscribedUsage : payload;

	/** History arrays use their latest entry as the current value. */
	const read = (field: string): number | undefined => {
		const value = subscribed[field];
		if (Array.isArray(value)) {
			const latest = value[value.length - 1];
			return typeof latest === "number" && Number.isFinite(latest) ? latest : undefined;
		}
		return finiteNumber(value);
	};
	const readLimit = (field: string): number | undefined => {
		const limitValue = finiteNumber(subscribed[`${field}Limit`]);
		if (limitValue !== undefined && limitValue > 0) return limitValue;
		const entriesValue = subscribed[field];
		if (isRecord(entriesValue)) {
			const nested = finiteNumber(entriesValue.limit);
			if (nested !== undefined && nested > 0) return nested;
		}
		return undefined;
	};

	const windows: AnthropicUsageWindow[] = [];
	for (const [field, id, label] of [
		["session", "session-usage", "Session"],
		["daily", "daily-usage", "Daily"],
		["weekly", "weekly-usage", "Weekly"],
		["monthly", "monthly-usage", "Monthly"],
	] as const) {
		const used = read(field);
		const limit = readLimit(field);
		if (used !== undefined && limit !== undefined) {
			windows.push({ id, label, used, limit });
		}
	}

	const resetAtValue = finiteNumber(payload.weeklyResetAt) ?? finiteNumber(subscribed.weeklyResetAt);
	const resetAt = resetAtValue !== undefined && resetAtValue > 0 ? resetAtValue * 1_000 : undefined;

	return {
		plan: safeLabel(payload.plan) ?? safeLabel(payload.subscriptionPlan),
		...(resetAt !== undefined ? { resetAt } : {}),
		windows,
		extraUsageBalanceUsd: finiteNumber(payload.extraUsageBalanceUsd) ?? finiteNumber(subscribed.extraUsageBalanceUsd),
	};
}

function windowEntry(id: string, label: string, used: number, limit: number, resetAt: number | undefined): StatusEntry {
	const percent = (used / limit) * 100;
	return {
		kind: "window",
		id,
		label,
		remainingPercent: Math.max(0, Math.min(100, 100 - percent)),
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

function usageEntries(payload: unknown): StatusEntry[] {
	const parsed = parseAnthropicUsage(payload);
	const entries: StatusEntry[] = [{ kind: "text", id: "plan", label: "Plan", value: parsed.plan ?? "Unknown" }];
	for (const window of parsed.windows) {
		entries.push(windowEntry(window.id, window.label, window.used, window.limit, parsed.resetAt));
	}
	if (parsed.extraUsageBalanceUsd !== undefined) {
		entries.push({
			kind: "amount",
			id: "extra-usage-balance",
			label: "Extra usage balance",
			value: parsed.extraUsageBalanceUsd,
			unit: "USD",
		});
	}
	if (entries.length === 1) {
		entries.push({ kind: "text", id: "limits", label: "Limits", value: "not available" });
	}
	return entries;
}

async function credentialType(context: Parameters<StatusAdapter["fetch"]>[0]): Promise<string | undefined> {
	try {
		return await context.getCredentialType?.();
	} catch {
		return undefined;
	}
}

export const anthropicStatusAdapter: StatusAdapter = {
	id: "anthropic-status",
	providerId: "anthropic",
	name: "Anthropic",
	cacheTtlMs: 60_000,
	requestTimeoutMs: 8_000,
	async fetch(context): Promise<StatusSnapshot> {
		const key = await context.getApiKey();
		if (!key || key === "proxy-managed") {
			throw new ProviderDataError("Anthropic status requires authentication", "auth");
		}
		const credential = await credentialType(context);
		const isApiKey = credential === "api_key";

		if (isApiKey) {
			if (!ANTHROPIC_USAGE_URL.trim()) {
				return {
					entries: [{ kind: "text", id: "usage", label: "Usage", value: "disabled" }],
					updatedAt: context.now(),
				};
			}
			// Default endpoint is subscription-only; document the override for API keys.
			return {
				entries: [
					{ kind: "text", id: "auth", label: "Auth", value: "API key" },
					{ kind: "text", id: "usage", label: "Usage", value: "requires ANTHROPIC_USAGE_URL" },
				],
				updatedAt: context.now(),
			};
		}
		// OAuth (Claude Pro/Max) and unknown credentials use the usage endpoint.
		const response = await context.fetch(ANTHROPIC_USAGE_URL, {
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
				`Anthropic status failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("Anthropic status returned invalid JSON", "badjson");
		}
		return { entries: usageEntries(payload), updatedAt: context.now() };
	},
};

export function createAnthropicStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...anthropicStatusAdapter, requestTimeoutMs };
}

const anthropicStatusExtension = defineStatusExtension({
	id: "anthropic-status",
	providerId: "anthropic",
	create: ({ statusRequestTimeoutMs }) => createAnthropicStatusAdapter(statusRequestTimeoutMs),
});

export default anthropicStatusExtension;
