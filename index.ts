import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPackageAdapterExtensions } from "./core/adapter-loader.ts";
import { createPiProviderHost } from "./core/host.ts";
import type { PiProviderDependencies } from "./core/runtime-config.ts";

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
	PiProviderDefinition,
	PiProviderDependencies,
	PiProviderLoader,
	PiProviderRuntimeController,
} from "./core/extension.ts";
export {
	createPiProviderRuntime,
	getDefaultPiProviderDependencies,
	installPiProviderRuntime,
	prepareProviderRegistration,
	registerProviderAdapter,
	resolvePiProviderDependencies,
	validatePiProviderDefinition,
	validatePiProviderDependencies,
} from "./core/extension.ts";
export { createPiProviderHost } from "./core/host.ts";
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

export interface PiProviderExtensionOptions {
	/** Package root containing providers, status, preflight, and tuners directories. */
	adapterRoot?: string;
	/** Host runtime dependency overrides. */
	dependencies?: Partial<PiProviderDependencies>;
}

/** Create one Pi extension that discovers the current Adapter files when it loads. */
export function createPiProviderExtension(
	options: PiProviderExtensionOptions = {},
): (pi: ExtensionAPI) => Promise<void> {
	const piProviderHost = createPiProviderHost(options.dependencies);
	return async (pi) => {
		piProviderHost(pi);
		await loadPackageAdapterExtensions(pi, options.adapterRoot);
	};
}

export default createPiProviderExtension();
