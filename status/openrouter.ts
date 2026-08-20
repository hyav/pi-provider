import type { StatusAdapter, StatusEntry, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/auth/key";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isErrorPayload(value: Record<string, unknown>): boolean {
	return isRecord(value.error) && (typeof value.error.code === "number" || typeof value.error.message === "string");
}

interface OpenRouterKey {
	label: string;
	usage: number;
	limit: number | null;
	isFreeTier: boolean;
}

function parseKeyPayload(value: unknown): OpenRouterKey {
	if (!isRecord(value) || !isRecord(value.data)) {
		throw new ProviderDataError("OpenRouter status returned an invalid key response", "badjson");
	}
	const data = value.data;
	const usage = safeNumber(data.usage);
	if (
		typeof data.label !== "string" ||
		typeof data.is_free_tier !== "boolean" ||
		usage === undefined ||
		(data.limit !== null && safeNumber(data.limit) === undefined)
	) {
		throw new ProviderDataError("OpenRouter status returned an invalid key response", "badjson");
	}
	return {
		label: data.label.replace(/[\u0000-\u001f\u007f]/g, "").trim() || "API key",
		usage,
		limit: data.limit === null ? null : (safeNumber(data.limit) as number),
		isFreeTier: data.is_free_tier,
	};
}

async function readJson(response: Response, providerName: string): Promise<unknown> {
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new ProviderDataError(`${providerName} status returned invalid JSON`, "badjson");
	}
	return payload;
}

async function fetchWithAuth(
	context: Parameters<StatusAdapter["fetch"]>[0],
	key: string,
	url: string,
	providerName: string,
): Promise<{ response: Response; payload: unknown }> {
	const response = await context.fetch(url, {
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
			`${providerName} status failed: HTTP ${response.status}`,
			`http${response.status}`,
			parseRetryAfter(response.headers.get("retry-after"), context.now()),
			response.status,
		);
	}
	return { response, payload: await readJson(response, providerName) };
}

function keyEntries(
	key: OpenRouterKey,
	limitEntry: StatusEntry | undefined,
	freeTierEntry: StatusEntry,
): StatusEntry[] {
	const usageEntry: StatusEntry = {
		kind: "amount",
		id: "credits-used",
		label: "Credits used",
		value: key.usage,
		unit: "USD",
	};
	const entries: StatusEntry[] = [{ kind: "text", id: "key", label: "Key", value: key.label }, usageEntry];
	if (limitEntry) entries.push(limitEntry);
	entries.push(freeTierEntry);
	return entries;
}

function freeTierEntry(value: boolean): StatusEntry {
	return { kind: "text", id: "account-tier", label: "Account", value: value ? "Free tier" : "Paid" };
}

export const openRouterStatusAdapter: StatusAdapter = {
	id: "openrouter-status",
	providerId: "openrouter",
	name: "OpenRouter",
	cacheTtlMs: 60_000,
	requestTimeoutMs: 8_000,
	async fetch(context): Promise<StatusSnapshot> {
		const key = await context.getApiKey();
		if (!key || key === "proxy-managed") {
			throw new ProviderDataError("OpenRouter status requires an API key", "auth");
		}
		const keyResult = await fetchWithAuth(context, key, OPENROUTER_KEY_URL, "OpenRouter");
		const keyPayload = keyResult.payload;
		if (isRecord(keyPayload) && isErrorPayload(keyPayload)) {
			throw new ProviderDataError(
				"OpenRouter status failed: invalid API key response",
				"auth",
				undefined,
				keyResult.response.status,
			);
		}
		const openRouterKey = parseKeyPayload(keyPayload);

		// /credits requires a management key; only show the limit when resolved.
		let limitEntry: StatusEntry | undefined;
		try {
			const creditsResult = await fetchWithAuth(context, key, OPENROUTER_CREDITS_URL, "OpenRouter");
			const payload = creditsResult.payload;
			if (!isRecord(payload) || !isRecord(payload.data)) {
				throw new ProviderDataError("OpenRouter status returned an invalid credits response", "badjson");
			}
			const totalCredits = safeNumber(payload.data.total_credits);
			const totalUsage = safeNumber(payload.data.total_usage);
			if (totalCredits === undefined || totalUsage === undefined) {
				throw new ProviderDataError("OpenRouter status returned an invalid credits response", "badjson");
			}
			const remaining = Math.max(0, totalCredits - totalUsage);
			limitEntry = {
				kind: "amount",
				id: "credits-remaining",
				label: "Credits remaining",
				value: remaining,
				unit: "USD",
			};
		} catch (error) {
			// Safe fallback: key credits, free-tier, and key-level limit still display.
			if (!(error instanceof ProviderDataError)) throw error;
		}

		return {
			entries: keyEntries(openRouterKey, limitEntry, freeTierEntry(openRouterKey.isFreeTier)),
			updatedAt: context.now(),
		};
	},
};

export function createOpenRouterStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...openRouterStatusAdapter, requestTimeoutMs };
}

const openRouterStatusExtension = defineStatusExtension({
	id: "openrouter-status",
	providerId: "openrouter",
	create: ({ statusRequestTimeoutMs }) => createOpenRouterStatusAdapter(statusRequestTimeoutMs),
});

export default openRouterStatusExtension;
