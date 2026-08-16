import assert from "node:assert/strict";
import test from "node:test";
import { applyTunerAdapters, sortTunerAdapters } from "../core/tuner-manager.ts";
import type { TunerAdapter, TunerContext } from "../core/types.ts";

function createContext(model = "gpt-4", provider = "openai"): TunerContext {
	return {
		model: {
			id: model,
			provider,
		},
	} as any;
}

test("applyTunerAdapters skips tuners whose matches() returns false", async () => {
	const skippedTuner: TunerAdapter = {
		id: "skipped-tuner",
		priority: 10,
		matches: (ctx) => ctx.model?.provider === "anthropic",
		transform: (payload: any) => ({ ...payload, modified: true }),
	};

	const payload = { messages: [{ role: "user", content: "hello" }] };
	const result = await applyTunerAdapters(payload, createContext("gpt-4", "openai"), [skippedTuner]);
	assert.equal(result, undefined);
});

test("sortTunerAdapters orders tuners by ascending priority and ID", () => {
	const tunerA: TunerAdapter = {
		id: "tuner-a",
		priority: 20,
		matches: () => true,
		transform: (payload: any) => payload,
	};

	const tunerB: TunerAdapter = {
		id: "tuner-b",
		priority: 10,
		matches: () => true,
		transform: (payload: any) => payload,
	};

	const sorted = sortTunerAdapters([tunerA, tunerB]);
	assert.deepEqual(
		sorted.map((t: TunerAdapter) => t.id),
		["tuner-b", "tuner-a"],
	);
});

test("applyTunerAdapters executes matching tuners in provided order", async () => {
	const executionOrder: string[] = [];

	const tunerB: TunerAdapter = {
		id: "tuner-b",
		priority: 10,
		matches: () => true,
		transform: (payload: any) => {
			executionOrder.push("B");
			return { ...payload, b: 2 };
		},
	};

	const tunerA: TunerAdapter = {
		id: "tuner-a",
		priority: 20,
		matches: () => true,
		transform: (payload: any) => {
			executionOrder.push("A");
			return { ...payload, a: 1 };
		},
	};

	const payload = { messages: [] };
	const result = await applyTunerAdapters(payload, createContext(), [tunerB, tunerA]);

	assert.deepEqual(executionOrder, ["B", "A"]);
	assert.deepEqual(result, { messages: [], b: 2, a: 1 });
});

test("applyTunerAdapters gracefully handles transform errors and continues pipeline", async () => {
	const failingTuner: TunerAdapter = {
		id: "failing-tuner",
		priority: 10,
		matches: () => true,
		transform: () => {
			throw new Error("unexpected transform failure");
		},
	};

	const healthyTuner: TunerAdapter = {
		id: "healthy-tuner",
		priority: 20,
		matches: () => true,
		transform: (payload: any) => ({ ...payload, success: true }),
	};

	const payload = { messages: [] };
	const result = await applyTunerAdapters(payload, createContext(), [failingTuner, healthyTuner]);

	assert.deepEqual(result, { messages: [], success: true });
});

test("applyTunerAdapters returns undefined if no matching tuner mutates the payload", async () => {
	const noopTuner: TunerAdapter = {
		id: "noop-tuner",
		priority: 10,
		matches: () => true,
		transform: () => undefined,
	};

	const payload = { messages: [{ role: "user", content: "test" }] };
	const result = await applyTunerAdapters(payload, createContext(), [noopTuner]);

	assert.equal(result, undefined);
});
