import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";
import { GROQ_MODELS_URL } from "../status/groq.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const groqPreflightAdapter: PreflightAdapter = {
	id: "groq-preflight",
	providerId: "groq",
	name: "Groq",
	cacheTtlMs: 30_000,
	requestTimeoutMs: 8_000,
	async fetch(context) {
		const apiKey = await context.getApiKey();
		if (!apiKey || apiKey === "proxy-managed") {
			return { passed: false, checks: ["auth"], updatedAt: context.now() };
		}
		const response = await context.fetch(GROQ_MODELS_URL, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				Authorization: `Bearer ${apiKey}`,
			},
			signal: context.signal,
		});
		if (!response.ok) {
			throw new ProviderDataError(
				`Groq preflight failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("Groq preflight returned invalid JSON", "badjson");
		}
		if (!isRecord(payload) || !Array.isArray(payload.data)) {
			throw new ProviderDataError("Groq preflight returned invalid catalog data", "badjson");
		}
		const activeIds = new Set(
			payload.data.flatMap((model) => {
				if (!isRecord(model) || typeof model.id !== "string") return [];
				const id = model.id.trim();
				if (id === "" || model.active === false) return [];
				return [id];
			}),
		);
		return {
			passed: activeIds.has(context.model.id),
			checks: ["endpoint", "auth", "catalog"],
			updatedAt: context.now(),
			httpStatus: response.status,
		};
	},
};

export function createGroqPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...groqPreflightAdapter, requestTimeoutMs };
}

const groqPreflightExtension = definePreflightExtension({
	id: "groq-preflight",
	providerId: "groq",
	create: ({ statusRequestTimeoutMs }) => createGroqPreflightAdapter(statusRequestTimeoutMs),
});

export default groqPreflightExtension;
