import type {
	ModelCostBySkuSources,
	ModelFieldSource,
	ModelFieldSources,
	ProviderCost,
	ProviderModel,
	ProviderModelDraft,
} from "./types.ts";

export type ThinkingLevelMap = NonNullable<ProviderModel["thinkingLevelMap"]>;

export const ORIGINAL_PI_PROVIDER_ALLOWLIST = new Set<string>([
	"ant-ling",
	"anthropic",
	"deepseek",
	"google",
	"kimi-coding",
	"minimax",
	"minimax-cn",
	"mistral",
	"moonshotai",
	"moonshotai-cn",
	"openai",
	"xai",
	"xiaomi",
	"zai",
	"zai-coding-cn",
]);

export interface PiCatalogModelMeta {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
	cost?: ProviderCost;
	provider?: string;
	canonicalId?: string;
	aliases?: string[];
}

export interface PiCatalogSnapshot {
	models: Map<string, PiCatalogModelMeta>;
	byProvider: Map<string, Map<string, PiCatalogModelMeta>>;
	generatedAt?: number;
	version?: string;
}

/** The generated catalog functions exposed by Pi's active pi-ai module. */
export interface PiCatalogSource {
	getBuiltinProviders: () => string[];
	getBuiltinModels: (provider: string) => unknown[];
	getBuiltinModelDataGeneratedAt?: () => number | undefined;
}

export interface ModelMatchResult {
	matched: PiCatalogModelMeta;
	matchType: "exact" | "alias" | "normalized";
	provider?: string;
}

export interface MergedModelResult {
	draft: ProviderModelDraft;
	fieldSources: ModelFieldSources;
	matchedModel?: PiCatalogModelMeta;
	matchType?: "exact" | "alias" | "normalized" | "none";
}

function cloneCost(cost: ProviderCost): ProviderCost {
	return {
		...cost,
		...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
	};
}

function cloneThinkingMap(map: Record<string, string | null>): Record<string, string | null> {
	return { ...map };
}

function isSameManufacturer(providerA: string | undefined, providerB: string | undefined): boolean {
	if (!providerA || !providerB) return false;
	if (providerA === providerB) return true;
	const families = [
		["minimax", "minimax-cn"],
		["moonshotai", "moonshotai-cn", "kimi-coding"],
		["zai", "zai-coding-cn"],
	];
	return families.some((group) => group.includes(providerA) && group.includes(providerB));
}

export function createEmptyCatalogSnapshot(): PiCatalogSnapshot {
	return {
		models: new Map(),
		byProvider: new Map(),
	};
}

