import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withDeadline } from "./deadline.ts";
import type { ModelQualityScore, ProviderCost, ProviderModel, ProviderModelDraft } from "./types.ts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const DEFAULT_PRICING_CACHE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_PRICING_MAX_STALE_MS = 24 * 60 * 60 * 1_000;
const PERSISTED_PRICING_CACHE_VERSION = 3 as const;
const REQUIRED_OPENROUTER_PRICE_FIELDS = ["prompt", "completion"] as const;
const OPTIONAL_OPENROUTER_PRICE_FIELDS = ["input_cache_read", "input_cache_write"] as const;

type ThinkingLevelMap = NonNullable<ProviderModel["thinkingLevelMap"]>;

export interface OfficialModelMeta {
	cost: ProviderCost;
	/** False when pricing is missing or invalid, including identity-only entries. */
	costKnown?: boolean;
	quality?: ModelQualityScore[];
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: ("text" | "image")[];
	compat?: {
		supportsStore?: boolean;
		supportsReasoningEffort?: boolean;
	};
	/** OpenRouter identity data used to resolve versioned aliases for read-only metadata. */
	identity?: {
		sourceId: string;
		familyId: string;
		canonicalId?: string;
		aliasTargetId?: string;
		version?: string;
		created?: number;
		latestAlias?: boolean;
	};
}

export interface OfficialPricingFetchOptions {
	/** Optional persistent cache file. Omit for process-only caching (for example, in unit tests). */
	cachePath?: string;
	/** Return the current snapshot immediately and refresh an expired/missing cache in the background. */
	background?: boolean;
	/** Observe the completed background snapshot without delaying the initial caller. */
	onBackgroundRefresh?: (snapshot: Record<string, OfficialModelMeta>) => void;
}

interface PricingCacheEntry {
	snapshot: Record<string, OfficialModelMeta>;
	updatedAt: number;
}

interface PersistedPricingCache {
	version: typeof PERSISTED_PRICING_CACHE_VERSION;
	sourceUrl: string;
	updatedAt: number;
	snapshot: Record<string, OfficialModelMeta>;
}

const MAX_PRICING_CACHE_ENTRIES = 32;
const pricingCache = new Map<string, PricingCacheEntry>();
const pricingRequests = new Map<string, Promise<Record<string, OfficialModelMeta>>>();

/** Default cache for OpenRouter metadata, not Pi's native model catalog. */
export function getDefaultOpenRouterMetadataCachePath(agentDir: string): string {
	return join(agentDir, "pi-provider", "openrouter-model-metadata.json");
}

function cloneCost(cost: ProviderCost): ProviderCost {
	return {
		...cost,
		...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
	};
}

function cloneMeta(meta: OfficialModelMeta): OfficialModelMeta {
	return {
		...meta,
		cost: cloneCost(meta.cost),
		...(meta.costKnown === false ? { costKnown: false } : {}),
		...(meta.input ? { input: [...meta.input] } : {}),
		...(meta.thinkingLevelMap ? { thinkingLevelMap: { ...meta.thinkingLevelMap } } : {}),
		...(meta.compat ? { compat: { ...meta.compat } } : {}),
		...(meta.identity ? { identity: { ...meta.identity } } : {}),
		...(meta.quality
			? {
					quality: meta.quality.map((score) => ({
						...score,
						...(score.confidenceInterval ? { confidenceInterval: { ...score.confidenceInterval } } : {}),
					})),
				}
			: {}),
	};
}

function cloneSnapshot(snapshot: Record<string, OfficialModelMeta>): Record<string, OfficialModelMeta> {
	return Object.fromEntries(Object.entries(snapshot).map(([key, meta]) => [key, cloneMeta(meta)]));
}

export function setPricingCache(
	cache: Record<string, OfficialModelMeta>,
	pricingUrl = OPENROUTER_MODELS_URL,
	updatedAt = Date.now(),
): void {
	pricingCache.delete(pricingUrl);
	pricingCache.set(pricingUrl, { snapshot: cloneSnapshot(cache), updatedAt });
	while (pricingCache.size > MAX_PRICING_CACHE_ENTRIES) {
		const oldest = pricingCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		pricingCache.delete(oldest);
	}
}

