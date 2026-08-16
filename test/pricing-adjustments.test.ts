import assert from "node:assert/strict";
import test from "node:test";
import { applyPricingAdjustment, resolvePricingDetails } from "../core/pricing-adjustments.ts";

test("reports an unavailable estimate when a discount has no base price", () => {
	const details = resolvePricingDetails(undefined, "none", {
		multiplier: 0.8,
		label: "20% provider discount",
	});

	assert.deepEqual(details, {
		known: false,
		source: "none",
		adjustment: {
			multiplier: 0.8,
			label: "20% provider discount",
		},
		note: "discount configured, base price unavailable",
	});
});

test("applies an explicit discount to a reference price by default", () => {
	const details = resolvePricingDetails({ input: 5, output: 30, cacheRead: 0, cacheWrite: 0 }, "official", {
		multiplier: 0.8,
		label: "20% provider discount",
	});

	assert.deepEqual(details.effectiveCost, {
		input: 4,
		output: 24,
		cacheRead: 0,
		cacheWrite: 0,
	});
	assert.equal(details.note, undefined);
});

test("can keep an explicit discount off a reference price", () => {
	const details = resolvePricingDetails({ input: 5, output: 30, cacheRead: 0, cacheWrite: 0 }, "official", {
		multiplier: 0.8,
		label: "20% provider discount",
		appliesToReference: false,
	});

	assert.deepEqual(details.effectiveCost, {
		input: 5,
		output: 30,
		cacheRead: 0,
		cacheWrite: 0,
	});
	assert.equal(details.note, "discount not applied to reference price");
});

test("applies a provider discount to every token rate and pricing tier", () => {
	const adjusted = applyPricingAdjustment(
		{
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
			tiers: [
				{
					inputTokensAbove: 200_000,
					input: 10,
					output: 45,
					cacheRead: 1,
					cacheWrite: 12.5,
				},
			],
		},
		{ multiplier: 0.8, label: "20% provider discount" },
	);

	assert.deepEqual(adjusted, {
		input: 4,
		output: 24,
		cacheRead: 0.4,
		cacheWrite: 5,
		tiers: [
			{
				inputTokensAbove: 200_000,
				input: 8,
				output: 36,
				cacheRead: 0.8,
				cacheWrite: 10,
			},
		],
	});
});