export function parsePiCatalogFromProviders(
	builtinProviders: string[],
	getModels: (provider: string) => unknown[],
	generatedAt?: number,
	allowlist: ReadonlySet<string> = ORIGINAL_PI_PROVIDER_ALLOWLIST,
): PiCatalogSnapshot {
	const models = new Map<string, PiCatalogModelMeta>();
	const byProvider = new Map<string, Map<string, PiCatalogModelMeta>>();
	const collisions = new Set<string>();

	for (const providerId of builtinProviders) {
		if (!allowlist.has(providerId)) continue;
		const providerModels = new Map<string, PiCatalogModelMeta>();
		byProvider.set(providerId, providerModels);

		const rawModels = getModels(providerId);
		if (!Array.isArray(rawModels)) continue;

		for (const raw of rawModels) {
			if (!raw || typeof raw !== "object") continue;
			const item = raw as Record<string, unknown>;
			if (typeof item.id !== "string" || item.id.trim() === "") continue;

			const id = item.id.trim();
			const lowerId = id.toLowerCase();
			const meta: PiCatalogModelMeta = {
				id,
				provider: providerId,
			};

			if (typeof item.name === "string" && item.name.trim() !== "") {
				meta.name = item.name.trim();
			}
			if (typeof item.contextWindow === "number" && Number.isFinite(item.contextWindow) && item.contextWindow > 0) {
				meta.contextWindow = item.contextWindow;
			}
			if (typeof item.maxTokens === "number" && Number.isFinite(item.maxTokens) && item.maxTokens > 0) {
				meta.maxTokens = item.maxTokens;
			}
			if (typeof item.reasoning === "boolean") {
				meta.reasoning = item.reasoning;
			}
			if (Array.isArray(item.input)) {
				const filtered = item.input.filter((mode): mode is "text" | "image" => mode === "text" || mode === "image");
				if (filtered.length > 0) meta.input = [...new Set(filtered)];
			}
			if (
				item.thinkingLevelMap &&
				typeof item.thinkingLevelMap === "object" &&
				!Array.isArray(item.thinkingLevelMap)
			) {
				meta.thinkingLevelMap = cloneThinkingMap(item.thinkingLevelMap as Record<string, string | null>);
			}
			if (item.compat && typeof item.compat === "object" && !Array.isArray(item.compat)) {
				const {
					baseUrl: _b,
					api: _a,
					headers: _h,
					apiKey: _k,
					...safeCompat
				} = item.compat as Record<string, unknown>;
				meta.compat = { ...safeCompat };
			}
			if (item.cost && typeof item.cost === "object" && !Array.isArray(item.cost)) {
				meta.cost = cloneCost(item.cost as ProviderCost);
			}

			providerModels.set(lowerId, meta);

			if (collisions.has(lowerId)) {
				continue;
			}
			const existing = models.get(lowerId);
			if (existing) {
				if (isSameManufacturer(existing.provider, providerId)) {
					const existingIsPaid =
						existing.cost !== undefined && (Number(existing.cost.input) > 0 || Number(existing.cost.output) > 0);
					const metaIsZero =
						meta.cost !== undefined && Number(meta.cost.input) === 0 && Number(meta.cost.output) === 0;
					if (existingIsPaid && metaIsZero) {
						if (existing.contextWindow === undefined && meta.contextWindow !== undefined) {
							existing.contextWindow = meta.contextWindow;
						}
						if (existing.maxTokens === undefined && meta.maxTokens !== undefined) {
							existing.maxTokens = meta.maxTokens;
						}
						if (existing.reasoning === undefined && meta.reasoning !== undefined) {
							existing.reasoning = meta.reasoning;
						}
						if (!existing.input && meta.input) {
							existing.input = [...meta.input];
						}
						if (!existing.thinkingLevelMap && meta.thinkingLevelMap) {
							existing.thinkingLevelMap = cloneThinkingMap(meta.thinkingLevelMap);
						}
					} else {
						models.set(lowerId, meta);
					}
				} else {
					collisions.add(lowerId);
					models.delete(lowerId);
				}
			} else {
				models.set(lowerId, meta);
			}
		}
	}

	return {
		models,
		byProvider,
		generatedAt,
	};
}

let cachedGlobalSnapshot: PiCatalogSnapshot | undefined;
const snapshotCache = new Map<string, PiCatalogSnapshot>();
let cachedAllModule: PiCatalogSource | undefined;

function getAllowlistCacheKey(allowlist: ReadonlySet<string>): string {
	if (allowlist === ORIGINAL_PI_PROVIDER_ALLOWLIST) return "__default__";
	if (
		allowlist.size === ORIGINAL_PI_PROVIDER_ALLOWLIST.size &&
		[...allowlist].every((item) => ORIGINAL_PI_PROVIDER_ALLOWLIST.has(item))
	) {
		return "__default__";
	}
	return [...allowlist].sort().join(",");
}

export function isLegacyNormalizedModel(model: unknown): boolean {
	if (!model || typeof model !== "object") return false;
	const m = model as Record<string, unknown>;
	const cost = m.cost as Record<string, unknown> | undefined;
	return (
		m.contextWindow === 128_000 &&
		m.maxTokens === 16_384 &&
		m.reasoning === false &&
		typeof cost === "object" &&
		cost !== null &&
		cost.input === 0 &&
		cost.output === 0
	);
}

export function isLegacyNormalizedSnapshot(models: unknown): boolean {
	if (!Array.isArray(models) || models.length === 0) return false;
	return models.some(isLegacyNormalizedModel);
}

interface ModelRegistryCatalogLike {
	getAll?: () => unknown;
	getProvider?: (provider: string) => unknown;
}

