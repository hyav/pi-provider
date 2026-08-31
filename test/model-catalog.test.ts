import assert from "node:assert/strict";
import test from "node:test";
import { createModelCatalogLifecycle } from "../core/model-catalog.ts";
import type { ProviderModelDraft, ProviderRefreshContext } from "../core/types.ts";

function context(overrides: Partial<ProviderRefreshContext> = {}): ProviderRefreshContext {
	return {
		allowNetwork: false,
		signal: new AbortController().signal,
		publish: async ({ update }) => {
			update?.();
			return true;
		},
		...overrides,
	};
}

function stored(models: ProviderModelDraft[], checkedAt: number): NonNullable<ProviderRefreshContext["stored"]> {
	return { models: models as unknown as NonNullable<ProviderRefreshContext["stored"]>["models"], checkedAt };
}

test("restores a cached catalog without network access", async () => {
	let active: ProviderModelDraft[] = [];
	let requests = 0;
	const lifecycle = createModelCatalogLifecycle({
		ttlMs: 100,
		discover: async () => {
			requests++;
			return [{ id: "live" }];
		},
		restore: (entry) => entry?.models.map(({ provider: _provider, ...model }) => model),
		persist: (models, checkedAt) => stored(models, checkedAt),
		onUpdate: (models) => {
			active = models;
		},
		errorCode: () => "fetch",
	});

	await lifecycle.refreshModels(context({ stored: stored([{ id: "cached" }], 10) }));

	assert.deepEqual(active, [{ id: "cached" }]);
	assert.equal(lifecycle.catalog.source, "cached");
	assert.equal(requests, 0);
});

test("publishes a complete live replacement and persists it", async () => {
	let persisted: ProviderRefreshContext["stored"];
	const lifecycle = createModelCatalogLifecycle({
		initialModels: [{ id: "removed" }],
		initialSource: "cached",
		ttlMs: 100,
		now: () => 20,
		discover: async () => [{ id: "current" }],
		restore: () => undefined,
		persist: (models, checkedAt) => stored(models, checkedAt),
		onUpdate: () => {},
		errorCode: () => "fetch",
	});

	const models = await lifecycle.refreshModels(
		context({
			allowNetwork: true,
			publish: async ({ persist, update }) => {
				persisted = persist ?? undefined;
				update?.();
				return true;
			},
		}),
	);

	assert.deepEqual(models, [{ id: "current" }]);
	assert.deepEqual(persisted, stored([{ id: "current" }], 20));
	assert.deepEqual(lifecycle.catalog, { source: "live", modelCount: 1, updatedAt: 20, lastError: undefined });
	assert.deepEqual(await lifecycle.refreshModels(context({ allowNetwork: true })), [{ id: "current" }]);
});

test("falls back to a generation-checked in-memory update when persistence fails", async () => {
	let publications = 0;
	const lifecycle = createModelCatalogLifecycle({
		ttlMs: 100,
		discover: async () => [{ id: "current" }],
		restore: () => undefined,
		persist: (models, checkedAt) => stored(models, checkedAt),
		onUpdate: () => {},
		errorCode: () => "fetch",
	});

	const models = await lifecycle.refreshModels(
		context({
			allowNetwork: true,
			publish: async ({ persist, update }) => {
				publications++;
				if (persist) throw new Error("storage unavailable");
				update?.();
				return true;
			},
		}),
	);

	assert.deepEqual(models, [{ id: "current" }]);
	assert.equal(publications, 2);
	assert.equal(lifecycle.catalog.source, "live");
});

