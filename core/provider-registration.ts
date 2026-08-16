import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { applyOfficialModelCosts, findOfficialMeta, type OfficialModelMeta } from "./official-pricing.ts";
import { resolvePricingDetails } from "./pricing-adjustments.ts";
import type { PiProviderDependencies } from "./runtime-config.ts";
import type {
	ProviderAdapter,
	ProviderCost,
	ProviderModel,
	ProviderModelDraft,
	ProviderModelMetadata,
	ProviderPricingAdjustment,
	ProviderPricingSource,
	ProviderRefreshContext,
} from "./types.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
		? value
		: fallback;
}

function normalizeCost(cost: ProviderModelDraft["cost"]): ProviderCost {
	const candidate = cost as Partial<ProviderCost> | undefined;
	const tiers = Array.isArray(candidate?.tiers)
		? candidate.tiers
				.filter(
					(tier) =>
						tier &&
						typeof tier.inputTokensAbove === "number" &&
						Number.isFinite(tier.inputTokensAbove) &&
						tier.inputTokensAbove > 0,
				)
				.map((tier) => ({
					inputTokensAbove: tier.inputTokensAbove,
					input: finiteNonNegative(tier.input),
					output: finiteNonNegative(tier.output),
					cacheRead: finiteNonNegative(tier.cacheRead),
					cacheWrite: finiteNonNegative(tier.cacheWrite),
				}))
		: undefined;
	return {
		input: finiteNonNegative(candidate?.input),
		output: finiteNonNegative(candidate?.output),
		cacheRead: finiteNonNegative(candidate?.cacheRead),
		cacheWrite: finiteNonNegative(candidate?.cacheWrite),
		...(tiers && tiers.length > 0 ? { tiers } : {}),
	};
}

function normalizeInput(input: ProviderModelDraft["input"]): ("text" | "image")[] {
	const normalized = Array.isArray(input)
		? input.filter((value): value is "text" | "image" => value === "text" || value === "image")
		: [];
	return normalized.length > 0 ? [...new Set(normalized)] : ["text"];
}

export function normalizeProviderModel(model: ProviderModelDraft): ProviderModel {
	const { pricingSource: _pricingSource, pricingAdjustment: _pricingAdjustment, ...modelConfig } = model;
	void _pricingSource;
	void _pricingAdjustment;
	if (typeof model.id !== "string") throw new Error("Provider model ID must be a string");
	const id = model.id.trim();
	if (id === "") throw new Error("Provider model ID must not be empty");
	const contextWindow = positiveInteger(model.contextWindow, DEFAULT_CONTEXT_WINDOW);
	const maxTokens = Math.min(positiveInteger(model.maxTokens, DEFAULT_MAX_TOKENS), contextWindow);
	return {
		...modelConfig,
		id,
		name: typeof model.name === "string" && model.name.trim() !== "" ? model.name.trim() : id,
		reasoning: model.reasoning ?? false,
		input: normalizeInput(model.input),
		cost: normalizeCost(model.cost),
		contextWindow,
		maxTokens,
	};
}

export function normalizeProviderModels(models: ProviderModelDraft[]): ProviderModel[] {
	const seen = new Set<string>();
	return models.map((model) => {
		const normalized = normalizeProviderModel(model);
		if (seen.has(normalized.id)) throw new Error(`Duplicate model ID: ${normalized.id}`);
		seen.add(normalized.id);
		return normalized;
	});
}

function cloneQuality(quality: NonNullable<OfficialModelMeta["quality"]>): NonNullable<OfficialModelMeta["quality"]> {
	return quality.map((score) => ({
		...score,
		...(score.confidenceInterval ? { confidenceInterval: { ...score.confidenceInterval } } : {}),
	}));
}

function selectPricingAdjustment(
	adapter: ProviderAdapter,
	model: ProviderModelDraft,
	policy = adapter.pricing,
): ProviderPricingAdjustment | undefined {
	return model.pricingAdjustment ?? policy?.models?.[model.id.trim()] ?? policy?.defaultAdjustment;
}

