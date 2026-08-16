import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";

export const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function catalogModelIds(value: Record<string, unknown>): string[] {
	const ids: string[] = [];
	if (typeof value.baseModelId === "string" && value.baseModelId.trim() !== "") {
		ids.push(value.baseModelId.trim());
	}
	if (typeof value.name === "string" && value.name.trim() !== "") {
		ids.push(value.name.trim().replace(/^models\//, ""));
	}
	return ids;
}

export const googlePreflightAdapter: PreflightAdapter = {
	id: "google-preflight",
	providerId: "google",
	name: "Google Gemini",
	cacheTtlMs: 30_000,
	requestTimeoutMs: 8_000,
	async fetch(context) {
		const apiKey = await context.getApiKey();
		if (!apiKey || apiKey === "proxy-managed") {
			return { passed: false, checks: ["auth"], updatedAt: context.now() };
		}
		const response = await context.fetch(GOOGLE_MODELS_URL, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				"x-goog-api-key": apiKey,
			},
			signal: context.signal,
		});
		if (!response.ok) {
			throw new ProviderDataError(
				`Google preflight failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("Google preflight returned invalid JSON", "badjson");
		}
		if (!isRecord(payload) || !Array.isArray(payload.models)) {
			throw new ProviderDataError("Google preflight returned invalid catalog data", "badjson");
		}
		const modelIds = new Set(
			payload.models.flatMap((value) => {
				if (!isRecord(value)) return [];
				const methods = value.supportedGenerationMethods;
				return isStringArray(methods) && methods.includes("generateContent") ? catalogModelIds(value) : [];
			}),
		);
		return {
			passed: modelIds.has(context.model.id),
			checks: ["endpoint", "auth", "catalog"],
			updatedAt: context.now(),
			httpStatus: response.status,
		};
	},
};

export function createGooglePreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...googlePreflightAdapter, requestTimeoutMs };
}

const googlePreflightExtension = definePreflightExtension({
	id: "google-preflight",
	providerId: "google",
	create: ({ statusRequestTimeoutMs }) => createGooglePreflightAdapter(statusRequestTimeoutMs),
});

export default googlePreflightExtension;
