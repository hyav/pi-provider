/**
 * Jiti-safe public entrypoint for user adapter files discovered from the
 * adapter roots. `loadPackageAdapterExtensions` aliases `@hyav/pi-provider`
 * to this module so adapter files can import the same helpers and types the
 * built-in adapters use, without resolving Pi's bundled runtime packages.
 */

export type {
	AdapterExtensionContext,
	PreflightExtensionDefinition,
	ProviderExtensionDefinition,
	StatusExtensionDefinition,
	TunerExtensionDefinition,
} from "./adapter-extensions.ts";
export {
	definePreflightExtension,
	defineProviderExtension,
	defineStatusExtension,
	defineTunerExtension,
} from "./adapter-extensions.ts";
export { MAX_PROVIDER_MODEL_COUNT, validateProviderModelDrafts } from "./adapter-validation.ts";
export { createCatalogPreflightAdapter } from "./catalog-preflight.ts";
export { withDeadline } from "./deadline.ts";
export {
	appendBaseUrlPath,
	authDefinesHeader,
	getContextAuth,
	hasBaseUrlOrigin,
	mergeDiagnosticHeaders,
} from "./diagnostic-auth.ts";
export { isProviderDataError, ProviderDataError } from "./errors.ts";
export type {
	ModelCatalogDiagnostics,
	ModelCatalogDiscoveryResult,
	ModelCatalogLifecycle,
	ModelCatalogLifecycleOptions,
} from "./model-catalog.ts";
export { createModelCatalogLifecycle } from "./model-catalog.ts";
export { createOpenCodeCatalogPreflightAdapter } from "./opencode-preflight.ts";
export { isLegacyNormalizedModel, isLegacyNormalizedSnapshot } from "./pi-model-metadata.ts";
export type {
	PreflightAdapter,
	PreflightContextLike,
	PreflightModel,
	PreflightSnapshot,
} from "./preflight-manager.ts";
export { normalizeProviderModels } from "./provider-registration.ts";
export { parseRetryAfter } from "./retry-after.ts";
export type { StatusContextLike } from "./status-manager.ts";
export type {
	ActiveModel,
	ModelCatalogSource,
	ModelCatalogStatus,
	ProviderAdapter,
	ProviderCost,
	ProviderModel,
	ProviderModelDraft,
	ProviderPricingAdjustment,
	ProviderPricingPolicy,
	ProviderPricingSource,
	ProviderRefreshContext,
	ProviderRequestAuth,
	StatusAdapter,
	StatusContext,
	StatusEntry,
	StatusSnapshot,
	StoredCredentialLike,
	ThinkingLevel,
	TunerAdapter,
	TunerContext,
} from "./types.ts";
