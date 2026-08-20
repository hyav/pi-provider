import type { StatusAdapter, StatusEntry, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";

export const HF_WHOAMI_URL = "https://huggingface.co/api/whoami-v2";

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

export interface HuggingFaceAccount {
	plan?: string;
	credits?: number;
}

export function parseHuggingFaceAccount(payload: unknown): HuggingFaceAccount {
	if (!isRecord(payload)) {
		throw new ProviderDataError("Hugging Face status returned an invalid account response", "badjson");
	}
	// Response envelope: { type, id, name, emailVerified, canPay, isPro, plan, periodEnd, credits, ... }
	const plan = safeText(payload.plan);
	// Older token generations omit the envelope fields entirely.
	return {
		...(plan !== undefined ? { plan } : {}),
		...(finiteNumber(payload.credits) !== undefined ? { credits: finiteNumber(payload.credits) } : {}),
	};
}

export const huggingFaceStatusAdapter: StatusAdapter = {
	id: "huggingface-status",
	providerId: "huggingface",
	name: "Hugging Face",
	cacheTtlMs: 60_000,
	requestTimeoutMs: 8_000,
	async fetch(context): Promise<StatusSnapshot> {
		const key = await context.getApiKey();
		if (!key || key === "proxy-managed") {
			throw new ProviderDataError("Hugging Face status requires a token", "auth");
		}
		const response = await context.fetch(HF_WHOAMI_URL, {
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
				`Hugging Face status failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("Hugging Face status returned invalid JSON", "badjson");
		}
		const account = parseHuggingFaceAccount(payload);
		const entries: StatusEntry[] = [{ kind: "text", id: "plan", label: "Plan", value: account.plan ?? "Unknown" }];
		if (account.credits !== undefined) {
			entries.push({ kind: "amount", id: "credits", label: "Credits", value: account.credits, unit: "USD" });
		}
		return { entries, updatedAt: context.now() };
	},
};

export function createHuggingFaceStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...huggingFaceStatusAdapter, requestTimeoutMs };
}

const huggingFaceStatusExtension = defineStatusExtension({
	id: "huggingface-status",
	providerId: "huggingface",
	create: ({ statusRequestTimeoutMs }) => createHuggingFaceStatusAdapter(statusRequestTimeoutMs),
});

export default huggingFaceStatusExtension;
