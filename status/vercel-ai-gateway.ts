import type { StatusAdapter, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";
import { VERCEL_PROVIDER_ID } from "./vercel-ai-gateway/constants.ts";

export const VERCEL_CREDITS_URL = "https://ai-gateway.vercel.sh/v1/credits";

interface VercelCredits {
	balance: number;
	totalUsed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFiniteAmount(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseVercelCredits(payload: unknown): VercelCredits {
	if (!isRecord(payload)) {
		throw new ProviderDataError("Vercel AI Gateway status returned an invalid credits response", "badjson");
	}

	const balance = parseFiniteAmount(payload.balance);
	const totalUsed = parseFiniteAmount(payload.total_used);
	if (balance === undefined || totalUsed === undefined) {
		throw new ProviderDataError("Vercel AI Gateway status returned an invalid credits response", "badjson");
	}

	return { balance, totalUsed };
}

export function createVercelAIGatewayStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return {
		id: "vercel-ai-gateway-status",
		providerId: VERCEL_PROVIDER_ID,
		name: "Vercel AI Gateway",
		cacheTtlMs: 30_000,
		requestTimeoutMs,
		async fetch(context): Promise<StatusSnapshot> {
			const key = await context.getApiKey();
			if (!key || key === "proxy-managed") {
				throw new ProviderDataError("Vercel AI Gateway status requires an API key", "auth");
			}

			const response = await context.fetch(VERCEL_CREDITS_URL, {
				headers: {
					Accept: "application/json",
					"Accept-Encoding": "identity",
					Authorization: `Bearer ${key}`,
				},
				signal: context.signal,
			});
			if (!response.ok) {
				throw new ProviderDataError(
					`Vercel AI Gateway status failed: HTTP ${response.status}`,
					response.status === 401 ? "auth" : `http${response.status}`,
					parseRetryAfter(response.headers.get("retry-after"), context.now()),
					response.status,
				);
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new ProviderDataError("Vercel AI Gateway status returned invalid JSON", "badjson");
			}

			const credits = parseVercelCredits(payload);
			return {
				entries: [
					{ kind: "amount", id: "balance", label: "Balance", value: credits.balance, unit: "USD" },
					{ kind: "amount", id: "total-used", label: "Total Used", value: credits.totalUsed, unit: "USD" },
				],
				updatedAt: context.now(),
			};
		},
	};
}

export const vercelAIGatewayStatusAdapter = createVercelAIGatewayStatusAdapter(8_000);

const vercelAIGatewayStatusExtension = defineStatusExtension({
	id: "vercel-ai-gateway-status",
	providerId: VERCEL_PROVIDER_ID,
	create: ({ statusRequestTimeoutMs }) => createVercelAIGatewayStatusAdapter(statusRequestTimeoutMs),
});

export default vercelAIGatewayStatusExtension;