function parsePiCatalogFromModelRegistry(
	modelRegistry: unknown,
	allowlist: ReadonlySet<string>,
): PiCatalogSnapshot | undefined {
	if (modelRegistry === null || typeof modelRegistry !== "object") return undefined;
	const registry = modelRegistry as ModelRegistryCatalogLike;
	const allowedProviders = new Map<string, string>();
	for (const provider of allowlist) allowedProviders.set(provider.toLowerCase(), provider);
	const grouped = new Map<string, unknown[]>();
	const addModel = (model: unknown): void => {
		if (model === null || typeof model !== "object") return;
		const provider = (model as Record<string, unknown>).provider;
		if (typeof provider !== "string") return;
		const canonicalProvider = allowedProviders.get(provider.toLowerCase());
		if (!canonicalProvider) return;
		const models = grouped.get(canonicalProvider);
		if (models) models.push(model);
		else grouped.set(canonicalProvider, [model]);
	};

	if (typeof registry.getAll === "function") {
		try {
			const models = registry.getAll();
			if (Array.isArray(models)) {
				for (const model of models) addModel(model);
				return parsePiCatalogFromProviders([...allowlist], (provider) => grouped.get(provider) ?? []);
			}
		} catch {
			// Fall through to the provider-by-provider compatibility path.
		}
	}

	if (typeof registry.getProvider !== "function") return undefined;
	let foundProvider = false;
	for (const provider of allowlist) {
		try {
			const candidate = registry.getProvider(provider);
			if (candidate === null || typeof candidate !== "object") continue;
			foundProvider = true;
			const getModels = (candidate as { getModels?: unknown }).getModels;
			if (typeof getModels !== "function") continue;
			const models = getModels.call(candidate);
			if (!Array.isArray(models)) continue;
			for (const model of models) addModel(model);
		} catch {
			// A single provider must not prevent the remaining catalog from loading.
		}
	}
	if (!foundProvider) return undefined;
	return parsePiCatalogFromProviders([...allowlist], (provider) => grouped.get(provider) ?? []);
}

function parsePiCatalogFromSource(source: PiCatalogSource, allowlist: ReadonlySet<string>): PiCatalogSnapshot {
	const providers = source.getBuiltinProviders();
	const generatedAt = source.getBuiltinModelDataGeneratedAt?.();
	return parsePiCatalogFromProviders(
		providers,
		(provider) => source.getBuiltinModels(provider),
		generatedAt,
		allowlist,
	);
}

export interface LoadPiCatalogOptions {
	allowlist?: ReadonlySet<string>;
	/** Current Pi registry, preferred over any module-local static catalog. */
	modelRegistry?: unknown;
	/** Catalog functions captured from Pi's outer extension module graph. */
	builtinCatalog?: PiCatalogSource;
	fetch?: typeof globalThis.fetch;
}

export async function loadPiCatalog(
	optionsOrAllowlist?: ReadonlySet<string> | LoadPiCatalogOptions,
): Promise<PiCatalogSnapshot> {
	const options: LoadPiCatalogOptions =
		optionsOrAllowlist && "has" in optionsOrAllowlist
			? { allowlist: optionsOrAllowlist as ReadonlySet<string> }
			: ((optionsOrAllowlist as LoadPiCatalogOptions | undefined) ?? {});
	const allowlist = options.allowlist ?? ORIGINAL_PI_PROVIDER_ALLOWLIST;

	// The registry belongs to the running Pi instance. It is intentionally not
	// cached: Pi can refresh its native catalog while the process is alive.
	if (options.modelRegistry !== undefined) {
		const runtimeSnapshot = parsePiCatalogFromModelRegistry(options.modelRegistry, allowlist);
		if (runtimeSnapshot) return runtimeSnapshot;
	}

	// A Pi-loaded entrypoint can capture the host's virtual pi-ai module before
	// handing control to the nested Jiti graph. This is what makes startup and
	// --list-models use the same catalog as the active Pi binary.
	if (options.builtinCatalog) {
		try {
			return parsePiCatalogFromSource(options.builtinCatalog, allowlist);
		} catch {
			// Fall back to the module resolved from this package below.
		}
	}

	const cacheKey = getAllowlistCacheKey(allowlist);
	if (cacheKey === "__default__" && cachedGlobalSnapshot) return cachedGlobalSnapshot;
	const cached = snapshotCache.get(cacheKey);
	if (cached) return cached;

	try {
		if (!cachedAllModule) {
			cachedAllModule = (await import("@earendil-works/pi-ai/providers/all")) as PiCatalogSource;
		}
		const snapshot = parsePiCatalogFromSource(cachedAllModule, allowlist);
		snapshotCache.set(cacheKey, snapshot);
		if (cacheKey === "__default__") {
			cachedGlobalSnapshot = snapshot;
		}
		return snapshot;
	} catch {
		const empty = createEmptyCatalogSnapshot();
		snapshotCache.set(cacheKey, empty);
		if (cacheKey === "__default__") {
			cachedGlobalSnapshot = empty;
		}
		return empty;
	}
}