test("shares discovery across caller signals without propagating caller cancellation", async () => {
	let requests = 0;
	let discoverySignal: AbortSignal | undefined;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const lifecycle = createModelCatalogLifecycle({
		ttlMs: 100,
		discover: async ({ signal }) => {
			requests++;
			discoverySignal = signal;
			await gate;
			return [{ id: "shared" }];
		},
		restore: () => undefined,
		persist: (models, checkedAt) => stored(models, checkedAt),
		onUpdate: () => {},
		errorCode: () => "fetch",
	});
	const firstController = new AbortController();
	const secondController = new AbortController();

	const first = lifecycle.refreshModels(context({ allowNetwork: true, signal: firstController.signal }));
	await new Promise((resolve) => setImmediate(resolve));
	const second = lifecycle.refreshModels(context({ allowNetwork: true, signal: secondController.signal }));
	firstController.abort();
	const firstOutcome = await Promise.allSettled([first]);

	assert.equal(firstOutcome[0]?.status, "rejected");
	assert.equal(requests, 1);
	assert.notEqual(discoverySignal, firstController.signal);
	assert.notEqual(discoverySignal, secondController.signal);
	assert.equal(discoverySignal?.aborted, false);

	release?.();
	assert.deepEqual(await second, [{ id: "shared" }]);
	assert.equal(lifecycle.catalog.source, "live");
});

test("lets a newer generation publish a shared result after an older generation is rejected", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const lifecycle = createModelCatalogLifecycle({
		ttlMs: 100,
		discover: async () => {
			await gate;
			return [{ id: "shared" }];
		},
		restore: () => undefined,
		persist: (models, checkedAt) => stored(models, checkedAt),
		onUpdate: () => {},
		errorCode: () => "fetch",
	});
	let publications = 0;
	const publishContext = (accepted: boolean) =>
		context({
			allowNetwork: true,
			force: true,
			publish: async ({ update }) => {
				publications++;
				if (!accepted) return false;
				update?.();
				return true;
			},
		});

	const older = lifecycle.refreshModels(publishContext(false));
	await new Promise((resolve) => setImmediate(resolve));
	const newer = lifecycle.refreshModels(publishContext(true));
	release?.();
	await Promise.all([older, newer]);

	assert.equal(publications, 2);
	assert.deepEqual(lifecycle.getModels(), [{ id: "shared" }]);
	assert.equal(lifecycle.catalog.source, "live");
});

test("records synchronous discovery and persistence conversion failures", async () => {
	const syncFailure = createModelCatalogLifecycle({
		initialModels: [{ id: "existing" }],
		ttlMs: 0,
		discover: () => {
			throw new Error("synchronous failure");
		},
		restore: () => undefined,
		persist: (models, checkedAt) => stored(models, checkedAt),
		onUpdate: () => {},
		errorCode: () => "discovery",
	});
	await assert.rejects(syncFailure.refreshModels(context({ allowNetwork: true, force: true })));
	assert.equal(syncFailure.catalog.lastError, "discovery");

	const persistFailure = createModelCatalogLifecycle({
		initialModels: [{ id: "existing" }],
		ttlMs: 0,
		discover: async () => [{ id: "current" }],
		restore: () => undefined,
		persist: () => {
			throw new Error("conversion failure");
		},
		onUpdate: () => {},
		errorCode: () => "persist",
	});
	await assert.rejects(persistFailure.refreshModels(context({ allowNetwork: true, force: true })));
	assert.deepEqual(persistFailure.getModels(), [{ id: "existing" }]);
	assert.equal(persistFailure.catalog.lastError, "persist");
});

test("keeps the last successful catalog after discovery fails", async () => {
	const lifecycle = createModelCatalogLifecycle({
		initialModels: [{ id: "existing" }],
		initialSource: "live",
		ttlMs: 0,
		discover: async () => {
			throw new Error("unavailable");
		},
		restore: () => undefined,
		persist: (models, checkedAt) => stored(models, checkedAt),
		onUpdate: () => {},
		errorCode: () => "fetch",
	});

	await assert.rejects(lifecycle.refreshModels(context({ allowNetwork: true, force: true })));

	assert.deepEqual(lifecycle.getModels(), [{ id: "existing" }]);
	assert.equal(lifecycle.catalog.source, "live");
	assert.equal(lifecycle.catalog.lastError, "fetch");
});
