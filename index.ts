import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPackageAdapterExtensions } from "./core/adapter-loader.ts";
import { createProviderKitHost } from "./core/host.ts";
import type { ProviderKitDependencies } from "./core/runtime-config.ts";

export type {
	AdapterExtensionContext,
	PreflightExtensionDefinition,
	ProviderExtensionDefinition,
	StatusExtensionDefinition,
	TunerExtensionDefinition,
} from "./core/adapter-extensions.ts";
export {
	definePreflightExtension,
	defineProviderExtension,
	defineStatusExtension,
	defineTunerExtension,
} from "./core/adapter-extensions.ts";
export type { ProviderDataErrorLike } from "./core/errors.ts";
export { isProviderDataError, ProviderDataError } from "./core/errors.ts";
export type {
	ProviderKitDefinition,
	ProviderKitDependencies,
	ProviderKitLoader,
	ProviderKitRuntimeController,
} from "./core/extension.ts";
export {
	createProviderKitRuntime,
	getDefaultProviderKitDependencies,
	installProviderKitRuntime,
	prepareProviderRegistration,
	registerProviderAdapter,
	resolveProviderKitDependencies,
	validateProviderKitDefinition,
	validateProviderKitDependencies,
} from "./core/extension.ts";
export { createProviderKitHost } from "./core/host.ts";
export type {
	LiveCheckContextLike,
	LiveCheckDiagnostics,
	LiveCheckErrorState,
	LiveCheckResult,
	LiveCheckSnapshot,
} from "./core/live-check-manager.ts";
export { getLiveCheckKey, LIVE_CHECK_SCOPE, LiveCheckManager } from "./core/live-check-manager.ts";
export {
	applyOfficialModelCosts,
	clearPricingCache,
	fetchOfficialPricing,
	findOfficialCost,
	findOfficialMeta,
	getDefaultOpenRouterMetadataCachePath,
	getPricingCache,
	getPricingCacheAge,
	type OfficialModelMeta,
	type OfficialPricingFetchOptions,
	OPENROUTER_MODELS_URL,
	parseOpenRouterModels,
	parseOpenRouterPricing,
	setPricingCache,
} from "./core/official-pricing.ts";
export type {
	PreflightAdapter,
	PreflightContext,
	PreflightContextLike,
	PreflightDiagnostics,
	PreflightErrorState,
	PreflightModel,
	PreflightSnapshot,
} from "./core/preflight-manager.ts";
export { getPreflightKey, normalizePreflightSnapshot, PreflightManager } from "./core/preflight-manager.ts";
export { applyPricingAdjustment, resolvePricingDetails } from "./core/pricing-adjustments.ts";
export type { StatusDiagnostics, StatusErrorState } from "./core/status-manager.ts";
export { normalizeStatusSnapshot, StatusManager } from "./core/status-manager.ts";
export { applyTunerAdapters, sortTunerAdapters } from "./core/tuner-manager.ts";
export type {
	ActiveModel,
	ModelCatalogSource,
	ModelCatalogStatus,
	ModelFieldSource,
	ModelFieldSources,
	ModelMetadataState,
	ModelMetadataStatus,
	ModelPricingDetails,
	ModelPricingSource,
	ModelQualityScore,
	PiApi,
	PricingSku,
	ProviderAdapter,
	ProviderCost,
	ProviderDefinition,
	ProviderModel,
	ProviderModelDraft,
	ProviderModelMetadata,
	ProviderPricingAdjustment,
	ProviderPricingPolicy,
	ProviderPricingSource,
	ProviderRefreshContext,
	StatusAdapter,
	StatusAmountEntry,
	StatusContext,
	StatusEntry,
	StatusSnapshot,
	StatusTextEntry,
	StatusWindowEntry,
	ThinkingLevel,
	TunerAdapter,
	TunerContext,
} from "./core/types.ts";

export interface ProviderKitExtensionOptions {
	/** Package root containing providers, status, preflight, and tuners directories. */
	adapterRoot?: string;
	/** Host runtime dependency overrides. */
	dependencies?: Partial<ProviderKitDependencies>;
}

/** Create one Pi extension that discovers the current Adapter files when it loads. */
export function createProviderKitExtension(
	options: ProviderKitExtensionOptions = {},
): (pi: ExtensionAPI) => Promise<void> {
	const providerKitHost = createProviderKitHost(options.dependencies);
	return async (pi) => {
		providerKitHost(pi);
		await loadPackageAdapterExtensions(pi, options.adapterRoot);
	};
}

export default createProviderKitExtension();