export function setPiCatalogForTest(snapshot: PiCatalogSnapshot | undefined): void {
	snapshotCache.clear();
	cachedGlobalSnapshot = snapshot;
}

export function toPiCatalogSnapshot(candidate: unknown): PiCatalogSnapshot | undefined {
	if (!candidate) return cachedGlobalSnapshot ?? undefined;
	if (
		typeof candidate === "object" &&
		candidate !== null &&
		"models" in candidate &&
		(candidate as PiCatalogSnapshot).models instanceof Map
	) {
		return candidate as PiCatalogSnapshot;
	}
	if (typeof candidate === "object" && candidate !== null) {
		const rawCandidate = candidate as Record<string, any>;
		const entries =
			"models" in rawCandidate &&
			typeof rawCandidate.models === "object" &&
			rawCandidate.models !== null &&
			!(rawCandidate.models instanceof Map)
				? Object.entries(rawCandidate.models)
				: Object.entries(rawCandidate);
		const models = new Map<string, PiCatalogModelMeta>();
		for (const [id, value] of entries) {
			if (!value || typeof value !== "object") continue;
			const provider = id.includes("/") ? id.slice(0, id.indexOf("/")) : "custom";
			const rawModelId = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
			const meta: PiCatalogModelMeta = {
				id: rawModelId,
				provider,
				...(value.name ? { name: value.name } : {}),
				...(value.contextWindow !== undefined ? { contextWindow: value.contextWindow } : {}),
				...(value.maxTokens !== undefined ? { maxTokens: value.maxTokens } : {}),
				...(value.input ? { input: [...value.input] } : {}),
				...(value.reasoning !== undefined ? { reasoning: value.reasoning } : {}),
				...(value.thinkingLevelMap ? { thinkingLevelMap: { ...value.thinkingLevelMap } } : {}),
				...(value.compat ? { compat: { ...value.compat } } : {}),
				...(value.cost ? { cost: cloneCost(value.cost) } : {}),
			};
			models.set(id.toLowerCase().trim(), meta);
			models.set(rawModelId.toLowerCase().trim(), meta);
		}
		return {
			models,
			byProvider: new Map(),
			generatedAt: Date.now(),
		};
	}
	return cachedGlobalSnapshot ?? undefined;
}

/** Prefixes that identify the owning manufacturer or transport shim rather than the model name. */
const KNOWN_MODEL_PREFIXES: ReadonlySet<string> = new Set([
	...ORIGINAL_PI_PROVIDER_ALLOWLIST,
	// Vendor name spellings used by aggregators (OpenRouter-style publisher prefixes)
	"z-ai", // Z.ai
	"x-ai", // xAI
	"mistralai", // Mistral AI
	"~anthropic",
	"~deepseek",
	"~google",
	"~moonshotai",
	"~openai",
	"~x-ai", // OpenRouter mirror variants for the same manufacturers
	"openapi",
	"models",
]);

export function stripProviderPrefix(modelId: string, currentProviderId?: string): string {
	let candidate = modelId.trim();
	if (currentProviderId && candidate.toLowerCase().startsWith(`${currentProviderId.toLowerCase()}/`)) {
		candidate = candidate.slice(currentProviderId.length + 1);
	}
	const slashIndex = candidate.indexOf("/");
	if (slashIndex > 0) {
		const prefix = candidate.slice(0, slashIndex).toLowerCase();
		if (KNOWN_MODEL_PREFIXES.has(prefix)) {
			candidate = candidate.slice(slashIndex + 1);
		}
	}
	return candidate;
}

