import type { StatusAdapter, StatusEntry, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

export interface OpenCodeGoUsageWindow {
	status: "ok" | "rate-limited";
	resetInSec: number;
	usagePercent: number;
}

export interface OpenCodeGoUsagePayload {
	useBalance: boolean;
	rollingUsage: OpenCodeGoUsageWindow;
	weeklyUsage: OpenCodeGoUsageWindow;
	monthlyUsage: OpenCodeGoUsageWindow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseUsageWindow(value: unknown): OpenCodeGoUsageWindow {
	if (!isRecord(value)) {
		throw new ProviderDataError("OpenCode Go status returned an invalid usage window", "badjson");
	}
	const status = value.status;
	const resetInSec = value.resetInSec;
	const usagePercent = value.usagePercent;
	if (
		(status !== "ok" && status !== "rate-limited") ||
		typeof resetInSec !== "number" ||
		!Number.isInteger(resetInSec) ||
		resetInSec < 0 ||
		typeof usagePercent !== "number" ||
		!Number.isInteger(usagePercent) ||
		usagePercent < 0 ||
		usagePercent > 100
	) {
		throw new ProviderDataError("OpenCode Go status returned an invalid usage window", "badjson");
	}
	return { status, resetInSec, usagePercent };
}

export function parseOpenCodeGoUsage(value: unknown): OpenCodeGoUsagePayload {
	if (!isRecord(value) || typeof value.useBalance !== "boolean") {
		throw new ProviderDataError("OpenCode Go status returned an invalid usage response", "badjson");
	}
	return {
		useBalance: value.useBalance,
		rollingUsage: parseUsageWindow(value.rollingUsage),
		weeklyUsage: parseUsageWindow(value.weeklyUsage),
		monthlyUsage: parseUsageWindow(value.monthlyUsage),
	};
}

function usageEntry(id: string, label: string, usage: OpenCodeGoUsageWindow, now: number): StatusEntry {
	return {
		kind: "window",
		id,
		label,
		remainingPercent: usage.status === "rate-limited" ? 0 : 100 - usage.usagePercent,
		resetAt: now + usage.resetInSec * 1_000,
	};
}

export const openCodeGoStatusAdapter: StatusAdapter = {
	id: "opencode-go-status",
	providerId: "opencode-go",
	name: "OpenCode Go",
	cacheTtlMs: 60_000,
	requestTimeoutMs: 8_000,
	async fetch(context): Promise<StatusSnapshot> {
		const key = await context.getApiKey();
		if (!key || key === "proxy-managed") {
			throw new ProviderDataError("OpenCode Go status requires an API key", "auth");
		}
		const response = await context.fetch(OPENCODE_GO_USAGE_URL, {
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
				`OpenCode Go status failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new ProviderDataError("OpenCode Go status returned invalid JSON", "badjson");
		}
		const payload = parseOpenCodeGoUsage(body);
		const now = context.now();
		return {
			entries: [
				{ kind: "text", id: "plan", label: "Plan", value: "Go" },
				usageEntry("rolling-window", "5h", payload.rollingUsage, now),
				usageEntry("weekly-window", "Weekly", payload.weeklyUsage, now),
				usageEntry("monthly-window", "Monthly", payload.monthlyUsage, now),
				{
					kind: "text",
					id: "zen-balance-fallback",
					label: "Zen balance fallback",
					value: payload.useBalance ? "enabled" : "disabled",
				},
			],
			updatedAt: now,
		};
	},
};

export function createOpenCodeGoStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...openCodeGoStatusAdapter, requestTimeoutMs };
}

const openCodeGoStatusExtension = defineStatusExtension({
	id: "opencode-go-status",
	providerId: "opencode-go",
	create: ({ statusRequestTimeoutMs }) => createOpenCodeGoStatusAdapter(statusRequestTimeoutMs),
});

export default openCodeGoStatusExtension;
