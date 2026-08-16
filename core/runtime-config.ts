import { isValidTimeoutMs } from "./deadline.ts";
import type { PiProviderDefinition } from "./definition.ts";
import { getDefaultOpenRouterMetadataCachePath, OPENROUTER_MODELS_URL } from "./official-pricing.ts";
import { validatePricingPolicy } from "./pricing-adjustments.ts";
import type { ProviderPricingPolicy } from "./types.ts";

export interface PiProviderDependencies {
	fetch: typeof globalThis.fetch;
	now: () => number;
	modelDiscoveryTimeoutMs: number;
	statusRequestTimeoutMs: number;
	liveCheckRequestTimeoutMs: number;
	officialPricingUrl: string;
	officialPricingTimeoutMs: number;
	officialPricingCacheTtlMs: number;
	officialPricingMaxStaleMs: number;
	/** Persistent cache for OpenRouter metadata used by the pricing fallback. */
	openRouterMetadataCachePath: string;
	enableOfficialPricingFallback: boolean;
	/** Optional Pi Provider-level price policies keyed by Provider ID. */
	pricingPolicies?: Record<string, ProviderPricingPolicy>;
}

export type PiProviderLoader = (runtime: PiProviderDependencies) => Promise<PiProviderDefinition>;

const defaultDependencies: PiProviderDependencies = {
	fetch: globalThis.fetch,
	now: Date.now,
	modelDiscoveryTimeoutMs: 3_000,
	statusRequestTimeoutMs: 8_000,
	liveCheckRequestTimeoutMs: 8_000,
	officialPricingUrl: OPENROUTER_MODELS_URL,
	officialPricingTimeoutMs: 3_000,
	officialPricingCacheTtlMs: 60 * 60 * 1_000,
	officialPricingMaxStaleMs: 24 * 60 * 60 * 1_000,
	openRouterMetadataCachePath: getDefaultOpenRouterMetadataCachePath(),
	enableOfficialPricingFallback: true,
	pricingPolicies: {},
};

export function getDefaultPiProviderDependencies(): PiProviderDependencies {
	return { ...defaultDependencies };
}

export function validatePiProviderDependencies(runtime: PiProviderDependencies): void {
	if (typeof runtime.fetch !== "function") throw new Error("Pi Provider fetch must be a function");
	if (typeof runtime.now !== "function") throw new Error("Pi Provider now must be a function");
	for (const [name, value] of [
		["modelDiscoveryTimeoutMs", runtime.modelDiscoveryTimeoutMs],
		["statusRequestTimeoutMs", runtime.statusRequestTimeoutMs],
		["liveCheckRequestTimeoutMs", runtime.liveCheckRequestTimeoutMs],
		["officialPricingTimeoutMs", runtime.officialPricingTimeoutMs],
	] as const) {
		if (!isValidTimeoutMs(value)) throw new Error(`Pi Provider ${name} must be a valid timeout`);
	}
	for (const [name, value] of [
		["officialPricingCacheTtlMs", runtime.officialPricingCacheTtlMs],
		["officialPricingMaxStaleMs", runtime.officialPricingMaxStaleMs],
	] as const) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error(`Pi Provider ${name} must be a finite non-negative number`);
		}
	}
	if (typeof runtime.officialPricingUrl !== "string" || runtime.officialPricingUrl.trim() === "") {
		throw new Error("Pi Provider officialPricingUrl must be a non-empty string");
	}
	if (typeof runtime.openRouterMetadataCachePath !== "string" || runtime.openRouterMetadataCachePath.trim() === "") {
		throw new Error("Pi Provider openRouterMetadataCachePath must be a non-empty path");
	}
	if (typeof runtime.enableOfficialPricingFallback !== "boolean") {
		throw new Error("Pi Provider enableOfficialPricingFallback must be a boolean");
	}
	if (runtime.pricingPolicies !== undefined) {
		if (
			runtime.pricingPolicies === null ||
			typeof runtime.pricingPolicies !== "object" ||
			Array.isArray(runtime.pricingPolicies)
		) {
			throw new Error("Pi Provider pricingPolicies must be an object");
		}
		for (const [providerId, policy] of Object.entries(runtime.pricingPolicies)) {
			if (providerId.trim() === "") throw new Error("Pi Provider pricingPolicies has an empty Provider ID");
			validatePricingPolicy(policy, `Pi Provider pricingPolicies.${providerId}`);
		}
	}
}

export function resolvePiProviderDependencies(
	dependencies: Partial<PiProviderDependencies> = {},
): PiProviderDependencies {
	const runtime = { ...defaultDependencies, ...dependencies };
	if (runtime.pricingPolicies === undefined) runtime.pricingPolicies = {};
	validatePiProviderDependencies(runtime);
	return runtime;
}
