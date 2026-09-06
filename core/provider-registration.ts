import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { validateProviderModelDrafts } from "./adapter-validation.ts";
import { mergeModelWithPiCatalog, type PiCatalogSnapshot, toPiCatalogSnapshot } from "./pi-model-metadata.ts";
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

type ProviderRegistrationApi = {
	registerProvider(name: string, config: ProviderConfig): void;
	unregisterProvider?(name: string): void;
};

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
	validateProviderModelDrafts(models);
	const seen = new Set<string>();
	return models.map((model) => {
		const normalized = normalizeProviderModel(model);
		if (seen.has(normalized.id)) throw new Error(`Duplicate model ID: ${normalized.id}`);
		seen.add(normalized.id);
		return normalized;
	});
}

function selectPricingAdjustment(
	adapter: ProviderAdapter,
	model: ProviderModelDraft,
	policy = adapter.pricing,
): ProviderPricingAdjustment | undefined {
	return model.pricingAdjustment ?? policy?.models?.[model.id.trim()] ?? policy?.defaultAdjustment;
}

function costsEqual(left: ProviderModelDraft["cost"], right: ProviderCost): boolean {
	if (left === undefined) return false;
	const candidate = left as Partial<ProviderCost>;
	if (
		candidate.input !== right.input ||
		candidate.output !== right.output ||
		candidate.cacheRead !== right.cacheRead ||
		candidate.cacheWrite !== right.cacheWrite
	) {
		return false;
	}
	const leftTiers = candidate.tiers ?? [];
	const rightTiers = right.tiers ?? [];
	return (
		leftTiers.length === rightTiers.length &&
		leftTiers.every((tier, index) => {
			const normalized = rightTiers[index];
			return (
				normalized !== undefined &&
				tier.inputTokensAbove === normalized.inputTokensAbove &&
				tier.input === normalized.input &&
				tier.output === normalized.output &&
				tier.cacheRead === normalized.cacheRead &&
				tier.cacheWrite === normalized.cacheWrite
			);
		})
	);
}

