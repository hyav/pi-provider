import type {
	ModelPricingDetails,
	PricingSku,
	ProviderCost,
	ProviderPricingAdjustment,
	ProviderPricingPolicy,
	ProviderPricingSource,
} from "./types.ts";

const PRICING_SKUS: readonly PricingSku[] = ["input", "output", "cacheRead", "cacheWrite"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validatePricingAdjustment(
	value: unknown,
	label = "Pricing adjustment",
): asserts value is ProviderPricingAdjustment {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	if (typeof value.multiplier !== "number" || !Number.isFinite(value.multiplier) || value.multiplier < 0) {
		throw new Error(`${label}.multiplier must be a finite non-negative number`);
	}
	if (typeof value.label !== "string" || value.label.trim() === "") {
		throw new Error(`${label}.label must be a non-empty string`);
	}
	if (value.source !== undefined && (typeof value.source !== "string" || value.source.trim() === "")) {
		throw new Error(`${label}.source must be a non-empty string`);
	}
	if (value.appliesToReference !== undefined && typeof value.appliesToReference !== "boolean") {
		throw new Error(`${label}.appliesToReference must be a boolean`);
	}
	if (value.appliesTo !== undefined) {
		if (
			!Array.isArray(value.appliesTo) ||
			value.appliesTo.length === 0 ||
			value.appliesTo.some((sku) => !PRICING_SKUS.includes(sku as PricingSku))
		) {
			throw new Error(`${label}.appliesTo must contain only known pricing SKUs`);
		}
	}
}

export function validatePricingPolicy(
	value: unknown,
	label = "Provider pricing policy",
): asserts value is ProviderPricingPolicy {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	if (value.defaultAdjustment !== undefined)
		validatePricingAdjustment(value.defaultAdjustment, `${label}.defaultAdjustment`);
	if (value.models !== undefined) {
		if (!isRecord(value.models)) throw new Error(`${label}.models must be an object`);
		for (const [modelId, adjustment] of Object.entries(value.models)) {
			if (modelId.trim() === "") throw new Error(`${label}.models has an empty model ID`);
			validatePricingAdjustment(adjustment, `${label}.models.${modelId}`);
		}
	}
}

function scaleRate(rate: number, sku: PricingSku, adjustment: ProviderPricingAdjustment): number {
	const appliesTo = adjustment.appliesTo ?? PRICING_SKUS;
	return appliesTo.includes(sku) ? rate * adjustment.multiplier : rate;
}

function cloneCost(cost: ProviderCost): ProviderCost {
	return {
		...cost,
		...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
	};
}

export function resolvePricingDetails(
	baseCost: ProviderCost | undefined,
	source: ProviderPricingSource | "none",
	adjustment?: ProviderPricingAdjustment,
): ModelPricingDetails {
	if (baseCost === undefined) {
		return {
			known: false,
			source,
			...(adjustment ? { adjustment: { ...adjustment } } : {}),
			...(adjustment ? { note: "discount configured, base price unavailable" } : {}),
		};
	}

	const canAdjustReference = source !== "official" || adjustment?.appliesToReference !== false;
	const effectiveCost =
		adjustment && canAdjustReference ? applyPricingAdjustment(baseCost, adjustment) : cloneCost(baseCost);
	return {
		known: true,
		source,
		baseCost: cloneCost(baseCost),
		effectiveCost,
		...(adjustment ? { adjustment: { ...adjustment } } : {}),
		...(adjustment && !canAdjustReference ? { note: "discount not applied to reference price" } : {}),
	};
}

/** Apply one explicit static pricing adjustment without changing token thresholds. */
export function applyPricingAdjustment(cost: ProviderCost, adjustment: ProviderPricingAdjustment): ProviderCost {
	return {
		input: scaleRate(cost.input, "input", adjustment),
		output: scaleRate(cost.output, "output", adjustment),
		cacheRead: scaleRate(cost.cacheRead, "cacheRead", adjustment),
		cacheWrite: scaleRate(cost.cacheWrite, "cacheWrite", adjustment),
		...(cost.tiers
			? {
					tiers: cost.tiers.map((tier) => ({
						inputTokensAbove: tier.inputTokensAbove,
						input: scaleRate(tier.input, "input", adjustment),
						output: scaleRate(tier.output, "output", adjustment),
						cacheRead: scaleRate(tier.cacheRead, "cacheRead", adjustment),
						cacheWrite: scaleRate(tier.cacheWrite, "cacheWrite", adjustment),
					})),
				}
			: {}),
	};
}
