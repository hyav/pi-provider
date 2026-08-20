import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export type ProviderCost = ProviderModelConfig["cost"];
export type ProviderModel = ProviderModelConfig;
export type PricingSku = "input" | "output" | "cacheRead" | "cacheWrite";
/** Pricing provenance used by Pi Provider sidecars; not added to Pi model objects. */
export type ProviderPricingSource = "provider" | "fallback" | "official";
export type ModelPricingSource = ProviderPricingSource | "native";
export type ModelFieldSource = ProviderPricingSource | "native" | "default";
export type ModelMetadataState = "fresh" | "stale" | "checking" | "unavailable";

export interface ModelMetadataStatus {
	state: ModelMetadataState;
	updatedAt?: number;
	source?: string;
}

/**
 * Narrow credential shape shared across Pi's isolated extension module contexts.
 * The full Credential type comes from Pi's bundled AI package; consumers of
 * injected credential readers must not rely on `instanceof` or extra fields.
 */
export interface StoredCredentialLike {
	readonly type?: string;
	readonly teamName?: string;
}

export interface ModelFieldSources {
	contextWindow?: ModelFieldSource;
	maxTokens?: ModelFieldSource;
	input?: ModelFieldSource;
	reasoning?: ModelFieldSource;
}

export interface ProviderPricingAdjustment {
	/** 0.8 means a 20% discount; values above 1 represent a markup. */
	multiplier: number;
	label: string;
	source?: string;
	/** Whether this explicit adjustment may be applied to a reference price. */
	appliesToReference?: boolean;
	appliesTo?: readonly PricingSku[];
}

export interface ProviderPricingPolicy {
	defaultAdjustment?: ProviderPricingAdjustment;
	models?: Record<string, ProviderPricingAdjustment>;
}

export interface ModelPricingDetails {
	known: boolean;
	source: ModelPricingSource | "none";
	baseCost?: ProviderCost;
	effectiveCost?: ProviderCost;
	adjustment?: ProviderPricingAdjustment;
	note?: string;
}

export interface ModelQualityScore {
	source: string;
	benchmark: string;
	category: string;
	metric: "elo" | "rating" | "score" | "ips";
	value: number;
	rank?: number;
	winRate?: number;
	confidenceInterval?: {
		lower: number;
		upper: number;
	};
}

export interface ProviderModelMetadata {
	pricing: ModelPricingDetails;
	fieldSources?: ModelFieldSources;
	quality?: ModelQualityScore[];
}

export type ProviderModelDraft = Partial<ProviderModel> &
	Pick<ProviderModel, "id"> & {
		pricingSource?: ProviderPricingSource;
		pricingAdjustment?: ProviderPricingAdjustment;
	};
export type ProviderRefreshContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];
export type ActiveModel = NonNullable<ExtensionContext["model"]>;
export type TunerContext = Pick<ExtensionContext, "model">;

export type ProviderDefinition = Omit<ProviderConfig, "models" | "refreshModels"> & {
	name: string;
	baseUrl: string;
	apiKey: string;
	api: ProviderConfig["api"];
	headers?: ProviderConfig["headers"];
	oauth?: ProviderConfig["oauth"];
	models: ProviderModelDraft[];
	refreshModels?: (context: ProviderRefreshContext) => Promise<ProviderModelDraft[]>;
};

export type ModelCatalogSource = "static" | "live" | "fallback";

export interface ModelCatalogStatus {
	source: ModelCatalogSource;
	modelCount: number;
	updatedAt?: number;
	lastError?: string;
}

export interface StatusTextEntry {
	kind: "text";
	id: string;
	label: string;
	value: string;
}

export interface StatusAmountEntry {
	kind: "amount";
	id: string;
	label: string;
	value: number;
	unit: string;
}

export interface StatusWindowEntry {
	kind: "window";
	id: string;
	label: string;
	remainingPercent: number;
	resetAt?: number;
}

export type StatusEntry = StatusTextEntry | StatusAmountEntry | StatusWindowEntry;

export interface StatusSnapshot {
	entries: StatusEntry[];
	updatedAt: number;
}

export interface StatusContext {
	fetch: typeof globalThis.fetch;
	getApiKey: () => Promise<string | undefined>;
	/** Optional non-secret credential metadata for provider-specific account labels. */
	getCredentialMetadata?: () => unknown;
	/** Optional non-secret credential type ("oauth" vs "api_key") for providers with dual auth modes. */
	getCredentialType?: () => Promise<string | undefined>;
	signal?: AbortSignal;
	now: () => number;
}

export interface StatusAdapter {
	id: string;
	providerId: string;
	name: string;
	cacheTtlMs: number;
	requestTimeoutMs: number;
	fetch(context: StatusContext): Promise<StatusSnapshot>;
}

export interface TunerAdapter {
	id: string;
	/** Lower priorities run first. Ties use deterministic Adapter ID order. */
	priority?: number;
	matches(context: TunerContext, payload: unknown): boolean;
	transform(payload: unknown, context: TunerContext): unknown | undefined | Promise<unknown | undefined>;
}

export interface ProviderAdapter {
	id: string;
	provider: ProviderDefinition;
	/** Optional explicit price adjustments owned by this Provider. */
	pricing?: ProviderPricingPolicy;
	catalog?: ModelCatalogStatus;
	/** @internal Draft state shared across isolated Adapter and Host contexts. */
	registration?: {
		modelDrafts: ProviderModelDraft[];
		normalizedModels?: ProviderModel[];
		modelMetadata?: Record<string, ProviderModelMetadata>;
	};
}

export type PiApi = ExtensionAPI;