function resolveModelRegistration(
	adapter: ProviderAdapter,
	runtime: PiProviderDependencies,
	modelDrafts: ProviderModelDraft[],
	officialPricing: Record<string, OfficialModelMeta>,
): { models: ProviderModel[]; modelMetadata: Record<string, ProviderModelMetadata> } {
	const enrichedDrafts = applyOfficialModelCosts(modelDrafts, officialPricing);
	const pricingPolicy = runtime.pricingPolicies?.[adapter.id] ?? adapter.pricing;
	const metadata: Record<string, ProviderModelMetadata> = {};
	const adjustedDrafts = enrichedDrafts.map((model, index) => {
		const modelId = model.id.trim();
		const originalDraft = modelDrafts[index];
		const officialMeta = findOfficialMeta(modelId, officialPricing);
		const fieldSources = {
			contextWindow:
				originalDraft?.contextWindow !== undefined
					? ("provider" as const)
					: officialMeta?.contextWindow !== undefined
						? ("official" as const)
						: ("default" as const),
			maxTokens:
				originalDraft?.maxTokens !== undefined
					? ("provider" as const)
					: officialMeta?.maxTokens !== undefined
						? ("official" as const)
						: ("default" as const),
			input:
				originalDraft?.input !== undefined
					? ("provider" as const)
					: officialMeta?.input !== undefined
						? ("official" as const)
						: ("default" as const),
			reasoning:
				originalDraft?.reasoning !== undefined
					? ("provider" as const)
					: officialMeta?.reasoning !== undefined
						? ("official" as const)
						: ("default" as const),
		};
		const source: ProviderPricingSource | "none" =
			model.cost === undefined ? "none" : (model.pricingSource ?? "provider");
		const pricing = resolvePricingDetails(model.cost, source, selectPricingAdjustment(adapter, model, pricingPolicy));
		metadata[modelId] = {
			pricing,
			fieldSources,
			...(officialMeta?.quality ? { quality: cloneQuality(officialMeta.quality) } : {}),
		};
		return {
			...model,
			...(pricing.effectiveCost ? { cost: pricing.effectiveCost } : {}),
		};
	});
	return { models: normalizeProviderModels(adjustedDrafts), modelMetadata: metadata };
}

function isAbortError(error: unknown): boolean {
	return error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";
}

function getErrorCode(error: unknown): string {
	if (isAbortError(error)) return "cancelled";
	if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	if (error !== null && typeof error === "object" && "name" in error && error.name === "TimeoutError") {
		return "timeout";
	}
	return "fetch";
}

/**
 * Register a normalized Provider before the Host has assembled its final
 * registry. The original drafts remain attached to the adapter so a Host in a
 * different module context can apply official metadata later.
 */
export function prepareProviderRegistration(
	adapter: ProviderAdapter,
	runtime: PiProviderDependencies,
	officialPricing: Record<string, OfficialModelMeta> = {},
	modelDrafts?: ProviderModelDraft[],
): ProviderConfig {
	const drafts =
		modelDrafts ??
		(adapter.registration?.normalizedModels === adapter.provider.models
			? adapter.registration.modelDrafts
			: adapter.provider.models);
	const resolved = resolveModelRegistration(adapter, runtime, drafts, officialPricing);
	const models = resolved.models;
	const adapterOwnsCatalog = adapter.catalog !== undefined;
	const registration = { modelDrafts: drafts, normalizedModels: models, modelMetadata: resolved.modelMetadata };
	adapter.registration = registration;
	adapter.provider.models = models;
	adapter.catalog ??= { source: "static", modelCount: models.length };
	adapter.catalog.modelCount = models.length;

	const { models: _draftModels, refreshModels: originalRefresh, ...providerMetadata } = adapter.provider;
	const registeredProvider: ProviderConfig = { ...providerMetadata, models };
	if (originalRefresh) {
		registeredProvider.refreshModels = async (options: ProviderRefreshContext) => {
			try {
				const refreshedModels = await originalRefresh(options);
				const resolved = resolveModelRegistration(adapter, runtime, refreshedModels, officialPricing);
				const normalizedModels = resolved.models;
				registration.modelDrafts = refreshedModels;
				registration.normalizedModels = normalizedModels;
				registration.modelMetadata = resolved.modelMetadata;
				adapter.provider.models = normalizedModels;
				registeredProvider.models = normalizedModels;
				if (adapterOwnsCatalog && adapter.catalog) {
					adapter.catalog.modelCount = normalizedModels.length;
				} else {
					adapter.catalog = {
						...(adapter.catalog ?? { source: "live" }),
						source: "live",
						modelCount: normalizedModels.length,
						updatedAt: runtime.now(),
						lastError: undefined,
					};
				}
				return normalizedModels;
			} catch (error) {
				if (adapter.catalog && !isAbortError(error)) adapter.catalog.lastError = getErrorCode(error);
				throw error;
			}
		};
	}
	return registeredProvider;
}

export function refreshProviderRegistrations(
	pi: Pick<ExtensionAPI, "registerProvider">,
	providers: readonly ProviderAdapter[],
	runtime: PiProviderDependencies,
	officialPricing: Record<string, OfficialModelMeta>,
	providerDrafts?: ReadonlyMap<ProviderAdapter, ProviderModelDraft[]>,
): void {
	for (const adapter of providers) {
		registerProviderAdapter(pi, adapter, runtime, officialPricing, providerDrafts?.get(adapter));
	}
}

export function registerProviderAdapter(
	pi: Pick<ExtensionAPI, "registerProvider">,
	adapter: ProviderAdapter,
	runtime: PiProviderDependencies,
	officialPricing: Record<string, OfficialModelMeta> = {},
	modelDrafts?: ProviderModelDraft[],
): ProviderConfig {
	const registeredProvider = prepareProviderRegistration(adapter, runtime, officialPricing, modelDrafts);
	pi.registerProvider(adapter.id, registeredProvider);
	return registeredProvider;
}
