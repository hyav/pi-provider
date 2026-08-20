import type { StatusAdapter, StatusEntry, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";
import { parseRateLimitWindows } from "../core/ratelimit-headers.ts";

export const XAI_MODELS_URL = "https://api.x.ai/v1/models";

function windowEntry(id: string, label: string, limit: number, remaining: number, resetAt?: number): StatusEntry {
	const percent = (remaining / limit) * 100;
	return {
		kind: "window",
		id,
		label,
		remainingPercent: Math.max(0, Math.min(100, percent)),
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

export const xaiStatusAdapter: StatusAdapter = {
	id: "xai-status",
	providerId: "xai",
	name: "xAI",
	cacheTtlMs: 60_000,
	requestTimeoutMs: 8_000,
	async fetch(context): Promise<StatusSnapshot> {
		const key = await context.getApiKey();
		if (!key || key === "proxy-managed") {
			throw new ProviderDataError("xAI status requires Grok OAuth or an API key", "auth");
		}
		const response = await context.fetch(XAI_MODELS_URL, {
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
				`xAI status failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}

		const now = context.now();
		const { requests, tokens } = parseRateLimitWindows(response.headers, now);
		const entries: StatusEntry[] = [];
		if (requests) {
			entries.push(windowEntry("requests-window", "Requests", requests.limit, requests.remaining, requests.resetAt));
		}
		if (tokens) {
			entries.push(windowEntry("tokens-window", "Tokens", tokens.limit, tokens.remaining, tokens.resetAt));
		}
		if (entries.length === 0) {
			entries.push({ kind: "text", id: "limits", label: "Limits", value: "not available" });
		}
		return { entries, updatedAt: now };
	},
};

export function createXaiStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...xaiStatusAdapter, requestTimeoutMs };
}

const xaiStatusExtension = defineStatusExtension({
	id: "xai-status",
	providerId: "xai",
	create: ({ statusRequestTimeoutMs }) => createXaiStatusAdapter(statusRequestTimeoutMs),
});

export default xaiStatusExtension;
