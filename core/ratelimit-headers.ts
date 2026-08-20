/** Shared parsing for OpenAI-style `x-ratelimit-*` response headers. */

export interface RateLimitWindow {
	limit: number;
	remaining: number;
	resetAt?: number;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

const DURATION_PATTERN = /^((?:\d+(?:\.\d+)?(?:ms|[smhd]))+)$/i;
const DURATION_PARTS = /(\d+(?:\.\d+)?)(ms|[smhd])/gi;
const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3_600, d: 86_400 };

export function durationSeconds(value: string): number | undefined {
	const matched = DURATION_PATTERN.exec(value.trim());
	if (!matched?.[1]) return undefined;
	let total = 0;
	for (const match of value.matchAll(DURATION_PARTS)) {
		const amount = Number(match[1]);
		if (!Number.isFinite(amount)) return undefined;
		total += amount * (UNIT_SECONDS[match[2]!.toLowerCase()] ?? Number.NaN);
		if (!Number.isFinite(total)) return undefined;
	}
	return total;
}

/**
 * Reset hint in seconds. Providers use bare numbers, `7.66s`, and compound
 * durations like Groq's `2m59.56s`; reset windows like `1d` also appear.
 */
export function resetSecondsFromHeader(value: string | null): number | undefined {
	if (value === null || value.trim() === "") return undefined;
	const trimmed = value.trim();
	const duration = durationSeconds(trimmed);
	if (duration === undefined) {
		const bare = numberValue(trimmed);
		if (bare === undefined || bare <= 0) return undefined;
		return bare;
	}
	if (duration <= 0) return undefined;
	return duration;
}

function parseWindow(headers: Headers, kind: "requests" | "tokens", now: number): RateLimitWindow | undefined {
	const limit = numberValue(headers.get(`x-ratelimit-limit-${kind}`));
	const remaining = numberValue(headers.get(`x-ratelimit-remaining-${kind}`));
	if (limit === undefined || remaining === undefined || limit <= 0) return undefined;
	const reset = resetSecondsFromHeader(headers.get(`x-ratelimit-reset-${kind}`) ?? headers.get("x-ratelimit-reset"));
	return {
		limit,
		remaining,
		...(reset !== undefined ? { resetAt: now + Math.round(reset * 1_000) } : {}),
	};
}

export function parseRateLimitWindows(
	headers: Headers,
	now: number,
): { requests?: RateLimitWindow; tokens?: RateLimitWindow } {
	return {
		requests: parseWindow(headers, "requests", now),
		tokens: parseWindow(headers, "tokens", now),
	};
}