function inputsEqual(left: ProviderModelDraft["input"], right: ProviderModel["input"]): boolean {
	return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveModelRegistration(
	adapter: ProviderAdapter,
	runtime: PiProviderDependencies,
	modelDrafts: ProviderModelDraft[],
	catalogSnapshot?: PiCatalogSnapshot | Record<string, unknown>,
): { models: ProviderModel[]; modelMetadata: Record<string, ProviderModelMetadata> } {
	validateProviderModelDrafts(modelDrafts, `Provider ${adapter.id}`);
	const catalog = toPiCatalogSnapshot(catalogSnapshot);
	const pricingPolicy = runtime.pricingPolicies?.[adapter.id] ?? adapter.pricing;
	const metadata: Record<string, ProviderModelMetadata> = {};
	const adjustedDrafts = modelDrafts.map((originalDraft) => {
		const modelId = originalDraft.id.trim();
		const useFallback = adapter.usePiModelMetaFallback ?? true;
		const merged = mergeModelWithPiCatalog(originalDraft, catalog, {
			useFallback,
			currentProviderId: adapter.id,
		});
		const mergedDraft = merged.draft;
		const fieldSources = { ...merged.fieldSources };

		const normalizedModel = normalizeProviderModel(mergedDraft);
		const normalizedCost = normalizeCost(mergedDraft.cost);

		if (mergedDraft.contextWindow !== undefined && mergedDraft.contextWindow !== normalizedModel.contextWindow) {
			fieldSources.contextWindow = "normalized";
		}
		if (mergedDraft.maxTokens !== undefined && mergedDraft.maxTokens !== normalizedModel.maxTokens) {
			fieldSources.maxTokens = "normalized";
		}
		if (mergedDraft.input !== undefined && !inputsEqual(mergedDraft.input, normalizedModel.input)) {
			fieldSources.input = "normalized";
		}
		if (mergedDraft.reasoning !== undefined && mergedDraft.reasoning !== normalizedModel.reasoning) {
			fieldSources.reasoning = "normalized";
		}
		if (mergedDraft.cost !== undefined && !costsEqual(mergedDraft.cost, normalizedCost)) {
			fieldSources.cost = "normalized";
		}

		const source: ProviderPricingSource | "none" =
			mergedDraft.cost === undefined
				? "none"
				: (mergedDraft.pricingSource ??
					(fieldSources.cost === "mixed"
						? "mixed"
						: fieldSources.cost === "pi"
							? "pi"
							: fieldSources.cost === "provider"
								? "provider"
								: (originalDraft.pricingSource ?? "provider")));

		const pricing = resolvePricingDetails(
			mergedDraft.cost === undefined ? undefined : normalizedCost,
			source,
			selectPricingAdjustment(adapter, mergedDraft, pricingPolicy),
		);
		if (fieldSources.costBySku) {
			pricing.costBySku = fieldSources.costBySku;
		}
		metadata[modelId] = {
			pricing,
			fieldSources,
		};
		return {
			...mergedDraft,
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

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENVIRONMENT_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Match Pi's `$NAME` / `${NAME}` interpolation without executing API-key commands. */
function getEnvironmentReferences(value: string): string[] {
	if (value.startsWith("!")) return [];
	const names = new Set<string>();
	let index = 0;
	while (index < value.length) {
		const dollarIndex = value.indexOf("$", index);
		if (dollarIndex < 0) break;
		const next = value[dollarIndex + 1];
		if (next === "$" || next === "!") {
			index = dollarIndex + 2;
			continue;
		}
		if (next === "{") {
			const endIndex = value.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				index = dollarIndex + 1;
				continue;
			}
			const name = value.slice(dollarIndex + 2, endIndex);
			if (ENVIRONMENT_NAME.test(name)) names.add(name);
			index = endIndex + 1;
			continue;
		}
		const match = value.slice(dollarIndex + 1).match(ENVIRONMENT_NAME_PREFIX);
		if (match) {
			names.add(match[0]);
			index = dollarIndex + 1 + match[0].length;
		} else {
			index = dollarIndex + 1;
		}
	}
	return [...names];
}

function getRegistrationState(adapter: ProviderAdapter): NonNullable<ProviderAdapter["registration"]> | undefined {
	const registration = adapter.registration;
	if (!registration) return undefined;
	registration.normalizedModels ??= [];
	registration.modelMetadata ??= {};
	registration.activeRefreshes ??= 0;
	return registration;
}

function replaceModels(target: ProviderModel[], source: ProviderModel[]): ProviderModel[] {
	target.splice(0, target.length, ...source);
	return target;
}

function hasMissingEnvironmentReference(apiKey: string): boolean {
	const environmentNames = getEnvironmentReferences(apiKey);
	return environmentNames.length > 0 && environmentNames.some((name) => !process.env[name]);
}

function lacksCatalogRefreshCredential(apiKey: string, context: ProviderRefreshContext): boolean {
	return context.allowNetwork === true && context.credential === undefined && hasMissingEnvironmentReference(apiKey);
}

function shouldOmitOptionalApiKey(adapter: ProviderAdapter, runtime: PiProviderDependencies): boolean {
	return (
		adapter.provider.oauth !== undefined &&
		hasMissingEnvironmentReference(adapter.provider.apiKey) &&
		runtime.readStoredCredential(adapter.id)?.type !== "api_key"
	);
}

/**
 * Register a normalized Provider before the Host has assembled its final
 * registry. The original drafts remain attached to the adapter so a Host in a
 * different module context can apply official metadata later.
 */
export function prepareProviderRegistration(
	adapter: ProviderAdapter,
	runtime: PiProviderDependencies,
	catalogSnapshot?: PiCatalogSnapshot | Record<string, unknown>,
	modelDrafts?: ProviderModelDraft[],
): ProviderConfig {
	const drafts =
		modelDrafts ??
		(adapter.registration?.normalizedModels === adapter.provider.models
			? adapter.registration.modelDrafts
			: adapter.provider.models);
	const lifecycle = adapter.lifecycle ?? (adapter.provider.refreshModels as any)?.lifecycle;
	if (lifecycle && drafts && drafts.length > 0) {
		lifecycle.setModels(drafts, adapter.catalog?.source, adapter.catalog?.updatedAt);
	}
	const catalog = toPiCatalogSnapshot(catalogSnapshot);
	const resolved = resolveModelRegistration(adapter, runtime, drafts, catalog);
	const existingRegistration = getRegistrationState(adapter);
	const registration: NonNullable<ProviderAdapter["registration"]> = existingRegistration ?? {
		modelDrafts: drafts,
		normalizedModels: [],
		modelMetadata: {},
		piCatalog: catalog,
		activeRefreshes: 0,
	};
	registration.modelDrafts = drafts;
	registration.modelMetadata = resolved.modelMetadata;
	registration.piCatalog = catalog;
	registration.officialPricing = catalogSnapshot as any;
	const models = replaceModels(registration.normalizedModels, resolved.models);
	const adapterOwnsCatalog = adapter.catalog !== undefined;
	adapter.registration = registration;
	adapter.provider.models = models;
	adapter.catalog ??= { source: "static", modelCount: models.length };
	adapter.catalog.modelCount = models.length;

	const { models: _draftModels, refreshModels: originalRefresh, ...providerMetadata } = adapter.provider;
	const registeredProvider: ProviderConfig = { ...providerMetadata, models };
	// Pi 0.84.2 resolves a declared environment API key before it can skip an
	// unauthenticated catalog refresh. Register OAuth-only until the optional
	// key exists, while preserving API-key credentials already stored by Pi.
	if (shouldOmitOptionalApiKey(adapter, runtime)) delete registeredProvider.apiKey;
	if (originalRefresh) {
		registeredProvider.refreshModels = async (options: ProviderRefreshContext) => {
			// Pi may ask every dynamic Provider to refresh. Keep the current catalog
			// when this Provider's environment-backed key is absent instead of
			// attempting an unauthenticated request that becomes a global refresh error.
			if (lacksCatalogRefreshCredential(adapter.provider.apiKey, options)) {
				return [...registration.normalizedModels];
			}
			registration.activeRefreshes++;
			try {
				const refreshedModels = await originalRefresh(options);
				const resolved = resolveModelRegistration(
					adapter,
					runtime,
					refreshedModels,
					registration.piCatalog ?? registration.officialPricing,
				);
				const normalizedModels = replaceModels(registration.normalizedModels, resolved.models);
				registration.modelDrafts = refreshedModels;
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
				return [...normalizedModels];
			} catch (error) {
				if (adapter.catalog && !isAbortError(error)) adapter.catalog.lastError = getErrorCode(error);
				throw error;
			} finally {
				registration.activeRefreshes = Math.max(0, registration.activeRefreshes - 1);
				if (registration.activeRefreshes === 0 && registration.deferredRegistration) {
					const deferred = registration.deferredRegistration;
					registration.deferredRegistration = undefined;
					queueMicrotask(deferred);
				}
			}
		};
	}
	return registeredProvider;
}

export function cancelDeferredProviderRegistrations(providers: readonly ProviderAdapter[]): void {
	for (const adapter of providers) {
		const registration = getRegistrationState(adapter);
		if (registration) registration.deferredRegistration = undefined;
	}
}

export function refreshProviderRegistrations(
	pi: ProviderRegistrationApi,
	providers: readonly ProviderAdapter[],
	runtime: PiProviderDependencies,
	catalogSnapshot?: PiCatalogSnapshot | Record<string, unknown>,
	providerDrafts?: ReadonlyMap<ProviderAdapter, ProviderModelDraft[]>,
): void {
	const catalog = toPiCatalogSnapshot(catalogSnapshot);
	for (const adapter of providers) {
		const registration = getRegistrationState(adapter);
		if (registration) {
			registration.piCatalog = catalog;
			registration.officialPricing = catalogSnapshot as any;
		}
		if (registration && registration.activeRefreshes > 0) {
			registration.deferredRegistration = () =>
				registerProviderAdapter(pi, adapter, runtime, catalogSnapshot, providerDrafts?.get(adapter));
			continue;
		}
		registerProviderAdapter(pi, adapter, runtime, catalogSnapshot, providerDrafts?.get(adapter));
	}
}

export function registerProviderAdapter(
	pi: ProviderRegistrationApi,
	adapter: ProviderAdapter,
	runtime: PiProviderDependencies,
	catalogSnapshot?: PiCatalogSnapshot | Record<string, unknown>,
	modelDrafts?: ProviderModelDraft[],
): ProviderConfig {
	const registeredProvider = prepareProviderRegistration(adapter, runtime, catalogSnapshot, modelDrafts);
	// Pi merges re-registrations, so omission alone cannot clear a raw API key
	// left by the previous extension instance during /reload.
	if (registeredProvider.apiKey === undefined) pi.unregisterProvider?.(adapter.id);
	pi.registerProvider(adapter.id, registeredProvider);
	return registeredProvider;
}
