import { isValidTimeoutMs } from "./deadline.ts";
import type { PreflightAdapter } from "./preflight-manager.ts";
import { validatePricingAdjustment, validatePricingPolicy } from "./pricing-adjustments.ts";
import type { ProviderAdapter, StatusAdapter, TunerAdapter } from "./types.ts";

export type AdapterValue = ProviderAdapter | StatusAdapter | PreflightAdapter | TunerAdapter;

const MAX_STABLE_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 1_024;
const MAX_MODEL_ID_LENGTH = 512;

export function isStableAdapterId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_STABLE_ID_LENGTH &&
		value.trim() === value &&
		!/\s/.test(value) &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeText(value: unknown, maxLength = MAX_TEXT_LENGTH): value is string {
	return (
		typeof value === "string" &&
		value.trim() !== "" &&
		value.length <= maxLength &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

function assertStableId(value: unknown, label: string): asserts value is string {
	if (!isStableAdapterId(value)) {
		throw new Error(`${label} must be a non-empty ID without whitespace`);
	}
}

function assertAdapterObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
}

function assertFiniteNonNegative(value: unknown, label: string): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a finite non-negative number`);
	}
}

function assertPositiveInteger(value: unknown, label: string): void {
	if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
}

function validateProviderCost(value: unknown, label: string): void {
	assertAdapterObject(value, label);
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		if (value[field] !== undefined) assertFiniteNonNegative(value[field], `${label}.${field}`);
	}
	if (value.tiers === undefined) return;
	if (!Array.isArray(value.tiers)) throw new Error(`${label}.tiers must be an array`);
	for (const [index, tier] of value.tiers.entries()) {
		assertAdapterObject(tier, `${label}.tiers[${index}]`);
		assertPositiveInteger(tier.inputTokensAbove, `${label}.tiers[${index}].inputTokensAbove`);
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			if (tier[field] !== undefined) {
				assertFiniteNonNegative(tier[field], `${label}.tiers[${index}].${field}`);
			}
		}
	}
}

function validateProviderModelDraft(value: unknown, label: string): void {
	assertAdapterObject(value, label);
	if (!isSafeText(value.id, MAX_MODEL_ID_LENGTH)) throw new Error(`${label}.id must be a non-empty model ID`);
	if (value.name !== undefined && !isSafeText(value.name)) throw new Error(`${label}.name must be safe text`);
	if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") {
		throw new Error(`${label}.reasoning must be a boolean`);
	}
	if (value.input !== undefined) {
		if (!Array.isArray(value.input) || !value.input.every((item) => item === "text" || item === "image")) {
			throw new Error(`${label}.input must contain only text or image`);
		}
	}
	if (value.contextWindow !== undefined) assertPositiveInteger(value.contextWindow, `${label}.contextWindow`);
	if (value.maxTokens !== undefined) assertPositiveInteger(value.maxTokens, `${label}.maxTokens`);
	if (value.cost !== undefined) validateProviderCost(value.cost, `${label}.cost`);
	if (value.pricingAdjustment !== undefined) {
		validatePricingAdjustment(value.pricingAdjustment, `${label}.pricingAdjustment`);
	}
	if (value.compat !== undefined) assertAdapterObject(value.compat, `${label}.compat`);
	if (value.thinkingLevelMap !== undefined) assertAdapterObject(value.thinkingLevelMap, `${label}.thinkingLevelMap`);
}

export function validateProviderAdapter(adapter: unknown): asserts adapter is ProviderAdapter {
	assertAdapterObject(adapter, "Provider adapter");
	assertStableId(adapter.id, "Provider adapter ID");
	if (adapter.pricing !== undefined) validatePricingPolicy(adapter.pricing, `Provider ${adapter.id} pricing`);
	if (!isRecord(adapter.provider)) throw new Error(`Provider ${adapter.id} must define provider metadata`);
	const provider = adapter.provider;
	if (!isSafeText(provider.name)) throw new Error(`Provider ${adapter.id} must define a name`);
	if (!isSafeText(provider.baseUrl)) throw new Error(`Provider ${adapter.id} must define a base URL`);
	if (!isSafeText(provider.apiKey)) throw new Error(`Provider ${adapter.id} must define an API key reference`);
	if (!isSafeText(provider.api)) throw new Error(`Provider ${adapter.id} must define an API type`);
	if (provider.authHeader !== undefined && typeof provider.authHeader !== "boolean") {
		throw new Error(`Provider ${adapter.id} has invalid authHeader`);
	}
	if (provider.headers !== undefined) {
		if (!isRecord(provider.headers)) throw new Error(`Provider ${adapter.id} has invalid headers`);
		for (const [key, value] of Object.entries(provider.headers)) {
			if (!isSafeText(key) || typeof value !== "string")
				throw new Error(`Provider ${adapter.id} has invalid headers`);
		}
	}
	if (provider.oauth !== undefined) {
		if (!isRecord(provider.oauth)) throw new Error(`Provider ${adapter.id} has invalid OAuth configuration`);
		if (!isSafeText(provider.oauth.name)) throw new Error(`Provider ${adapter.id} has invalid OAuth name`);
		for (const field of ["login", "refreshToken", "getApiKey"] as const) {
			if (typeof provider.oauth[field] !== "function") {
				throw new Error(`Provider ${adapter.id} has invalid OAuth ${field}`);
			}
		}
	}
	if (!Array.isArray(provider.models)) throw new Error(`Provider ${adapter.id} must define a model list`);
	for (const [index, model] of provider.models.entries()) {
		validateProviderModelDraft(model, `Provider ${adapter.id} model ${index}`);
	}
	if (provider.refreshModels !== undefined && typeof provider.refreshModels !== "function") {
		throw new Error(`Provider ${adapter.id} has invalid refreshModels`);
	}
	if (adapter.catalog !== undefined) {
		if (!isRecord(adapter.catalog)) throw new Error(`Provider ${adapter.id} has invalid catalog metadata`);
		if (
			adapter.catalog.source !== "static" &&
			adapter.catalog.source !== "live" &&
			adapter.catalog.source !== "fallback"
		) {
			throw new Error(`Provider ${adapter.id} has invalid catalog source`);
		}
		if (
			typeof adapter.catalog.modelCount !== "number" ||
			!Number.isInteger(adapter.catalog.modelCount) ||
			adapter.catalog.modelCount < 0
		) {
			throw new Error(`Provider ${adapter.id} has invalid catalog model count`);
		}
		if (adapter.catalog.updatedAt !== undefined)
			assertFiniteNonNegative(adapter.catalog.updatedAt, "Catalog updatedAt");
		if (adapter.catalog.lastError !== undefined && !isSafeText(adapter.catalog.lastError)) {
			throw new Error(`Provider ${adapter.id} has invalid catalog error`);
		}
	}
}

export function validateStatusAdapter(adapter: unknown): asserts adapter is StatusAdapter {
	assertAdapterObject(adapter, "Status adapter");
	assertStableId(adapter.id, "Status adapter ID");
	assertStableId(adapter.providerId, "Status adapter provider ID");
	if (!isSafeText(adapter.name)) throw new Error(`Status ${adapter.id} must define a name`);
	if (typeof adapter.fetch !== "function") throw new Error(`Status ${adapter.id} must define fetch()`);
	if (typeof adapter.cacheTtlMs !== "number" || !Number.isFinite(adapter.cacheTtlMs) || adapter.cacheTtlMs < 0) {
		throw new Error(`Status ${adapter.id} has invalid cache TTL`);
	}
	if (!isValidTimeoutMs(adapter.requestTimeoutMs)) throw new Error(`Status ${adapter.id} has invalid timing settings`);
}

export function validatePreflightAdapter(adapter: unknown): asserts adapter is PreflightAdapter {
	assertAdapterObject(adapter, "Preflight adapter");
	assertStableId(adapter.id, "Preflight adapter ID");
	assertStableId(adapter.providerId, "Preflight adapter provider ID");
	if (!isSafeText(adapter.name)) throw new Error(`Preflight ${adapter.id} must define a name`);
	if (typeof adapter.fetch !== "function") throw new Error(`Preflight ${adapter.id} must define fetch()`);
	if (typeof adapter.cacheTtlMs !== "number" || !Number.isFinite(adapter.cacheTtlMs) || adapter.cacheTtlMs < 0) {
		throw new Error(`Preflight ${adapter.id} has invalid cache TTL`);
	}
	if (!isValidTimeoutMs(adapter.requestTimeoutMs)) {
		throw new Error(`Preflight ${adapter.id} has invalid timing settings`);
	}
}

export function validateTunerAdapter(adapter: unknown): asserts adapter is TunerAdapter {
	assertAdapterObject(adapter, "Tuner adapter");
	assertStableId(adapter.id, "Tuner adapter ID");
	if (typeof adapter.matches !== "function") throw new Error(`Tuner ${adapter.id} must define matches()`);
	if (typeof adapter.transform !== "function") throw new Error(`Tuner ${adapter.id} must define transform()`);
	if (adapter.priority !== undefined && (!Number.isFinite(adapter.priority) || !Number.isInteger(adapter.priority))) {
		throw new Error(`Tuner ${adapter.id} has invalid priority`);
	}
}

export function validateAdapter(kind: "provider", adapter: unknown): asserts adapter is ProviderAdapter;
export function validateAdapter(kind: "status", adapter: unknown): asserts adapter is StatusAdapter;
export function validateAdapter(kind: "preflight", adapter: unknown): asserts adapter is PreflightAdapter;
export function validateAdapter(kind: "tuner", adapter: unknown): asserts adapter is TunerAdapter;
export function validateAdapter(kind: "provider" | "status" | "preflight" | "tuner", adapter: unknown): void {
	switch (kind) {
		case "provider":
			validateProviderAdapter(adapter);
			return;
		case "status":
			validateStatusAdapter(adapter);
			return;
		case "preflight":
			validatePreflightAdapter(adapter);
			return;
		case "tuner":
			validateTunerAdapter(adapter);
			return;
	}
}

export function validateAdapterIdentity(
	kind: "provider" | "tuner",
	staticId: unknown,
	adapter: { id: unknown },
): asserts adapter is { id: string };
export function validateAdapterIdentity(
	kind: "status" | "preflight",
	staticId: unknown,
	staticProviderId: unknown,
	adapter: { id: unknown; providerId: unknown },
): asserts adapter is { id: string; providerId: string };
export function validateAdapterIdentity(
	kind: "provider" | "status" | "preflight" | "tuner",
	staticId: unknown,
	staticProviderIdOrAdapter: unknown,
	maybeAdapter?: { id: unknown; providerId?: unknown },
): void {
	const adapter = maybeAdapter === undefined ? staticProviderIdOrAdapter : maybeAdapter;
	assertStableId(staticId, `${kind} static ID`);
	if (!isRecord(adapter)) throw new Error(`${kind} adapter must be an object`);
	if (adapter.id !== staticId) throw new Error(`${kind} adapter ID does not match its static ID`);
	if (kind !== "status" && kind !== "preflight") return;
	assertStableId(staticProviderIdOrAdapter, `${kind} static provider ID`);
	if (adapter.providerId !== staticProviderIdOrAdapter) {
		throw new Error(`${kind} adapter provider ID does not match its static provider ID`);
	}
}
