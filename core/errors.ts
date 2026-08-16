export class ProviderDataError extends Error {
	override readonly name = "ProviderDataError";

	constructor(
		message: string,
		readonly code: string,
		readonly retryAt?: number,
		readonly httpStatus?: number,
	) {
		super(message);
	}
}

/**
 * Error shape shared across Pi's isolated extension module contexts.
 * `instanceof` is intentionally not part of this boundary contract.
 */
export interface ProviderDataErrorLike {
	readonly name: "ProviderDataError";
	readonly code: string;
	readonly retryAt?: number;
	readonly httpStatus?: number;
}

export function isProviderDataError(error: unknown): error is ProviderDataErrorLike {
	if (error === null || typeof error !== "object") return false;
	const candidate = error as Partial<ProviderDataErrorLike>;
	return (
		candidate.name === "ProviderDataError" &&
		typeof candidate.code === "string" &&
		(candidate.retryAt === undefined || typeof candidate.retryAt === "number") &&
		(candidate.httpStatus === undefined ||
			(typeof candidate.httpStatus === "number" &&
				Number.isInteger(candidate.httpStatus) &&
				candidate.httpStatus >= 100 &&
				candidate.httpStatus <= 599))
	);
}
