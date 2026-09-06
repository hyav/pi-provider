import type { PreflightAdapter, PreflightModel, PreflightSnapshot } from "@hyav/pi-provider";
import {
	definePreflightExtension,
	hasBaseUrlOrigin,
	MAX_PROVIDER_MODEL_COUNT,
	ProviderDataError,
	parseRetryAfter,
} from "@hyav/pi-provider";
import { MAAS_MODELS_URL, MAAS_PROVIDER_ID, MAAS_PROVIDER_NAME } from "../providers/maas.ts";

export { MAAS_MODELS_URL, MAAS_PROVIDER_ID, MAAS_PROVIDER_NAME } from "../providers/maas.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseMaaSModelIds(payload: unknown): Set<string> {
	if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length > MAX_PROVIDER_MODEL_COUNT) {
		throw new ProviderDataError(`${MAAS_PROVIDER_NAME} preflight returned invalid catalog data`, "badjson");
	}
	const modelIds = new Set<string>();
	for (const value of payload.data) {
		if (!isRecord(value) || typeof value.id !== "string") continue;
		const id = value.id.trim();
		if (id === "" || id.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(id)) continue;
		modelIds.add(id.toLowerCase());
	}
	return modelIds;
}

export function createMaaSPreflightAdapter(requestTimeoutMs: number): PreflightAdapter {
	return {
		id: "maas-preflight",
		providerId: MAAS_PROVIDER_ID,
		name: MAAS_PROVIDER_NAME,
		cacheTtlMs: 30_000,
		requestTimeoutMs,
		supportsModel: (model: PreflightModel) => hasBaseUrlOrigin(model.baseUrl, MAAS_MODELS_URL),
		async fetch(context): Promise<PreflightSnapshot> {
			const apiKey = await context.getApiKey();
			if (!apiKey || apiKey === "proxy-managed") {
				return { passed: false, checks: ["auth"], updatedAt: context.now() };
			}
			const response = await context.fetch(MAAS_MODELS_URL, {
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
					`${MAAS_PROVIDER_NAME} preflight failed: HTTP ${response.status}`,
					response.status === 401 || response.status === 403 ? "auth" : `http${response.status}`,
					parseRetryAfter(response.headers.get("retry-after"), context.now()),
					response.status,
				);
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new ProviderDataError(`${MAAS_PROVIDER_NAME} preflight returned invalid JSON`, "badjson");
			}
			return {
				passed: parseMaaSModelIds(payload).has(context.model.id.trim().toLowerCase()),
				checks: ["endpoint", "auth", "catalog"],
				updatedAt: context.now(),
				httpStatus: response.status,
			};
		},
	};
}

export const maasPreflightAdapter = createMaaSPreflightAdapter(8_000);

const maasPreflightExtension = definePreflightExtension({
	id: "maas-preflight",
	providerId: MAAS_PROVIDER_ID,
	create: ({ statusRequestTimeoutMs }) => createMaaSPreflightAdapter(statusRequestTimeoutMs),
});

export default maasPreflightExtension;