/** Trailing date pins (`-0731`, `-20251101`, `-2025-11-01`) identify a dated snapshot of a base model. */
const DATE_SUFFIX_REGEX = /-(?:20\d{2}[-_]?\d{2}[-_]?\d{2}|\d{4})$/i;
const LATEST_SUFFIX_REGEX = /-latest$/i;
const EFFORT_SUFFIX_REGEX = /-(?:minimal|low|medium|high|xhigh|max|thinking|reasoning)(?:-effort)?$/i;
const TIER_SUFFIX_REGEX = /(?:-|:)(?:free|batch)$/i;

export function stripKnownModelSuffixes(modelId: string): string {
	let result = modelId;
	let changed = true;
	while (changed) {
		const prev = result;
		result = result.replace(LATEST_SUFFIX_REGEX, "").replace(EFFORT_SUFFIX_REGEX, "").replace(TIER_SUFFIX_REGEX, "");
		changed = result !== prev;
	}
	return result;
}

export function findPiCatalogModel(
	modelId: string,
	catalog: PiCatalogSnapshot,
	currentProviderId?: string,
): ModelMatchResult | undefined {
	if (!modelId || modelId.trim() === "") return undefined;
	const trimmed = modelId.trim();
	const lower = trimmed.toLowerCase();

	const lookup = (candidate: string): PiCatalogModelMeta | undefined => {
		if (currentProviderId) {
			const inProvider = catalog.byProvider.get(currentProviderId.toLowerCase())?.get(candidate);
			if (inProvider) return inProvider;
		}
		return catalog.models.get(candidate);
	};

	// Step 1: Exact match of full ID
	const exact = lookup(lower);
	if (exact) {
		return { matched: exact, matchType: "exact", provider: exact.provider };
	}

	// Step 2: Strip transport provider prefix
	const strippedPrefix = stripProviderPrefix(trimmed, currentProviderId).toLowerCase();
	if (strippedPrefix !== lower) {
		const strippedMatch = lookup(strippedPrefix);
		if (strippedMatch) {
			return { matched: strippedMatch, matchType: "normalized", provider: strippedMatch.provider };
		}
	}

	// Step 3: Strip known model suffixes (tier free/batch, latest, effort)
	const baseModelName = stripKnownModelSuffixes(strippedPrefix).toLowerCase();
	if (baseModelName !== "" && baseModelName !== strippedPrefix) {
		const baseMatch = lookup(baseModelName);
		if (baseMatch) {
			return { matched: baseMatch, matchType: "normalized", provider: baseMatch.provider };
		}
	}

	// Step 4: Search for a unique candidate whose normalized ID matches the
	// query. The pool is scoped to the current provider when it is catalogued,
	// falling back to the global model pool otherwise (custom providers are
	// never catalogued, so an empty pool would silently defeat this lookup).
	const searchUniqueCandidate = (queryNames: readonly string[]): PiCatalogModelMeta | undefined => {
		const providerPool = currentProviderId ? catalog.byProvider.get(currentProviderId.toLowerCase()) : undefined;
		const searchPool = providerPool?.values() ?? catalog.models.values();

		const uniqueCandidates = new Map<string, PiCatalogModelMeta>();
		for (const candidate of searchPool) {
			const candLower = candidate.id.toLowerCase();
			const candNormalized = stripKnownModelSuffixes(
				stripProviderPrefix(candidate.id, candidate.provider).toLowerCase(),
			).toLowerCase();
			if (queryNames.some((name) => name !== "" && (name === candLower || name === candNormalized))) {
				uniqueCandidates.set(candidate.id.toLowerCase(), candidate);
			}
		}
		if (uniqueCandidates.size === 1) {
			return uniqueCandidates.values().next().value as PiCatalogModelMeta;
		}
		return undefined;
	};

	const poolMatch = searchUniqueCandidate([strippedPrefix, baseModelName]);
	if (poolMatch) {
		return { matched: poolMatch, matchType: "normalized", provider: poolMatch.provider };
	}

	// Step 5: A date-pinned snapshot falls back to its bare base model only when
	// no pinned entry matched (exact dated matches already returned in step 1).
	// This resolves e.g. "deepseek-v4-flash-0731" to the "deepseek-v4-flash"
	// catalog entry. The bare base entry is the only acceptable substitute: a
	// bare query never resolves to a dated entry, and one pinned date never
	// substitutes another.
	const dateStripped = baseModelName.replace(DATE_SUFFIX_REGEX, "").toLowerCase();
	if (dateStripped !== "" && dateStripped !== baseModelName) {
		const dateBaseMatch = lookup(dateStripped);
		if (dateBaseMatch) {
			return { matched: dateBaseMatch, matchType: "normalized", provider: dateBaseMatch.provider };
		}
		const datePoolMatch = searchUniqueCandidate([dateStripped]);
		if (datePoolMatch) {
			return { matched: datePoolMatch, matchType: "normalized", provider: datePoolMatch.provider };
		}
	}

	return undefined;
}

