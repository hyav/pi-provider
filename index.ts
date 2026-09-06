import * as piBuiltinCatalog from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
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
export { MAX_PROVIDER_MODEL_COUNT, validateProviderModelDrafts } from "./core/adapter-validation.ts";
export { createCatalogPreflightAdapter } from "./core/catalog-preflight.ts";
export { withDeadline } from "./core/deadline.ts";
export {
	appendBaseUrlPath,
	authDefinesHeader,
	getContextAuth,
	hasBaseUrlOrigin,
	mergeDiagnosticHeaders,
} from "./core/diagnostic-auth.ts";
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
export type {
	ModelCatalogDiagnostics,
	ModelCatalogDiscoveryResult,
	ModelCatalogLifecycle,
	ModelCatalogLifecycleOptions,
} from "./core/model-catalog.ts";
export { createModelCatalogLifecycle } from "./core/model-catalog.ts";
export { createOpenCodeCatalogPreflightAdapter } from "./core/opencode-preflight.ts";
export type { PiCatalogModelMeta, PiCatalogSnapshot } from "./core/pi-model-metadata.ts";
export {
	findPiCatalogModel,
	isLegacyNormalizedModel,
	isLegacyNormalizedSnapshot,
	loadPiCatalog,
	mergeModelWithPiCatalog,
	ORIGINAL_PI_PROVIDER_ALLOWLIST,
	parsePiCatalogFromProviders,
	toPiCatalogSnapshot,
} from "./core/pi-model-metadata.ts";
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
export { normalizeProviderModels } from "./core/provider-registration.ts";
export type { RateLimitWindow } from "./core/ratelimit-headers.ts";
export { parseRetryAfter } from "./core/retry-after.ts";
export type { StatusDiagnostics, StatusErrorState } from "./core/status-manager.ts";
export { normalizeStatusSnapshot, StatusManager } from "./core/status-manager.ts";
export {
	formatProviderStatus,
	getStatusModeCompletions,
	parseStatusMode,
} from "./core/status-report.ts";
export { applyTunerAdapters, sortTunerAdapters } from "./core/tuner-manager.ts";
export type {
	ActiveModel,
	ModelCatalogSource,
	ModelCatalogStatus,
	ModelCostBySkuSources,
	ModelFieldSource,
	ModelFieldSources,
	ModelMetadataState,
	ModelMetadataStatus,
	ModelPricingDetails,
	ModelPricingSource,
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
	ProviderRequestAuth,
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
	/** User adapter root; replaces the default `<agentDir>/extensions/pi-provider` directory. */
	adapterRoot?: string;
	/** Host runtime dependency overrides. */
	dependencies?: Partial<PiProviderDependencies>;
}

/** Create one Pi extension that discovers the current Adapter files when it loads. */
export function createPiProviderExtension(
	options: PiProviderExtensionOptions = {},
): (pi: ExtensionAPI) => Promise<void> {
	return async (pi) => {
		const jiti = createJiti(import.meta.url, { moduleCache: true, tryNative: false });
		const { runPiProviderEntry } = (await jiti.import("./core/runtime-entry.ts")) as {
			runPiProviderEntry: (
				pi: ExtensionAPI,
				entry: {
					agentDir: string;
					readStoredCredential: typeof readStoredCredential;
					wrapTextWithAnsi: typeof wrapTextWithAnsi;
					adapterRoot?: string;
					dependencies?: Partial<PiProviderDependencies>;
					piCatalogSource: {
						getBuiltinProviders: () => string[];
						getBuiltinModels: (provider: string) => unknown[];
						getBuiltinModelDataGeneratedAt: () => number | undefined;
					};
				},
			) => Promise<void>;
		};
		await runPiProviderEntry(pi, {
			agentDir: getAgentDir(),
			readStoredCredential,
			wrapTextWithAnsi,
			adapterRoot: options.adapterRoot,
			dependencies: options.dependencies,
			piCatalogSource: {
				getBuiltinProviders: () => piBuiltinCatalog.getBuiltinProviders(),
				getBuiltinModels: (provider) =>
					piBuiltinCatalog.getBuiltinModels(provider as Parameters<typeof piBuiltinCatalog.getBuiltinModels>[0]),
				getBuiltinModelDataGeneratedAt: () => piBuiltinCatalog.getBuiltinModelDataGeneratedAt?.(),
			},
		});
	};
}

export default createPiProviderExtension();
