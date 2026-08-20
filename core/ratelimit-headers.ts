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

/** Reset hint in seconds; providers use bare numbers or formats like `7.66s`. */
export function resetSecondsFromHeader(value: string | null): number | undefined {
	const number = numberValue(value);
	if (number === undefined || number <= 0) return undefined;
	return number;
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
