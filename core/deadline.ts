export const MAX_TIMEOUT_MS = 2_147_483_647;

export function isValidTimeoutMs(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

function createAbortError(): DOMException {
	return new DOMException("The operation was aborted", "AbortError");
}

function createTimeoutError(): DOMException {
	return new DOMException("The operation timed out", "TimeoutError");
}

function signalReason(signal: AbortSignal): unknown {
	return signal.reason ?? createAbortError();
}

/**
 * Races the complete operation, including response processing, against a finite deadline.
 * The underlying operation receives a signal, but its late settlement is intentionally ignored.
 */
export function withDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T> | T,
	timeoutMs: number,
	externalSignal?: AbortSignal,
): Promise<T> {
	if (!isValidTimeoutMs(timeoutMs)) {
		return Promise.reject(new RangeError(`Timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms`));
	}
	if (externalSignal?.aborted) return Promise.reject(signalReason(externalSignal));

	const controller = new AbortController();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let rejectCancellation: (reason: unknown) => void = () => {};
	let timeoutReason: DOMException | undefined;
	let cancellationReason: unknown;
	let timedOut = false;
	let cancelled = false;

	const cancellationPromise = new Promise<never>((_, reject) => {
		rejectCancellation = reject;
	});
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			timedOut = true;
			timeoutReason = createTimeoutError();
			controller.abort(timeoutReason);
			reject(timeoutReason);
		}, timeoutMs);
	});
	const onAbort = () => {
		if (cancelled || timedOut) return;
		cancelled = true;
		cancellationReason = signalReason(externalSignal!);
		controller.abort(cancellationReason);
		rejectCancellation(cancellationReason);
	};

	if (externalSignal) {
		externalSignal.addEventListener("abort", onAbort, { once: true });
		if (externalSignal.aborted) onAbort();
	}

	const operationPromise = Promise.resolve().then(() => operation(controller.signal));
	const raced = Promise.race([operationPromise, timeoutPromise, cancellationPromise]);
	const result = raced.catch((error: unknown) => {
		if (timedOut) throw timeoutReason;
		if (cancelled) throw cancellationReason;
		throw error;
	});
	const cleanup = () => {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		externalSignal?.removeEventListener("abort", onAbort);
	};
	result.then(cleanup, cleanup);
	return result;
}