export function getPricingCache(pricingUrl = OPENROUTER_MODELS_URL): Record<string, OfficialModelMeta> {
	return cloneSnapshot(pricingCache.get(pricingUrl)?.snapshot ?? {});
}

export function getPricingCacheAge(pricingUrl = OPENROUTER_MODELS_URL, now = Date.now()): number | undefined {
	const updatedAt = pricingCache.get(pricingUrl)?.updatedAt;
	return updatedAt === undefined ? undefined : Math.max(0, now - updatedAt);
}

export function clearPricingCache(pricingUrl?: string): void {
	if (pricingUrl === undefined) pricingCache.clear();
	else pricingCache.delete(pricingUrl);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPersistableTier(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		typeof value.inputTokensAbove === "number" &&
		Number.isInteger(value.inputTokensAbove) &&
		value.inputTokensAbove > 0 &&
		isFiniteNonNegative(value.input) &&
		isFiniteNonNegative(value.output) &&
		isFiniteNonNegative(value.cacheRead) &&
		isFiniteNonNegative(value.cacheWrite)
	);
}

function isPersistableCost(value: unknown): value is ProviderCost {
	if (!isRecord(value)) return false;
	if (!["input", "output", "cacheRead", "cacheWrite"].every((key) => isFiniteNonNegative(value[key]))) return false;
	return value.tiers === undefined || (Array.isArray(value.tiers) && value.tiers.every(isPersistableTier));
}

function isPersistableQuality(value: unknown): value is ModelQualityScore {
	if (!isRecord(value)) return false;
	if (typeof value.source !== "string" || value.source.trim() === "") return false;
	if (typeof value.benchmark !== "string" || value.benchmark.trim() === "") return false;
	if (typeof value.category !== "string" || value.category.trim() === "") return false;
	if (value.metric !== "elo" && value.metric !== "rating" && value.metric !== "score" && value.metric !== "ips") {
		return false;
	}
	if (!isFiniteNonNegative(value.value)) return false;
	if (value.rank !== undefined && !isPositiveInteger(value.rank)) return false;
	if (value.winRate !== undefined && !isFiniteNonNegative(value.winRate)) return false;
	if (value.confidenceInterval !== undefined) {
		if (!isRecord(value.confidenceInterval)) return false;
		if (
			!isFiniteNonNegative(value.confidenceInterval.lower) ||
			!isFiniteNonNegative(value.confidenceInterval.upper)
		) {
			return false;
		}
	}
	return true;
}

function isPersistableIdentity(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (typeof value.sourceId !== "string" || value.sourceId.trim() === "") return false;
	if (typeof value.familyId !== "string" || value.familyId.trim() === "") return false;
	if (value.canonicalId !== undefined && typeof value.canonicalId !== "string") return false;
	if (value.aliasTargetId !== undefined && typeof value.aliasTargetId !== "string") return false;
	if (value.version !== undefined && typeof value.version !== "string") return false;
	if (value.created !== undefined && !isFiniteNonNegative(value.created)) return false;
	return value.latestAlias === undefined || typeof value.latestAlias === "boolean";
}

function isPersistableMeta(value: unknown): value is OfficialModelMeta {
	if (!isRecord(value) || !isPersistableCost(value.cost)) return false;
	if (value.identity !== undefined && !isPersistableIdentity(value.identity)) return false;
	if (value.costKnown !== undefined && typeof value.costKnown !== "boolean") return false;
	if (value.quality !== undefined && (!Array.isArray(value.quality) || !value.quality.every(isPersistableQuality))) {
		return false;
	}
	if (value.name !== undefined && typeof value.name !== "string") return false;
	if (value.contextWindow !== undefined && !isPositiveInteger(value.contextWindow)) return false;
	if (value.maxTokens !== undefined && !isPositiveInteger(value.maxTokens)) return false;
	if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") return false;
	if (
		value.input !== undefined &&
		(!Array.isArray(value.input) || value.input.some((item) => item !== "text" && item !== "image"))
	) {
		return false;
	}
	if (value.thinkingLevelMap !== undefined) {
		if (!isRecord(value.thinkingLevelMap)) return false;
		if (Object.values(value.thinkingLevelMap).some((item) => item !== null && typeof item !== "string")) return false;
	}
	if (value.compat !== undefined) {
		if (!isRecord(value.compat)) return false;
		if (
			(value.compat.supportsStore !== undefined && typeof value.compat.supportsStore !== "boolean") ||
			(value.compat.supportsReasoningEffort !== undefined &&
				typeof value.compat.supportsReasoningEffort !== "boolean")
		) {
			return false;
		}
	}
	return true;
}

