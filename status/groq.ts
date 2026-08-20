import type { StatusAdapter, StatusEntry, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";
import { parseRateLimitWindows } from "../core/ratelimit-headers.ts";

export const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function windowEntry(
	id: string,
	label: string,
	window: { limit: number; remaining: number; resetAt?: number },
): StatusEntry {
	const percent = (window.remaining / window.limit) * 100;
	return {
		kind: "window",
		id,
		label,
		remainingPercent: Math.max(0, Math.min(100, percent)),
		...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
	};
}

export const groqStatusAdapter: StatusAdapter = {
	id: "groq-status",
	providerId: "groq",
	name: "Groq",
	cacheTtlMs: 60_000,
	requestTimeoutMs: 8_000,
	async fetch(context): Promise<StatusSnapshot> {
		const key = await context.getApiKey();
		if (!key || key === "proxy-managed") {
			throw new ProviderDataError("Groq status requires an API key", "auth");
		}
		const response = await context.fetch(GROQ_MODELS_URL, {
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
				`Groq status failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let modelCount: string | undefined;
		try {
			const payload: unknown = await response.json();
			modelCount = isRecord(payload) && Array.isArray(payload.data) ? `${payload.data.length} available` : undefined;
		} catch {
			modelCount = undefined;
		}

		const now = context.now();
		const { requests, tokens } = parseRateLimitWindows(response.headers, now);
		const entries: StatusEntry[] = [
			modelCount === undefined
				? { kind: "text", id: "models", label: "Models", value: "unavailable" }
				: { kind: "text", id: "models", label: "Models", value: modelCount },
		];
		if (requests) entries.push(windowEntry("requests-per-day", "Requests per day", requests));
		if (tokens) entries.push(windowEntry("tokens-per-minute", "Tokens per minute", tokens));
		if (entries.length === 1) {
			entries.push({ kind: "text", id: "limits", label: "Limits", value: "not available" });
		}
		return { entries, updatedAt: now };
	},
};

export function createGroqStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...groqStatusAdapter, requestTimeoutMs };
}

const groqStatusExtension = defineStatusExtension({
	id: "groq-status",
	providerId: "groq",
	create: ({ statusRequestTimeoutMs }) => createGroqStatusAdapter(statusRequestTimeoutMs),
});

export default groqStatusExtension;