export function mergeModelWithPiCatalog(
	draft: ProviderModelDraft,
	catalog: PiCatalogSnapshot | undefined,
	options: {
		useFallback?: boolean;
		currentProviderId?: string;
	} = {},
): MergedModelResult {
	const useFallback = options.useFallback ?? true;
	if (!useFallback || !catalog) {
		return {
			draft: { ...draft },
			fieldSources: {
				contextWindow: draft.contextWindow !== undefined ? "provider" : "default",
				maxTokens: draft.maxTokens !== undefined ? "provider" : "default",
				input: draft.input !== undefined ? "provider" : "default",
				reasoning: draft.reasoning !== undefined ? "provider" : "default",
				thinkingLevelMap: draft.thinkingLevelMap !== undefined ? "provider" : "default",
				cost: draft.cost !== undefined ? (draft.pricingSource ?? "provider") : "default",
			},
			matchType: "none",
		};
	}

	const matchResult = findPiCatalogModel(draft.id, catalog, options.currentProviderId);
	const piMeta = matchResult?.matched;
	const matchType = matchResult?.matchType ?? "none";

	// Number fields
	const contextWindow = draft.contextWindow !== undefined ? draft.contextWindow : piMeta?.contextWindow;
	const contextWindowSource =
		draft.contextWindow !== undefined ? "provider" : piMeta?.contextWindow !== undefined ? "pi" : "default";

	const maxTokens = draft.maxTokens !== undefined ? draft.maxTokens : piMeta?.maxTokens;
	const maxTokensSource =
		draft.maxTokens !== undefined ? "provider" : piMeta?.maxTokens !== undefined ? "pi" : "default";

	// Boolean reasoning
	const reasoning = draft.reasoning !== undefined ? draft.reasoning : piMeta?.reasoning;
	const reasoningSource =
		draft.reasoning !== undefined ? "provider" : piMeta?.reasoning !== undefined ? "pi" : "default";

	// Input modes
	const input = draft.input !== undefined ? draft.input : piMeta?.input ? [...piMeta.input] : undefined;
	const inputSource = draft.input !== undefined ? "provider" : piMeta?.input !== undefined ? "pi" : "default";

	// Thinking level map
	let thinkingLevelMap: ThinkingLevelMap | undefined;
	let thinkingLevelMapSource: "provider" | "pi" | "mixed" | "default" = "default";

	if (draft.reasoning === false) {
		thinkingLevelMap = undefined;
		thinkingLevelMapSource = "default";
	} else if (draft.thinkingLevelMap !== undefined && piMeta?.thinkingLevelMap !== undefined) {
		const allLevels = new Set([...Object.keys(piMeta.thinkingLevelMap), ...Object.keys(draft.thinkingLevelMap)]);
		const mergedMap: Record<string, string | null> = {};
		let hasProviderLevel = false;
		let hasPiLevel = false;

		const draftThinkingMap = draft.thinkingLevelMap as Record<string, string | null>;
		const piThinkingMap = piMeta.thinkingLevelMap as Record<string, string | null>;
		for (const level of allLevels) {
			if (level in draftThinkingMap) {
				mergedMap[level] = draftThinkingMap[level] as string | null;
				hasProviderLevel = true;
			} else if (level in piThinkingMap) {
				mergedMap[level] = piThinkingMap[level] as string | null;
				hasPiLevel = true;
			}
		}
		thinkingLevelMap = mergedMap;
		thinkingLevelMapSource = hasProviderLevel && hasPiLevel ? "mixed" : hasProviderLevel ? "provider" : "pi";
	} else if (draft.thinkingLevelMap !== undefined) {
		thinkingLevelMap = { ...draft.thinkingLevelMap };
		thinkingLevelMapSource = "provider";
	} else if (piMeta?.thinkingLevelMap !== undefined) {
		thinkingLevelMap = cloneThinkingMap(piMeta.thinkingLevelMap);
		thinkingLevelMapSource = "pi";
	}

	// Compat
	const compat =
		draft.compat !== undefined || piMeta?.compat !== undefined
			? { ...(piMeta?.compat ?? {}), ...(draft.compat ?? {}) }
			: undefined;

	// Cost merging by SKU
	let mergedCost: ProviderCost | undefined;
	let costSource: ModelFieldSource = "default";
	let costBySku: ModelCostBySkuSources | undefined;

	if (draft.cost !== undefined && piMeta?.cost !== undefined) {
		const draftCost = draft.cost;
		const piCost = piMeta.cost;
		costBySku = {
			input: draftCost.input !== undefined ? "provider" : piCost.input !== undefined ? "pi" : "default",
			output: draftCost.output !== undefined ? "provider" : piCost.output !== undefined ? "pi" : "default",
			cacheRead: draftCost.cacheRead !== undefined ? "provider" : piCost.cacheRead !== undefined ? "pi" : "default",
			cacheWrite:
				draftCost.cacheWrite !== undefined ? "provider" : piCost.cacheWrite !== undefined ? "pi" : "default",
		};
		const values = [costBySku.input, costBySku.output, costBySku.cacheRead, costBySku.cacheWrite];
		const hasProviderSku = values.some((v) => v === "provider");
		const hasPiSku = values.some((v) => v === "pi");
		costSource = hasProviderSku && hasPiSku ? "mixed" : hasProviderSku ? (draft.pricingSource ?? "provider") : "pi";
		mergedCost = {
			input: draftCost.input ?? piCost.input ?? 0,
			output: draftCost.output ?? piCost.output ?? 0,
			cacheRead: draftCost.cacheRead ?? piCost.cacheRead ?? 0,
			cacheWrite: draftCost.cacheWrite ?? piCost.cacheWrite ?? 0,
			...(draftCost.tiers
				? { tiers: draftCost.tiers.map((t) => ({ ...t })) }
				: piCost.tiers
					? { tiers: piCost.tiers.map((t) => ({ ...t })) }
					: {}),
		};
	} else if (draft.cost !== undefined) {
		mergedCost = cloneCost(draft.cost);
		costSource = draft.pricingSource ?? "provider";
		costBySku = {
			input: "provider",
			output: "provider",
			cacheRead: "provider",
			cacheWrite: "provider",
		};
	} else if (piMeta?.cost !== undefined) {
		mergedCost = cloneCost(piMeta.cost);
		costSource = "pi";
		costBySku = {
			input: "pi",
			output: "pi",
			cacheRead: "pi",
			cacheWrite: "pi",
		};
	}

	const name = draft.name !== undefined ? draft.name : piMeta?.name;

	const mergedDraft: ProviderModelDraft = {
		...draft,
		...(name !== undefined ? { name } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		...(input !== undefined ? { input } : {}),
		...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
		...(compat !== undefined ? { compat } : {}),
		...(mergedCost !== undefined
			? {
					cost: mergedCost,
					pricingSource:
						costSource === "mixed" ? "mixed" : costSource === "pi" ? "pi" : (draft.pricingSource ?? "provider"),
				}
			: {}),
	};

	const fieldSources: ModelFieldSources = {
		contextWindow: contextWindowSource,
		maxTokens: maxTokensSource,
		reasoning: reasoningSource,
		input: inputSource,
		thinkingLevelMap: thinkingLevelMapSource,
		cost: costSource,
		...(costBySku ? { costBySku } : {}),
	};

	return {
		draft: mergedDraft,
		fieldSources,
		matchedModel: piMeta,
		matchType,
	};
}