function parsePersistedSnapshot(value: unknown): Record<string, OfficialModelMeta> | undefined {
	if (!isRecord(value)) return undefined;
	const entries: [string, OfficialModelMeta][] = [];
	for (const [key, meta] of Object.entries(value)) {
		if (key.trim() === "" || !isPersistableMeta(meta)) return undefined;
		entries.push([key, meta]);
	}
	return Object.fromEntries(entries.map(([key, meta]) => [key, cloneMeta(meta)]));
}

async function readPersistedPricingCache(
	cachePath: string | undefined,
	pricingUrl: string,
): Promise<PricingCacheEntry | undefined> {
	if (!cachePath || cachePath.trim() === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
		if (!isRecord(parsed)) return undefined;
		if (
			parsed.version !== PERSISTED_PRICING_CACHE_VERSION ||
			parsed.sourceUrl !== pricingUrl ||
			typeof parsed.updatedAt !== "number" ||
			!Number.isFinite(parsed.updatedAt) ||
			parsed.updatedAt < 0
		) {
			return undefined;
		}
		const snapshot = parsePersistedSnapshot(parsed.snapshot);
		return snapshot === undefined ? undefined : { snapshot, updatedAt: parsed.updatedAt };
	} catch {
		return undefined;
	}
}

async function writePersistedPricingCache(
	cachePath: string | undefined,
	pricingUrl: string,
	snapshot: Record<string, OfficialModelMeta>,
	updatedAt: number,
): Promise<void> {
	if (!cachePath || cachePath.trim() === "") return;
	const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
		const persisted: PersistedPricingCache = {
			version: PERSISTED_PRICING_CACHE_VERSION,
			sourceUrl: pricingUrl,
			updatedAt,
			snapshot: cloneSnapshot(snapshot),
		};
		await writeFile(temporaryPath, `${JSON.stringify(persisted)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, cachePath);
	} catch {
		// Persistence is an optimization and must never make model registration fail.
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

function parsePrice(value: unknown): number | undefined {
	const num =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value.trim())
				: Number.NaN;
	if (!Number.isFinite(num) || num < 0) return undefined;
	const scaled = num * 1_000_000;
	return Number.isFinite(scaled) ? scaled : undefined;
}

function hasKnownOpenRouterPricing(pricing: Record<string, unknown> | undefined): boolean {
	if (pricing === undefined) return false;
	if (
		REQUIRED_OPENROUTER_PRICE_FIELDS.some(
			(key) => !Object.hasOwn(pricing, key) || parsePrice(pricing[key]) === undefined,
		)
	) {
		return false;
	}
	return OPTIONAL_OPENROUTER_PRICE_FIELDS.every(
		(key) => !Object.hasOwn(pricing, key) || parsePrice(pricing[key]) !== undefined,
	);
}

function priceOrZero(value: unknown): number {
	return parsePrice(value) ?? 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function setRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function normalizeModelId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "" ? undefined : normalized;
}

function splitModelId(value: string): { provider?: string; model: string } {
	const slash = value.indexOf("/");
	if (slash < 0) return { model: value };
	return {
		provider: value.slice(0, slash).replace(/^~/, ""),
		model: value.slice(slash + 1),
	};
}

function stripModelVariant(model: string): string {
	return model
		.replace(/:[^:]+$/, "")
		.replace(/-(?:minimal|low|medium|high|xhigh|max|thinking|reasoning)$/i, "")
		.replace(/-latest$/i, "")
		.replace(/-(?:\d{8}|\d{4})$/i, "");
}

function getModelFamilyId(value: string): string {
	const { provider, model } = splitModelId(value);
	const family = stripModelVariant(model);
	return provider ? `${provider}/${family}` : family;
}

function getModelVersion(value: string): string | undefined {
	const { model } = splitModelId(value);
	const normalized = model
		.replace(/:[^:]+$/, "")
		.replace(/-(?:minimal|low|medium|high|xhigh|max|thinking|reasoning)$/i, "")
		.replace(/-latest$/i, "");
	return normalized.match(/-(\d{8}|\d{4})$/)?.[1];
}

function parseOpenRouterIdentity(fullId: string, item: Record<string, unknown>): OfficialModelMeta["identity"] {
	const canonicalId = normalizeModelId(item.canonical_slug);
	const aliasTarget = isRecord(item.alias_target) ? normalizeModelId(item.alias_target.slug) : undefined;
	const created = typeof item.created === "number" && Number.isFinite(item.created) ? item.created : undefined;
	const latestAlias = splitModelId(fullId).model.endsWith("-latest");
	const familyId = getModelFamilyId(aliasTarget ?? canonicalId ?? fullId);
	const version = latestAlias ? undefined : getModelVersion(canonicalId ?? fullId);
	return {
		sourceId: fullId,
		familyId,
		...(canonicalId ? { canonicalId } : {}),
		...(aliasTarget ? { aliasTargetId: aliasTarget } : {}),
		...(version ? { version } : {}),
		...(created !== undefined ? { created } : {}),
		...(latestAlias ? { latestAlias: true } : {}),
	};
}

function parseArtificialAnalysisQuality(value: unknown): ModelQualityScore[] | undefined {
	if (!isRecord(value)) return undefined;
	const scores: ModelQualityScore[] = [];
	const artificialAnalysis = isRecord(value.artificial_analysis) ? value.artificial_analysis : undefined;
	for (const [category, key] of [
		["intelligence", "intelligence_index"],
		["coding", "coding_index"],
		["agentic", "agentic_index"],
	] as const) {
		const score = artificialAnalysis?.[key];
		if (!isFiniteNonNegative(score)) continue;
		scores.push({
			source: "artificial-analysis",
			benchmark: "Artificial Analysis",
			category,
			metric: "score",
			value: score,
		});
	}
	return scores.length > 0 ? scores : undefined;
}

function parseThinkingLevelMap(reasoning: Record<string, unknown> | undefined): ThinkingLevelMap | undefined {
	if (!Array.isArray(reasoning?.supported_efforts)) return undefined;
	const supported = new Set(
		reasoning.supported_efforts
			.filter((effort): effort is string => typeof effort === "string")
			.map((effort) => effort.trim().toLowerCase()),
	);
	if (supported.size === 0) return undefined;
	return {
		off: supported.has("none") ? "none" : null,
		minimal: supported.has("minimal") ? "minimal" : null,
		low: supported.has("low") ? "low" : null,
		medium: supported.has("medium") ? "medium" : null,
		high: supported.has("high") ? "high" : null,
		xhigh: supported.has("xhigh") ? "xhigh" : null,
		max: supported.has("max") ? "max" : null,
	};
}

export function parseOpenRouterModels(payload: unknown): Record<string, OfficialModelMeta> {
	if (!isRecord(payload) || !Array.isArray(payload.data)) return {};
	const result: Record<string, OfficialModelMeta> = {};
	const aliasCandidates = new Map<string, Map<string, OfficialModelMeta>>();

	for (const item of payload.data) {
		if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") continue;
		const fullId = item.id.trim().toLowerCase();
		const pricing = isRecord(item.pricing) ? item.pricing : undefined;
		const quality = parseArtificialAnalysisQuality(item.benchmarks);
		const costKnown = hasKnownOpenRouterPricing(pricing);

		const input = priceOrZero(pricing?.prompt);
		const output = priceOrZero(pricing?.completion);
		const cacheRead = priceOrZero(pricing?.input_cache_read);
		const cacheWrite = priceOrZero(pricing?.input_cache_write);
		const cost: ProviderCost = { input, output, cacheRead, cacheWrite };

		if (pricing && Array.isArray(pricing.overrides) && pricing.overrides.length > 0) {
			const tiers: NonNullable<ProviderCost["tiers"]> = [];
			for (const override of pricing.overrides) {
				if (!isRecord(override)) continue;
				const inputTokensAbove = isPositiveInteger(override.min_prompt_tokens) ? override.min_prompt_tokens : 0;
				const inputPrice = parsePrice(override.prompt);
				const outputPrice = parsePrice(override.completion);
				const cacheReadPrice = Object.hasOwn(override, "input_cache_read")
					? parsePrice(override.input_cache_read)
					: 0;
				const cacheWritePrice = Object.hasOwn(override, "input_cache_write")
					? parsePrice(override.input_cache_write)
					: 0;
				if (
					inputTokensAbove <= 0 ||
					inputPrice === undefined ||
					outputPrice === undefined ||
					cacheReadPrice === undefined ||
					cacheWritePrice === undefined
				) {
					continue;
				}
				tiers.push({
					inputTokensAbove,
					input: inputPrice,
					output: outputPrice,
					cacheRead: cacheReadPrice,
					cacheWrite: cacheWritePrice,
				});
			}

			if (tiers.length > 0) cost.tiers = tiers;
		}

		const topProvider = isRecord(item.top_provider) ? item.top_provider : undefined;
		const contextWindow = isPositiveInteger(item.context_length)
			? item.context_length
			: topProvider && isPositiveInteger(topProvider.context_length)
				? topProvider.context_length
				: undefined;
		const maxTokens =
			topProvider && isPositiveInteger(topProvider.max_completion_tokens)
				? topProvider.max_completion_tokens
				: undefined;

		const arch = isRecord(item.architecture) ? item.architecture : undefined;
		const inputModalities = Array.isArray(arch?.input_modalities) ? arch.input_modalities : [];
		const hasImage = inputModalities.includes("image");

		const reasoningInfo = isRecord(item.reasoning) ? item.reasoning : undefined;
		const thinkingLevelMap = parseThinkingLevelMap(reasoningInfo);
		const supportedParams = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
		const isReasoning =
			reasoningInfo !== undefined ||
			supportedParams.includes("reasoning") ||
			supportedParams.includes("include_reasoning") ||
			supportedParams.includes("reasoning_effort");
		const supportsReasoningEffort =
			supportedParams.includes("reasoning_effort") || supportedParams.includes("reasoning");

		const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : undefined;
		const identity = parseOpenRouterIdentity(fullId, item);
		const meta: OfficialModelMeta = {
			cost,
			...(costKnown ? {} : { costKnown: false }),
			...(quality ? { quality } : {}),
			...(identity ? { identity } : {}),
			...(name ? { name } : {}),
			...(contextWindow ? { contextWindow } : {}),
			...(maxTokens ? { maxTokens } : {}),
			...(isReasoning ? { reasoning: true } : {}),
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: hasImage ? ["text", "image"] : ["text"],
			...(supportsReasoningEffort ? { compat: { supportsReasoningEffort: true } } : {}),
		};

		setRecordValue(result, fullId, meta);

		const strippedId = fullId.replace(/^[^/]+\//, "");
		if (strippedId !== fullId) {
			const candidates = aliasCandidates.get(strippedId) ?? new Map<string, OfficialModelMeta>();
			candidates.set(fullId, meta);
			aliasCandidates.set(strippedId, candidates);
		}
	}

	for (const [strippedId, candidates] of aliasCandidates) {
		const [meta] = candidates.values();
		if (candidates.size === 1 && meta !== undefined && !Object.hasOwn(result, strippedId)) {
			setRecordValue(result, strippedId, meta);
		}
	}

	return result;
}

export function parseOpenRouterPricing(payload: unknown): Record<string, ProviderCost> {
	const modelsMeta = parseOpenRouterModels(payload);
	const res: Record<string, ProviderCost> = {};
	for (const [key, meta] of Object.entries(modelsMeta)) {
		if (meta.costKnown === false) continue;
		res[key] = cloneCost(meta.cost);
	}
	return res;
}

function staleCache(
	pricingUrl: string,
	now: number,
	maxStaleMs: number,
	allowExpired = false,
): Record<string, OfficialModelMeta> {
	const cached = pricingCache.get(pricingUrl);
	if (!cached) return {};
	const age = Math.max(0, now - cached.updatedAt);
	return allowExpired || age <= maxStaleMs ? cloneSnapshot(cached.snapshot) : {};
}

async function fetchOfficialPricingUncoalesced(
	fetchFn: typeof globalThis.fetch,
	pricingUrl: string,
	timeoutMs: number,
	cacheTtlMs: number,
	maxStaleMs: number,
	now: () => number,
	cachePath?: string,
): Promise<Record<string, OfficialModelMeta>> {
	const persisted = await readPersistedPricingCache(cachePath, pricingUrl);
	const allowPersistedStale = persisted !== undefined;
	if (persisted !== undefined) {
		const current = pricingCache.get(pricingUrl);
		if (current === undefined || persisted.updatedAt > current.updatedAt) {
			setPricingCache(persisted.snapshot, pricingUrl, persisted.updatedAt);
		}
		const cachedAge = getPricingCacheAge(pricingUrl, now());
		if (cachedAge !== undefined && cachedAge <= cacheTtlMs) return getPricingCache(pricingUrl);
	}

	try {
		const result = await withDeadline(async (signal) => {
			const response = await fetchFn(pricingUrl, { signal });
			if (!response.ok) return { ok: false as const };
			const payload = await response.json();
			return { ok: true as const, parsed: parseOpenRouterModels(payload) };
		}, timeoutMs);
		if (!result.ok) return staleCache(pricingUrl, now(), maxStaleMs, allowPersistedStale);
		if (Object.keys(result.parsed).length > 0) {
			const updatedAt = now();
			setPricingCache(result.parsed, pricingUrl, updatedAt);
			await writePersistedPricingCache(cachePath, pricingUrl, result.parsed, updatedAt);
			return cloneSnapshot(result.parsed);
		}
		return staleCache(pricingUrl, now(), maxStaleMs, allowPersistedStale);
	} catch {
		return staleCache(pricingUrl, now(), maxStaleMs, allowPersistedStale);
	}
}

function startPricingRequest(
	fetchFn: typeof globalThis.fetch,
	pricingUrl: string,
	timeoutMs: number,
	cacheTtlMs: number,
	maxStaleMs: number,
	now: () => number,
	cachePath?: string,
): Promise<Record<string, OfficialModelMeta>> {
	const existing = pricingRequests.get(pricingUrl);
	if (existing) return existing;

	const request = fetchOfficialPricingUncoalesced(
		fetchFn,
		pricingUrl,
		timeoutMs,
		cacheTtlMs,
		maxStaleMs,
		now,
		cachePath,
	);
	pricingRequests.set(pricingUrl, request);
	void request.then(
		() => {
			if (pricingRequests.get(pricingUrl) === request) pricingRequests.delete(pricingUrl);
		},
		() => {
			if (pricingRequests.get(pricingUrl) === request) pricingRequests.delete(pricingUrl);
		},
	);
	return request;
}

function observeBackgroundRefresh(
	request: Promise<Record<string, OfficialModelMeta>>,
	callback: ((snapshot: Record<string, OfficialModelMeta>) => void) | undefined,
): void {
	if (!callback) return;
	void request.then(
		(snapshot) => {
			try {
				callback(snapshot);
			} catch {
				// A late metadata observer must never turn a completed fetch into an unhandled rejection.
			}
		},
		() => undefined,
	);
}

export async function fetchOfficialPricing(
	fetchFn: typeof globalThis.fetch,
	pricingUrl = OPENROUTER_MODELS_URL,
	timeoutMs = 3_000,
	cacheTtlMs = DEFAULT_PRICING_CACHE_TTL_MS,
	maxStaleMs = DEFAULT_PRICING_MAX_STALE_MS,
	now: () => number = Date.now,
	options: OfficialPricingFetchOptions = {},
): Promise<Record<string, OfficialModelMeta>> {
	const currentTime = now();
	const cachedAge = getPricingCacheAge(pricingUrl, currentTime);
	if (cachedAge !== undefined && cachedAge <= cacheTtlMs) return getPricingCache(pricingUrl);

	const existing = pricingRequests.get(pricingUrl);
	if (existing) {
		if (options.background === true) {
			observeBackgroundRefresh(existing, options.onBackgroundRefresh);
			return getPricingCache(pricingUrl);
		}
		return existing;
	}

	if (options.cachePath) {
		const persisted = await readPersistedPricingCache(options.cachePath, pricingUrl);
		if (persisted !== undefined) {
			const current = pricingCache.get(pricingUrl);
			if (current === undefined || persisted.updatedAt > current.updatedAt) {
				setPricingCache(persisted.snapshot, pricingUrl, persisted.updatedAt);
			}
			const persistedAge = getPricingCacheAge(pricingUrl, now());
			if (persistedAge !== undefined && persistedAge <= cacheTtlMs) return getPricingCache(pricingUrl);
		}
	}

	const request = startPricingRequest(fetchFn, pricingUrl, timeoutMs, cacheTtlMs, maxStaleMs, now, options.cachePath);
	if (options.background === true) {
		observeBackgroundRefresh(request, options.onBackgroundRefresh);
		void request.catch(() => undefined);
		return getPricingCache(pricingUrl);
	}
	return request;
}

export function findOfficialCost(
	modelId: string,
	dynamicPricing: Record<string, OfficialModelMeta | ProviderCost> = {},
): ProviderCost | undefined {
	const meta = findOfficialMeta(modelId, dynamicPricing);
	return meta && meta.costKnown !== false ? cloneCost(meta.cost) : undefined;
}

interface OfficialModelCandidate {
	key: string;
	meta: OfficialModelMeta;
	provider?: string;
	model: string;
	familyId: string;
	version?: string;
	canonicalId?: string;
	aliasTargetId?: string;
	latestAlias: boolean;
	created?: number;
}

function isOfficialModelMeta(value: OfficialModelMeta | ProviderCost): value is OfficialModelMeta {
	return "cost" in value && typeof value.cost === "object";
}

function getOfficialMeta(value: OfficialModelMeta | ProviderCost): OfficialModelMeta {
	return isOfficialModelMeta(value) ? cloneMeta(value) : { cost: cloneCost(value) };
}

function getOfficialCandidates(
	dynamicPricing: Record<string, OfficialModelMeta | ProviderCost>,
): OfficialModelCandidate[] {
	const candidates: OfficialModelCandidate[] = [];
	const seen = new Set<string>();
	for (const [rawKey, value] of Object.entries(dynamicPricing)) {
		const key = rawKey.toLowerCase().trim();
		if (key === "") continue;
		const meta = isOfficialModelMeta(value) ? value : { cost: value };
		const sourceId = meta.identity?.sourceId ?? key;
		if (seen.has(sourceId)) continue;
		seen.add(sourceId);
		const referenceId = meta.identity?.sourceId ?? key;
		const { provider, model } = splitModelId(referenceId);
		candidates.push({
			key,
			meta,
			provider,
			model,
			familyId: meta.identity?.familyId ?? getModelFamilyId(referenceId),
			version: meta.identity?.version ?? getModelVersion(meta.identity?.canonicalId ?? referenceId),
			canonicalId: meta.identity?.canonicalId,
			aliasTargetId: meta.identity?.aliasTargetId,
			latestAlias: meta.identity?.latestAlias ?? model.endsWith("-latest"),
			created: meta.identity?.created,
		});
	}
	return candidates;
}

function hasExplicitModelVariant(model: string): boolean {
	return (
		getModelVersion(model) !== undefined ||
		/:[^/]+$/.test(model) ||
		/-(?:minimal|low|medium|high|xhigh|max|thinking|reasoning)$/i.test(model)
	);
}

function compareCandidateAge(left: OfficialModelCandidate, right: OfficialModelCandidate): number {
	if (left.version !== undefined && right.version !== undefined && left.version !== right.version) {
		if (left.version.length !== right.version.length) return left.version.length - right.version.length;
		return left.version.localeCompare(right.version);
	}
	if (left.created !== undefined && right.created !== undefined && left.created !== right.created) {
		return left.created - right.created;
	}
	return left.key.localeCompare(right.key);
}

function candidateMatchesTarget(candidate: OfficialModelCandidate, target: string): boolean {
	const normalizedTarget = target.toLowerCase().trim();
	return [candidate.key, candidate.meta.identity?.sourceId, candidate.canonicalId]
		.filter((value): value is string => value !== undefined)
		.some((value) => value === normalizedTarget);
}

function chooseLatestCandidate(candidates: OfficialModelCandidate[]): OfficialModelCandidate | undefined {
	for (const alias of candidates.filter(
		(candidate) => candidate.latestAlias && candidate.aliasTargetId !== undefined,
	)) {
		const targetId = alias.aliasTargetId;
		if (targetId === undefined) continue;
		const target = candidates.find((candidate) => candidateMatchesTarget(candidate, targetId));
		if (target !== undefined) return target;
	}
	return candidates.reduce<OfficialModelCandidate | undefined>(
		(best, candidate) => (best === undefined || compareCandidateAge(candidate, best) > 0 ? candidate : best),
		undefined,
	);
}

function sameQualityVersion(left: OfficialModelCandidate, right: OfficialModelCandidate): boolean {
	if (left.version === undefined && right.version === undefined) return true;
	return left.version !== undefined && left.version === right.version;
}

function mergeQualityVariants(
	selected: OfficialModelCandidate,
	candidates: OfficialModelCandidate[],
): ModelQualityScore[] | undefined {
	const best = new Map<string, ModelQualityScore>();
	for (const candidate of candidates) {
		if (candidate.familyId !== selected.familyId || !sameQualityVersion(candidate, selected)) continue;
		for (const score of candidate.meta.quality ?? []) {
			const key = [score.source, score.benchmark, score.category, score.metric].join("\\0");
			const previous = best.get(key);
			if (previous === undefined || score.value > previous.value) {
				best.set(key, {
					...score,
					...(score.confidenceInterval ? { confidenceInterval: { ...score.confidenceInterval } } : {}),
				});
			}
		}
	}
	return best.size > 0 ? [...best.values()] : undefined;
}

export function findOfficialMeta(
	modelId: string,
	dynamicPricing: Record<string, OfficialModelMeta | ProviderCost> = {},
): OfficialModelMeta | undefined {
	const normalized = modelId.toLowerCase().trim();
	if (normalized === "") return undefined;
	const requested = splitModelId(normalized);
	const requestedFamily = stripModelVariant(requested.model);
	const candidates = getOfficialCandidates(dynamicPricing);
	const exact = candidates.find((candidate) => candidate.key === normalized || candidate.canonicalId === normalized);
	const matching = candidates.filter((candidate) => {
		if (requested.provider !== undefined && candidate.provider !== requested.provider) return false;
		return splitModelId(candidate.familyId).model === requestedFamily;
	});
	const providerCount = new Set(matching.map((candidate) => candidate.provider ?? "")).size;
	if (requested.provider === undefined && providerCount > 1) return undefined;
	if (matching.length === 0) return undefined;

	const selected =
		hasExplicitModelVariant(requested.model) && exact !== undefined ? exact : chooseLatestCandidate(matching);
	if (selected === undefined) return undefined;
	const result = getOfficialMeta(selected.meta);
	const quality = mergeQualityVariants(selected, matching);
	if (quality !== undefined) result.quality = quality;
	return result;
}

export function applyOfficialModelCosts(
	models: ProviderModelDraft[],
	dynamicPricing: Record<string, OfficialModelMeta | ProviderCost> = {},
): ProviderModelDraft[] {
	return models.map((model) => {
		const meta = findOfficialMeta(model.id, dynamicPricing);
		if (!meta) return model;

		const useOfficialCost =
			meta.costKnown !== false && (model.cost === undefined || model.pricingSource === "official");
		const merged: ProviderModelDraft = {
			...model,
			...(useOfficialCost ? { cost: cloneCost(meta.cost), pricingSource: "official" as const } : {}),
			...(model.cost !== undefined && !useOfficialCost ? { cost: cloneCost(model.cost) } : {}),
		};
		if (merged.name === undefined && meta.name !== undefined) merged.name = meta.name;
		if (merged.contextWindow === undefined && meta.contextWindow !== undefined) {
			merged.contextWindow = meta.contextWindow;
		}
		if (merged.maxTokens === undefined && meta.maxTokens !== undefined) merged.maxTokens = meta.maxTokens;
		if (merged.reasoning === undefined && meta.reasoning !== undefined) merged.reasoning = meta.reasoning;
		if (merged.thinkingLevelMap === undefined && meta.thinkingLevelMap !== undefined) {
			merged.thinkingLevelMap = { ...meta.thinkingLevelMap };
		}
		if (merged.input === undefined && meta.input !== undefined) merged.input = [...meta.input];
		if (meta.compat !== undefined) merged.compat = { ...meta.compat, ...merged.compat };
		return merged;
	});
}
