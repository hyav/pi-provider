export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

function cappedRetryAt(now: number, delayMs: number): number | undefined {
	const retryAt = now + Math.min(delayMs, MAX_RETRY_AFTER_MS);
	return Number.isFinite(retryAt) ? retryAt : undefined;
}

export function parseRetryAfter(value: string | null, now: number): number | undefined {
	if (value === null || !Number.isFinite(now)) return undefined;
	const trimmed = value.trim();
	if (trimmed === "") return undefined;

	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		const seconds = Number(trimmed);
		if (!Number.isFinite(seconds)) return cappedRetryAt(now, MAX_RETRY_AFTER_MS);
		return cappedRetryAt(now, seconds * 1_000);
	}
	if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return undefined;

	const timestamp = Date.parse(trimmed);
	if (!Number.isFinite(timestamp)) return undefined;
	const maxRetryAt = cappedRetryAt(now, MAX_RETRY_AFTER_MS);
	return maxRetryAt === undefined ? undefined : Math.min(Math.max(now, timestamp), maxRetryAt);
}
