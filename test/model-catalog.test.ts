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
