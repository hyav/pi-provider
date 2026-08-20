import type { PreflightAdapter } from "@hyav/pi-provider";
import { definePreflightExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";

export const COPILOT_MODELS_URL = "https://api.individual.githubcopilot.com/models";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const githubCopilotPreflightAdapter: PreflightAdapter = {
	id: "github-copilot-preflight",
	providerId: "github-copilot",
	name: "GitHub Copilot",
	cacheTtlMs: 30_000,
	requestTimeoutMs: 8_000,
	async fetch(context) {
		const apiKey = await context.getApiKey();
		if (!apiKey || apiKey === "proxy-managed") {
			return { passed: false, checks: ["auth"], updatedAt: context.now() };
		}
		const response = await context.fetch(COPILOT_MODELS_URL, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				Authorization: `Bearer ${apiKey}`,
				"User-Agent": "@hyav/pi-provider",
			},
			signal: context.signal,
		});
		if (!response.ok) {
			throw new ProviderDataError(
				`GitHub Copilot preflight failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("GitHub Copilot preflight returned invalid JSON", "badjson");
		}
		if (!isRecord(payload) || !Array.isArray(payload.data)) {
			throw new ProviderDataError("GitHub Copilot preflight returned invalid catalog data", "badjson");
		}
		const modelIds = new Set(
			payload.data.flatMap((model) => {
				if (!isRecord(model) || typeof model.id !== "string") return [];
				const id = model.id.trim();
				if (id === "") return [];
				return [id];
			}),
		);
		return {
			passed: modelIds.has(context.model.id),
			checks: ["endpoint", "catalog", "auth"],
			updatedAt: context.now(),
			httpStatus: response.status,
		};
	},
};

export function createGithubCopilotPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return { ...githubCopilotPreflightAdapter, requestTimeoutMs };
}

const githubCopilotPreflightExtension = definePreflightExtension({
	id: "github-copilot-preflight",
	providerId: "github-copilot",
	create: ({ statusRequestTimeoutMs }) => createGithubCopilotPreflightAdapter(statusRequestTimeoutMs),
});

export default githubCopilotPreflightExtension;
