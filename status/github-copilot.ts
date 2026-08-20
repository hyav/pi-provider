import type { StatusAdapter, StatusEntry, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";

/**
 * GitHub Copilot Individual usage. These endpoints are not part of public
 * GitHub documentation, so payload shapes are parsed defensively and a 404
 * degrades to a single explanatory entry instead of an error state.
 */
export const COPILOT_USAGE_URL = "https://api.individual.githubcopilot.com/usage";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const MAX_LABEL_LENGTH = 64;

function safeText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	return trimmed;
}

interface CopilotQuota {
	id: string;
	name?: string;
	used: number;
	limit: number;
	resetAt?: number;
}

function labelValue(value: unknown): string | undefined {
	if (typeof value === "string") return safeText(value);
	if (isRecord(value)) return safeText(value.value) ?? safeText(value.label);
	return undefined;
}

function planName(value: unknown): string | undefined {
	return labelValue(isRecord(value) ? value.planName : undefined);
}

/** Preferred shape: `modelCatalog.usage.modelQuotas`. */
function parseModelCatalog(catalog: unknown): CopilotQuota[] {
	if (!isRecord(catalog) || !isRecord(catalog.usage) || !isRecord(catalog.usage.modelQuotas)) return [];
	const quotas: CopilotQuota[] = [];
	for (const [key, value] of Object.entries(catalog.usage.modelQuotas)) {
		if (!isRecord(value)) continue;
		const used =
			finiteNumber(value.usedRequestsQuantity) ?? finiteNumber(value.usedRequests) ?? finiteNumber(value.used);
		const limit = finiteNumber(value.allowedRequestsQuantity);
		if (used === undefined || limit === undefined || limit <= 0) continue;
		const resetAt = finiteNumber(value.resetAt);
		quotas.push({
			id: key,
			name: safeText(value.modelCopilotName),
			used,
			limit,
			...(resetAt !== undefined ? { resetAt: resetAt * 1_000 } : {}),
		});
	}
	return quotas;
}

/** Fallback shape: `modelQuotaByFeature[]` with nested payload. */
function parseQuotaByFeature(payload: unknown): CopilotQuota[] {
	if (!isRecord(payload) || !Array.isArray(payload.modelQuotaByFeature)) return [];
	const quotas: CopilotQuota[] = [];
	for (const [index, entry] of payload.modelQuotaByFeature.entries()) {
		if (!isRecord(entry)) continue;
		const quota =
			(isRecord(entry.modelQuotaPayload) && entry.modelQuotaPayload) ||
			(isRecord(entry.modelQuotaForFeature) && entry.modelQuotaForFeature);
		if (!quota) continue;
		const used = finiteNumber(quota.usedRequestsQuantity) ?? finiteNumber(quota.usedRequests);
		const limit = finiteNumber(quota.allowedRequestsQuantity);
		if (used === undefined || limit === undefined) continue;
		const resetAt = finiteNumber(quota.resetAt);
		const name = safeText(quota.modelCopilotName);
		quotas.push({
			id: typeof quota.quotaId === "string" && quota.quotaId.trim() !== "" ? quota.quotaId.trim() : `quota-${index}`,
			...(name !== undefined ? { name } : {}),
			used,
			limit,
			...(resetAt !== undefined ? { resetAt: resetAt * 1_000 } : {}),
		});
	}
	return quotas;
}

function windowEntry(quota: CopilotQuota): StatusEntry {
	const percent = (quota.used / quota.limit) * 100;
	return {
		kind: "window",
		id: `quota-${quota.id}`,
		label: quota.name ?? quota.id,
		remainingPercent: Math.max(0, Math.min(100, 100 - percent)),
		...(quota.resetAt !== undefined ? { resetAt: quota.resetAt } : {}),
	};
}

export const githubCopilotStatusAdapter: StatusAdapter = {
	id: "github-copilot-status",
	providerId: "github-copilot",
	name: "GitHub Copilot",
	cacheTtlMs: 60_000,
	requestTimeoutMs: 8_000,
	async fetch(context): Promise<StatusSnapshot> {
		const key = await context.getApiKey();
		if (!key || key === "proxy-managed") {
			throw new ProviderDataError("GitHub Copilot status requires Copilot OAuth", "auth");
		}
		const response = await context.fetch(COPILOT_USAGE_URL, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				Authorization: `Bearer ${key}`,
				"User-Agent": "@hyav/pi-provider",
			},
			signal: context.signal,
		});
		if (response.status === 404) {
			return {
				entries: [{ kind: "text", id: "usage", label: "Usage", value: "unavailable for this plan" }],
				updatedAt: context.now(),
			};
		}
		if (!response.ok) {
			throw new ProviderDataError(
				`GitHub Copilot status failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("GitHub Copilot status returned invalid JSON", "badjson");
		}
		if (!isRecord(payload)) {
			throw new ProviderDataError("GitHub Copilot status returned an invalid usage response", "badjson");
		}
		const quotas = parseModelCatalog(isRecord(payload.modelCatalog) ? payload.modelCatalog : payload);
		const modelQuotas = quotas.length > 0 ? quotas : parseQuotaByFeature(payload);
		const entries: StatusEntry[] = [
			{
				kind: "text",
				id: "plan",
				label: "Plan",
				value: isRecord(payload.modelCatalog) ? (planName(payload.modelCatalog) ?? "Unknown") : "Unknown",
			},
		];
		for (const quota of modelQuotas) entries.push(windowEntry(quota));
		if (entries.length === 1) {
			entries.push({ kind: "text", id: "limits", label: "Limits", value: "not available" });
		}
		return { entries, updatedAt: context.now() };
	},
};

export function createGithubCopilotStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...githubCopilotStatusAdapter, requestTimeoutMs };
}

const githubCopilotStatusExtension = defineStatusExtension({
	id: "github-copilot-status",
	providerId: "github-copilot",
	create: ({ statusRequestTimeoutMs }) => createGithubCopilotStatusAdapter(statusRequestTimeoutMs),
});

export default githubCopilotStatusExtension;
