import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PROVIDER_KIT_ADAPTER_EVENT,
	PROVIDER_KIT_ADAPTER_PROTOCOL_VERSION,
	PROVIDER_KIT_STARTUP_BRIDGE_EVENT,
} from "../core/adapter-protocol.ts";
import { createProviderKitHost } from "../core/host.ts";
import { clearPricingCache, OPENROUTER_MODELS_URL } from "../core/official-pricing.ts";
import type { PreflightAdapter } from "../core/preflight-manager.ts";
import type { ProviderAdapter, StatusAdapter, TunerAdapter } from "../core/types.ts";
import {
	definePreflightExtension,
	defineProviderExtension,
	defineStatusExtension,
	defineTunerExtension,
} from "../index.ts";

interface TestContext {
	model: { provider: string; id: string };
	modelRegistry: {
		getApiKeyForProvider: () => Promise<string>;
		getProviderAuthStatus: () => { configured: boolean; source: string };
		getProvider: (providerId: string) => unknown;
		refresh: () => Promise<void>;
	};
	ui: { notify: (message: string, level?: string) => void };
}

type Handler = (event: any, context: any) => unknown;

class TestPi {
	readonly events = new (class {
		private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

		emit(channel: string, value: unknown): void {
			for (const listener of this.listeners.get(channel) ?? []) listener(value);
		}

		on(channel: string, listener: (value: unknown) => void): () => void {
			const listeners = this.listeners.get(channel) ?? [];
			listeners.push(listener);
			this.listeners.set(channel, listeners);
			return () => {
				const current = this.listeners.get(channel);
				if (!current) return;
				const index = current.indexOf(listener);
				if (index >= 0) current.splice(index, 1);
			};
		}
	})();
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, any>();
	readonly providers = new Map<string, any>();
	readonly providerCalls: string[] = [];
	readonly unregisterCalls: string[] = [];
	readonly nativeProviders = new Map<string, unknown>();
	modelRefreshCalls = 0;

	on(event: string, handler: Handler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	registerCommand(name: string, command: any): void {
		this.commands.set(name, command);
	}

	registerProvider(name: string, config: any): void {
		this.providerCalls.push(name);
		this.providers.set(name, config);
	}

	unregisterProvider(name: string): void {
		this.unregisterCalls.push(name);
		this.providers.delete(name);
	}

	async emit(event: string, value: unknown, context: unknown): Promise<void> {
		for (const handler of [...(this.handlers.get(event) ?? [])]) await handler(value, context);
	}

	context(providerId: string, modelId = "test-model"): TestContext {
		const notifications: Array<{ message: string; level?: string }> = [];
		return {
			model: { provider: providerId, id: modelId },
			modelRegistry: {
				getApiKeyForProvider: async () => "generic-test-key",
				getProviderAuthStatus: () => ({ configured: true, source: "test" }),
				getProvider: (id) => this.providers.get(id) ?? this.nativeProviders.get(id),
				refresh: async () => {
					this.modelRefreshCalls++;
				},
			},
			ui: {
				notify: (message, level) => notifications.push({ message, level }),
			},
		};
	}
}

function providerAdapter(id: string, modelId = "test-model"): ProviderAdapter {
	return {
		id,
		provider: {
			name: `Generic ${id}`,
			baseUrl: "https://provider.invalid/v1",
			apiKey: "$GENERIC_TEST_KEY",
			api: "openai-completions",
			models: [{ id: modelId }],
		},
	};
}

function statusAdapter(id: string, providerId: string, calls?: { count: number }): StatusAdapter {
	return {
		id,
		providerId,
		name: `Generic ${providerId}`,
		cacheTtlMs: 30_000,
		requestTimeoutMs: 1_000,
		async fetch(context) {
			if (calls) calls.count++;
			return {
				entries: [{ kind: "text", id: "state", label: "State", value: "ok" }],
				updatedAt: context.now(),
			};
		},
	};
}

function preflightAdapter(id: string, providerId: string): PreflightAdapter {
	return {
		id,
		providerId,
		name: `Generic ${providerId}`,
		cacheTtlMs: 30_000,
		requestTimeoutMs: 1_000,
		async fetch(context) {
			return { passed: true, checks: ["endpoint"], updatedAt: context.now() };
		},
	};
}

function tunerAdapter(id: string, priority = 0, marker = id): TunerAdapter {
	return {
		id,
		priority,
		matches: (_context, payload) =>
			payload !== null && typeof payload === "object" && Array.isArray((payload as { order?: unknown }).order),
		transform: (payload) => {
			const value = payload as { order: string[] };
			return { ...value, order: [...value.order, marker] };
		},
	};
}

function extensionFactories(options: { statusCalls?: { count: number } } = {}) {
	return {
		provider: defineProviderExtension({
			id: "sample-provider",
			create: () => providerAdapter("sample-provider"),
		}),
		status: defineStatusExtension({
			id: "sample-status",
			providerId: "sample-provider",
			create: () => statusAdapter("sample-status", "sample-provider", options.statusCalls),
		}),
		preflight: definePreflightExtension({
			id: "sample-preflight",
			providerId: "sample-provider",
			create: () => preflightAdapter("sample-preflight", "sample-provider"),
		}),
		tuner: defineTunerExtension({
			id: "sample-tuner",
			create: () => tunerAdapter("sample-tuner", 10),
		}),
	};
}

function createContext(pi: TestPi, providerId: string, modelId = "test-model") {
	return pi.context(providerId, modelId);
}

async function loadDynamicSet(hostFirst: boolean): Promise<{ pi: TestPi; context: TestContext }> {
	const pi = new TestPi();
	const host = createProviderKitHost({
		enableOfficialPricingFallback: false,
		modelDiscoveryTimeoutMs: 37,
		statusRequestTimeoutMs: 41,
	});
	const factories = extensionFactories();
	const ordered = [factories.tuner, factories.status, factories.preflight, factories.provider];

	if (hostFirst) host(pi as unknown as ExtensionAPI);
	for (const factory of ordered) await factory(pi as unknown as ExtensionAPI);
	if (!hostFirst) host(pi as unknown as ExtensionAPI);

	const context = createContext(pi, "sample-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	return { pi, context };
}

test("Pi isolates a missing default export and a throwing factory from a valid extension", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-kit-extension-test-"));
	try {
		const validPath = join(root, "valid.ts");
		const missingDefaultPath = join(root, "missing-default.ts");
		const throwingPath = join(root, "throwing.ts");
		await writeFile(
			validPath,
			'export default (pi) => { pi.registerCommand("valid-extension", { handler: async () => {} }); };',
		);
		await writeFile(missingDefaultPath, "export const notAnExtension = true;");
		await writeFile(throwingPath, 'export default () => { throw new Error("generic load failure"); };');

		const result = await discoverAndLoadExtensions([validPath, missingDefaultPath, throwingPath], root, root);
		assert.equal(result.extensions.length, 1);
		assert.equal(result.extensions[0]?.commands.has("valid-extension"), true);
		assert.equal(result.errors.length, 2);
		assert.match(result.errors.map(({ error }) => error).join("\\n"), /valid factory/);
		assert.match(result.errors.map(({ error }) => error).join("\\n"), /generic load failure/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("each public helper creates one registration envelope and provider registers before publishing", async () => {
	const pi = new TestPi();
	const envelopes: any[] = [];
	const timeline: string[] = [];
	pi.events.on(PROVIDER_KIT_ADAPTER_EVENT, (value) => {
		timeline.push("envelope");
		envelopes.push(value);
	});
	const originalRegisterProvider = pi.registerProvider.bind(pi);
	pi.registerProvider = (name: string, config: any) => {
		timeline.push("provider");
		originalRegisterProvider(name, config);
	};

	const factories = [
		defineProviderExtension({ id: "envelope-provider", create: () => providerAdapter("envelope-provider") }),
		defineStatusExtension({
			id: "envelope-status",
			providerId: "envelope-provider",
			create: () => statusAdapter("envelope-status", "envelope-provider"),
		}),
		definePreflightExtension({
			id: "envelope-preflight",
			providerId: "envelope-provider",
			create: () => preflightAdapter("envelope-preflight", "envelope-provider"),
		}),
		defineTunerExtension({ id: "envelope-tuner", create: () => tunerAdapter("envelope-tuner") }),
	];
	for (const factory of factories) await factory(pi as unknown as ExtensionAPI);

	assert.deepEqual(
		envelopes.map(({ kind, id }) => ({ kind, id })),
		[
			{ kind: "provider", id: "envelope-provider" },
			{ kind: "status", id: "envelope-status" },
			{ kind: "preflight", id: "envelope-preflight" },
			{ kind: "tuner", id: "envelope-tuner" },
		],
	);
	const providerEnvelope = envelopes.find(({ kind }) => kind === "provider");
	assert.deepEqual(providerEnvelope?.modelDrafts, [{ id: "test-model" }]);
	assert.deepEqual(providerEnvelope?.adapter.provider.models[0]?.cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
	assert.equal(timeline[0], "provider");
	assert.equal(timeline[1], "envelope");
	for (const envelope of envelopes) {
		assert.equal(envelope.version, PROVIDER_KIT_ADAPTER_PROTOCOL_VERSION);
		assert.equal(typeof envelope.token, "object");
		assert.equal(typeof envelope.factory, "function");
		assert.equal(typeof envelope.startupDependencies, "object");
	}
});

test("helpers isolate invalid static identity, returned identity, timing, shape, and factory errors", async () => {
	assert.throws(
		() => defineProviderExtension({ id: "invalid id", create: () => providerAdapter("invalid id") } as any),
		/static ID/,
	);

	const pi = new TestPi();
	const envelopes: unknown[] = [];
	pi.events.on(PROVIDER_KIT_ADAPTER_EVENT, (value) => envelopes.push(value));
	const invalidFactories = [
		defineProviderExtension({
			id: "returned-provider",
			create: () => ({ ...providerAdapter("different-provider") }),
		}),
		defineStatusExtension({
			id: "returned-status",
			providerId: "provider",
			create: () => ({ ...statusAdapter("returned-status", "different-provider") }),
		}),
		definePreflightExtension({
			id: "invalid-preflight",
			providerId: "provider",
			create: () => ({ ...preflightAdapter("invalid-preflight", "provider"), requestTimeoutMs: 0 }),
		}),
		defineTunerExtension({
			id: "invalid-tuner",
			create: () => ({ ...tunerAdapter("invalid-tuner"), priority: 1.5 }),
		}),
		defineProviderExtension({
			id: "invalid-shape",
			create: () => ({ id: "invalid-shape", provider: undefined }) as any,
		}),
		defineTunerExtension({
			id: "factory-error",
			create: async () => {
				throw new Error("generic factory failure");
			},
		}),
	];

	for (const factory of invalidFactories) await assert.rejects(() => factory(pi as unknown as ExtensionAPI));
	assert.deepEqual(envelopes, []);
});

test("Host accepts adapters before or after it, replays session_start, and defers diagnostics work", async () => {
	for (const hostFirst of [true, false]) {
		const { pi, context } = await loadDynamicSet(hostFirst);
		const command = pi.commands.get("status");
		assert.ok(command);
		assert.equal(pi.providerCalls.filter((id) => id === "sample-provider").length, 1);

		const notifications: Array<{ message: string; level?: string }> = [];
		context.ui.notify = (message, level) => notifications.push({ message, level });
		await command.handler("refresh", context);

		assert.equal(pi.providerCalls.filter((id) => id === "sample-provider").length, 2);
		assert.match(notifications.at(-1)?.message ?? "", /Status: fresh/);
		assert.match(notifications.at(-1)?.message ?? "", /Preflight: passed · endpoint/);
		assert.equal(notifications.at(-1)?.level, "info");

		const beforeRequest = pi.handlers.get("before_provider_request")?.[0];
		assert.ok(beforeRequest);
		const transformed = await beforeRequest({ payload: { order: [] } }, context);
		assert.deepEqual(transformed, { order: ["sample-tuner"] });
	}
});

test("Host materializes independent adapter factories concurrently", async () => {
	const pi = new TestPi();
	let hostReady = false;
	let running = 0;
	let maximumRunning = 0;
	const materialize = async <T>(adapter: T): Promise<T> => {
		if (!hostReady) return adapter;
		running++;
		maximumRunning = Math.max(maximumRunning, running);
		await new Promise((resolve) => setTimeout(resolve, 5));
		running--;
		return adapter;
	};
	const factories = [
		defineProviderExtension({
			id: "parallel-factory-provider",
			create: async () => await materialize(providerAdapter("parallel-factory-provider")),
		}),
		defineStatusExtension({
			id: "parallel-factory-status",
			providerId: "parallel-factory-provider",
			create: async () => await materialize(statusAdapter("parallel-factory-status", "parallel-factory-provider")),
		}),
		definePreflightExtension({
			id: "parallel-factory-preflight",
			providerId: "parallel-factory-provider",
			create: async () =>
				await materialize(preflightAdapter("parallel-factory-preflight", "parallel-factory-provider")),
		}),
		defineTunerExtension({
			id: "parallel-factory-tuner",
			create: async () => await materialize(tunerAdapter("parallel-factory-tuner")),
		}),
	];
	for (const factory of factories) await factory(pi as unknown as ExtensionAPI);

	hostReady = true;
	createProviderKitHost({ enableOfficialPricingFallback: false })(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "parallel-factory-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await pi.commands.get("status").handler("", context);

	assert.equal(maximumRunning, 3);
});

test("Host schedules one non-blocking model catalog refresh for startup and reload", async () => {
	const pi = new TestPi();
	createProviderKitHost({ enableOfficialPricingFallback: false })(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "unused-provider");

	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.modelRefreshCalls, 1);

	await pi.emit("session_start", { type: "session_start", reason: "new" }, context);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.modelRefreshCalls, 1);

	await pi.emit("session_start", { type: "session_start", reason: "reload" }, context);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.modelRefreshCalls, 2);
});

test("Host isolates malformed envelopes and excludes every duplicate ID or binding", async () => {
	const pi = new TestPi();
	const host = createProviderKitHost({ enableOfficialPricingFallback: false });
	host(pi as unknown as ExtensionAPI);
	pi.events.emit(PROVIDER_KIT_ADAPTER_EVENT, { version: 1, kind: "tuner", id: "broken", token: {}, adapter: null });

	const factories = [
		defineProviderExtension({ id: "conflict-provider", create: () => providerAdapter("conflict-provider", "one") }),
		defineProviderExtension({ id: "conflict-provider", create: () => providerAdapter("conflict-provider", "two") }),
		defineProviderExtension({ id: "good-provider", create: () => providerAdapter("good-provider") }),
		defineProviderExtension({ id: "status-provider", create: () => providerAdapter("status-provider") }),
		defineProviderExtension({ id: "preflight-provider", create: () => providerAdapter("preflight-provider") }),
		defineStatusExtension({
			id: "good-status",
			providerId: "good-provider",
			create: () => statusAdapter("good-status", "good-provider"),
		}),
		defineStatusExtension({
			id: "duplicate-status",
			providerId: "status-provider",
			create: () => statusAdapter("duplicate-status", "status-provider"),
		}),
		defineStatusExtension({
			id: "duplicate-status",
			providerId: "status-provider",
			create: () => statusAdapter("duplicate-status", "status-provider"),
		}),
		defineStatusExtension({
			id: "binding-status-a",
			providerId: "status-provider",
			create: () => statusAdapter("binding-status-a", "status-provider"),
		}),
		defineStatusExtension({
			id: "binding-status-b",
			providerId: "status-provider",
			create: () => statusAdapter("binding-status-b", "status-provider"),
		}),
		definePreflightExtension({
			id: "duplicate-preflight",
			providerId: "preflight-provider",
			create: () => preflightAdapter("duplicate-preflight", "preflight-provider"),
		}),
		definePreflightExtension({
			id: "duplicate-preflight",
			providerId: "preflight-provider",
			create: () => preflightAdapter("duplicate-preflight", "preflight-provider"),
		}),
		definePreflightExtension({
			id: "binding-preflight-a",
			providerId: "preflight-provider",
			create: () => preflightAdapter("binding-preflight-a", "preflight-provider"),
		}),
		definePreflightExtension({
			id: "binding-preflight-b",
			providerId: "preflight-provider",
			create: () => preflightAdapter("binding-preflight-b", "preflight-provider"),
		}),
		defineTunerExtension({ id: "duplicate-tuner", create: () => tunerAdapter("duplicate-tuner", 0, "first") }),
		defineTunerExtension({ id: "duplicate-tuner", create: () => tunerAdapter("duplicate-tuner", 0, "second") }),
		defineTunerExtension({ id: "good-tuner", create: () => tunerAdapter("good-tuner", 0, "good") }),
	];
	for (const factory of factories) await factory(pi as unknown as ExtensionAPI);

	const context = createContext(pi, "good-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	const command = pi.commands.get("status");
	const notifications: string[] = [];
	context.ui.notify = (message) => notifications.push(message);
	await command.handler("refresh", context);
	assert.ok(pi.providers.has("good-provider"));
	assert.ok(pi.providers.has("status-provider"));
	assert.equal(pi.providers.has("conflict-provider"), false);
	assert.match(notifications.at(-1) ?? "", /Status: fresh/);

	const statusProviderContext = createContext(pi, "status-provider");
	const conflictNotifications: string[] = [];
	statusProviderContext.ui.notify = (message) => conflictNotifications.push(message);
	await command.handler("", statusProviderContext);
	assert.match(conflictNotifications.at(-1) ?? "", /Status: not supported/);

	const preflightContext = createContext(pi, "preflight-provider");
	const preflightNotifications: string[] = [];
	preflightContext.ui.notify = (message) => preflightNotifications.push(message);
	await command.handler("", preflightContext);
	assert.match(preflightNotifications.at(-1) ?? "", /Preflight: not configured/);

	const beforeRequest = pi.handlers.get("before_provider_request")?.[0];
	assert.ok(beforeRequest);
	const transformed = await beforeRequest({ payload: { order: [] } }, context);
	assert.deepEqual(transformed, { order: ["good"] });
});

test("Host reapplies official pricing when it re-registers an accepted Provider", async () => {
	const pi = new TestPi();
	const host = createProviderKitHost({
		enableOfficialPricingFallback: true,
		officialPricingUrl: "https://pricing.invalid/models",
		fetch: async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "pricing-model",
							pricing: { prompt: "0.000001", completion: "0.000002" },
						},
					],
				}),
				{ status: 200 },
			),
	});
	host(pi as unknown as ExtensionAPI);
	const providerFactory = defineProviderExtension({
		id: "pricing-provider",
		create: () => ({
			id: "pricing-provider",
			provider: {
				name: "Generic Pricing Provider",
				baseUrl: "https://pricing.invalid/v1",
				apiKey: "$GENERIC_PRICING_KEY",
				api: "openai-completions",
				models: [{ id: "pricing-model" }],
			},
		}),
	});
	await providerFactory(pi as unknown as ExtensionAPI);
	assert.equal(pi.providers.get("pricing-provider")?.models[0]?.cost.input, 0);
	const context = createContext(pi, "pricing-provider", "pricing-model");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await pi.commands.get("status").handler("", context);
	assert.equal(pi.providers.get("pricing-provider")?.models[0]?.cost.input, 1);
	assert.equal(pi.providers.get("pricing-provider")?.models[0]?.cost.output, 2);
});

test("Host reapplies OpenRouter metadata after a non-blocking refresh", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-kit-host-pricing-"));
	clearPricingCache(OPENROUTER_MODELS_URL);
	let release: (() => void) | undefined;
	let signalStarted: (() => void) | undefined;
	const fetchStarted = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const fetchFn = (async (input) => {
		assert.equal(input.toString(), OPENROUTER_MODELS_URL);
		signalStarted?.();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return new Response(
			JSON.stringify({
				data: [
					{
						id: "reference/host-pricing-model",
						pricing: { prompt: "0.000001", completion: "0.000002" },
					},
				],
			}),
			{ status: 200 },
		);
	}) as typeof globalThis.fetch;
	try {
		const pi = new TestPi();
		createProviderKitHost({
			fetch: fetchFn,
			officialPricingCacheTtlMs: 0,
			openRouterMetadataCachePath: join(root, "metadata.json"),
		})(pi as unknown as ExtensionAPI);
		const providerFactory = defineProviderExtension({
			id: "host-background-pricing",
			create: () => ({
				id: "host-background-pricing",
				provider: {
					name: "Host Background Pricing",
					baseUrl: "https://provider.invalid/v1",
					apiKey: "$HOST_BACKGROUND_PRICING_KEY",
					api: "openai-completions",
					models: [{ id: "host-pricing-model" }],
				},
			}),
		});
		await providerFactory(pi as unknown as ExtensionAPI);
		assert.equal(pi.providers.get("host-background-pricing")?.models[0]?.cost.input, 0);

		const context = createContext(pi, "host-background-pricing", "host-pricing-model");
		await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
		await pi.commands.get("status").handler("", context);
		await fetchStarted;
		release?.();
		for (
			let attempt = 0;
			attempt < 100 && pi.providers.get("host-background-pricing")?.models[0]?.cost.input !== 1;
			attempt++
		) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.equal(pi.providers.get("host-background-pricing")?.models[0]?.cost.input, 1);
		assert.equal(pi.providers.get("host-background-pricing")?.models[0]?.cost.output, 2);
	} finally {
		clearPricingCache(OPENROUTER_MODELS_URL);
		await rm(root, { recursive: true, force: true });
	}
});

test("Host preserves a dynamically refreshed catalog when background pricing arrives", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-kit-host-dynamic-pricing-"));
	clearPricingCache(OPENROUTER_MODELS_URL);
	let release: (() => void) | undefined;
	let signalStarted: (() => void) | undefined;
	const fetchStarted = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const fetchFn = (async (input) => {
		assert.equal(input.toString(), OPENROUTER_MODELS_URL);
		signalStarted?.();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return new Response(
			JSON.stringify({
				data: [
					{
						id: "reference/dynamic-pricing-model",
						pricing: { prompt: "0.000001", completion: "0.000002" },
					},
				],
			}),
			{ status: 200 },
		);
	}) as typeof globalThis.fetch;
	try {
		const pi = new TestPi();
		createProviderKitHost({
			fetch: fetchFn,
			officialPricingCacheTtlMs: 0,
			openRouterMetadataCachePath: join(root, "metadata.json"),
		})(pi as unknown as ExtensionAPI);
		const providerFactory = defineProviderExtension({
			id: "host-dynamic-pricing",
			create: () => ({
				id: "host-dynamic-pricing",
				provider: {
					name: "Host Dynamic Pricing",
					baseUrl: "https://provider.invalid/v1",
					apiKey: "$HOST_DYNAMIC_PRICING_KEY",
					api: "openai-completions",
					models: [{ id: "initial-model" }],
					refreshModels: async () => [{ id: "dynamic-pricing-model" }],
				},
			}),
		});
		await providerFactory(pi as unknown as ExtensionAPI);
		const context = createContext(pi, "host-dynamic-pricing", "initial-model");
		await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
		await pi.commands.get("status").handler("", context);
		await fetchStarted;

		const registered = pi.providers.get("host-dynamic-pricing");
		await registered.refreshModels({} as any);
		assert.equal(pi.providers.get("host-dynamic-pricing")?.models[0]?.id, "dynamic-pricing-model");
		release?.();

		await new Promise<void>((resolve, reject) => {
			let stopped = false;
			const timer = setTimeout(() => {
				stopped = true;
				reject(new Error("background metadata refresh did not re-register the dynamic Provider"));
			}, 1_000);
			const poll = () => {
				if (stopped) return;
				if (pi.providerCalls.filter((id) => id === "host-dynamic-pricing").length >= 3) {
					stopped = true;
					clearTimeout(timer);
					resolve();
					return;
				}
				setImmediate(poll);
			};
			poll();
		});

		assert.equal(pi.providers.get("host-dynamic-pricing")?.models[0]?.id, "dynamic-pricing-model");
		assert.equal(pi.providers.get("host-dynamic-pricing")?.models[0]?.cost.input, 1);
	} finally {
		clearPricingCache(OPENROUTER_MODELS_URL);
		await rm(root, { recursive: true, force: true });
	}
});

test("Host can bind a Status Adapter to a native Pi provider", async () => {
	const pi = new TestPi();
	pi.nativeProviders.set("native-provider", { getModels: () => [{ id: "test-model" }] });
	const host = createProviderKitHost({ enableOfficialPricingFallback: false });
	host(pi as unknown as ExtensionAPI);
	const statusFactory = defineStatusExtension({
		id: "native-status",
		providerId: "native-provider",
		create: () => statusAdapter("native-status", "native-provider"),
	});
	await statusFactory(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "native-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	const notifications: string[] = [];
	context.ui.notify = (message) => notifications.push(message);
	await pi.commands.get("status").handler("refresh", context);
	assert.match(notifications.at(-1) ?? "", /Status: fresh/);
});

test("tuner ordering is deterministic for equal priorities", async () => {
	const pi = new TestPi();
	const host = createProviderKitHost({ enableOfficialPricingFallback: false });
	host(pi as unknown as ExtensionAPI);
	for (const factory of [
		defineProviderExtension({ id: "ordering-provider", create: () => providerAdapter("ordering-provider") }),
		defineTunerExtension({ id: "zeta-tuner", create: () => tunerAdapter("zeta-tuner", 10) }),
		defineTunerExtension({ id: "alpha-tuner", create: () => tunerAdapter("alpha-tuner", 10) }),
		defineTunerExtension({ id: "low-tuner", create: () => tunerAdapter("low-tuner", 1) }),
	]) {
		await factory(pi as unknown as ExtensionAPI);
	}
	const context = createContext(pi, "ordering-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	const beforeRequest = pi.handlers.get("before_provider_request")?.[0];
	const transformed = await beforeRequest?.({ payload: { order: [] } }, context);
	assert.deepEqual((transformed as { order: string[] }).order, ["low-tuner", "alpha-tuner", "zeta-tuner"]);
});

test("Host shutdown removes listeners and a reloaded Host starts with fresh manager state", async () => {
	const statusCalls = { count: 0 };
	const makeFactories = (includeStatus: boolean) => ({
		provider: defineProviderExtension({ id: "reload-provider", create: () => providerAdapter("reload-provider") }),
		...(includeStatus
			? {
					status: defineStatusExtension({
						id: "reload-status",
						providerId: "reload-provider",
						create: () => statusAdapter("reload-status", "reload-provider", statusCalls),
					}),
				}
			: {}),
	});

	const firstPi = new TestPi();
	const firstHost = createProviderKitHost({ enableOfficialPricingFallback: false });
	firstHost(firstPi as unknown as ExtensionAPI);
	const firstFactories = makeFactories(true);
	await firstFactories.provider(firstPi as unknown as ExtensionAPI);
	await firstFactories.status?.(firstPi as unknown as ExtensionAPI);
	const firstContext = createContext(firstPi, "reload-provider");
	await firstPi.emit("session_start", { type: "session_start", reason: "startup" }, firstContext);
	await firstPi.commands.get("status").handler("refresh", firstContext);
	assert.equal(statusCalls.count, 1);
	await firstPi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, firstContext);

	const secondPi = new TestPi();
	const secondHost = createProviderKitHost({ enableOfficialPricingFallback: false });
	secondHost(secondPi as unknown as ExtensionAPI);
	const secondFactories = makeFactories(false);
	await secondFactories.provider(secondPi as unknown as ExtensionAPI);
	const secondContext = createContext(secondPi, "reload-provider");
	await secondPi.emit("session_start", { type: "session_start", reason: "reload" }, secondContext);
	const secondNotifications: string[] = [];
	secondContext.ui.notify = (message) => secondNotifications.push(message);
	await secondPi.commands.get("status").handler("", secondContext);
	assert.equal(statusCalls.count, 1);
	assert.match(secondNotifications.at(-1) ?? "", /Status: not supported/);

	const thirdPi = new TestPi();
	const thirdHost = createProviderKitHost({ enableOfficialPricingFallback: false });
	thirdHost(thirdPi as unknown as ExtensionAPI);
	const thirdFactories = makeFactories(true);
	await thirdFactories.provider(thirdPi as unknown as ExtensionAPI);
	await thirdFactories.status?.(thirdPi as unknown as ExtensionAPI);
	const thirdContext = createContext(thirdPi, "reload-provider");
	await thirdPi.emit("session_start", { type: "session_start", reason: "reload" }, thirdContext);
	await thirdPi.commands.get("status").handler("refresh", thirdContext);
	assert.equal(statusCalls.count, 2);
});

test("Host startup bridge supplies shared dependencies when Host loads first", async () => {
	const pi = new TestPi();
	const host = createProviderKitHost({
		enableOfficialPricingFallback: false,
		modelDiscoveryTimeoutMs: 73,
		statusRequestTimeoutMs: 79,
	});
	host(pi as unknown as ExtensionAPI);
	let received: { modelDiscoveryTimeoutMs: number; statusRequestTimeoutMs: number } | undefined;
	const factory = defineProviderExtension({
		id: "bridge-provider",
		create: ({ modelDiscoveryTimeoutMs, statusRequestTimeoutMs }) => {
			received = { modelDiscoveryTimeoutMs, statusRequestTimeoutMs };
			return providerAdapter("bridge-provider");
		},
	});
	await factory(pi as unknown as ExtensionAPI);
	assert.deepEqual(received, { modelDiscoveryTimeoutMs: 73, statusRequestTimeoutMs: 79 });
	assert.equal(pi.handlers.has("session_start"), true);
	assert.equal(typeof PROVIDER_KIT_STARTUP_BRIDGE_EVENT, "string");
});

test("Host rehydrates an adapter with Host dependencies when the adapter loads first", async () => {
	const pi = new TestPi();
	const received: number[] = [];
	const factory = defineProviderExtension({
		id: "late-bridge-provider",
		create: ({ modelDiscoveryTimeoutMs }) => {
			received.push(modelDiscoveryTimeoutMs);
			return providerAdapter("late-bridge-provider");
		},
	});
	await factory(pi as unknown as ExtensionAPI);

	const host = createProviderKitHost({
		enableOfficialPricingFallback: false,
		modelDiscoveryTimeoutMs: 73,
	});
	host(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "late-bridge-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await pi.commands.get("status").handler("check", context);

	assert.deepEqual(received, [3_000, 73]);
});

test("Host rehydrates every adapter capability with Host dependencies", async () => {
	const pi = new TestPi();
	const received = { status: [] as number[], preflight: [] as number[], tuner: [] as number[] };
	await defineProviderExtension({
		id: "late-capability-provider",
		create: () => providerAdapter("late-capability-provider"),
	})(pi as unknown as ExtensionAPI);
	await defineStatusExtension({
		id: "late-capability-status",
		providerId: "late-capability-provider",
		create: ({ statusRequestTimeoutMs }) => {
			received.status.push(statusRequestTimeoutMs);
			return statusAdapter("late-capability-status", "late-capability-provider");
		},
	})(pi as unknown as ExtensionAPI);
	await definePreflightExtension({
		id: "late-capability-preflight",
		providerId: "late-capability-provider",
		create: ({ statusRequestTimeoutMs }) => {
			received.preflight.push(statusRequestTimeoutMs);
			return preflightAdapter("late-capability-preflight", "late-capability-provider");
		},
	})(pi as unknown as ExtensionAPI);
	await defineTunerExtension({
		id: "late-capability-tuner",
		create: ({ statusRequestTimeoutMs }) => {
			received.tuner.push(statusRequestTimeoutMs);
			return tunerAdapter("late-capability-tuner");
		},
	})(pi as unknown as ExtensionAPI);

	createProviderKitHost({
		enableOfficialPricingFallback: false,
		statusRequestTimeoutMs: 79,
	})(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "late-capability-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await pi.commands.get("status").handler("check", context);

	assert.deepEqual(received.status, [8_000, 79]);
	assert.deepEqual(received.preflight, [8_000, 79]);
	assert.deepEqual(received.tuner, [8_000, 79]);
});

test("only the first Provider Kit Host installs runtime handlers", async () => {
	const pi = new TestPi();
	createProviderKitHost({ enableOfficialPricingFallback: false })(pi as unknown as ExtensionAPI);
	createProviderKitHost({ enableOfficialPricingFallback: false })(pi as unknown as ExtensionAPI);

	assert.equal(pi.handlers.get("before_provider_request")?.length, 1);
	assert.equal(pi.handlers.get("model_select")?.length, 1);
	assert.equal(pi.commands.has("status"), true);
});

test("Host does not install a registry after session shutdown cancels readiness", async () => {
	const pi = new TestPi();
	createProviderKitHost({
		officialPricingUrl: "https://shutdown-race.invalid/models",
		officialPricingTimeoutMs: 20,
		fetch: async () => await new Promise<Response>(() => {}),
	})(pi as unknown as ExtensionAPI);
	const factory = defineProviderExtension({
		id: "shutdown-race-provider",
		create: () => providerAdapter("shutdown-race-provider"),
	});
	await factory(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "shutdown-race-provider");
	const pending = pi.commands.get("status").handler("check", context);
	await new Promise((resolve) => setImmediate(resolve));
	await pi.emit("session_shutdown", { type: "session_shutdown", reason: "test" }, context);
	await pending;
	await new Promise((resolve) => setTimeout(resolve, 30));

	assert.equal(pi.providerCalls.filter((id) => id === "shutdown-race-provider").length, 1);
});

test("index.ts remains strictly decoupled with zero static imports to capability subdirectories", async () => {
	const indexContent = await import("node:fs/promises").then((fs) =>
		fs.readFile(join(import.meta.dirname, "../index.ts"), "utf-8"),
	);

	for (const dir of ["providers/", "status/", "preflight/", "tuners/"]) {
		assert.equal(
			indexContent.includes(`from "./${dir}`),
			false,
			`index.ts must not statically import from ./${dir} to ensure drop-in capability files remain autonomous`,
		);
	}
});

test("drop-in capability files can be added or removed without modifying index.ts via manifest discovery", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-manifest-dropin-"));
	try {
		const pkgJson = await import("node:fs/promises").then((fs) =>
			fs.readFile(join(import.meta.dirname, "../package.json"), "utf-8"),
		);
		const manifest = JSON.parse(pkgJson);
		const extensionGlobs = manifest.pi?.extensions as string[];
		assert.ok(extensionGlobs.includes("./tuners/*.ts"), "manifest must declare ./tuners/*.ts glob");

		const indexPath = join(root, "index.ts");
		const tunersDir = join(root, "tuners");
		await import("node:fs/promises").then((fs) => fs.mkdir(tunersDir, { recursive: true }));

		// Point root index.ts to project host
		await writeFile(
			indexPath,
			`
import { createProviderKitHost } from "${join(import.meta.dirname, "../index.ts")}";
export default createProviderKitHost({ enableOfficialPricingFallback: false });
`,
		);

		// Helper to resolve manifest files in the root dir
		const resolveFiles = async () => {
			const files: string[] = [indexPath];
			const tunerFiles = await import("node:fs/promises").then((fs) => fs.readdir(tunersDir).catch(() => []));
			for (const f of tunerFiles) {
				if (f.endsWith(".ts")) files.push(join(tunersDir, f));
			}
			return files;
		};

		// 1. Initial load without tuners
		const initialFiles = await resolveFiles();
		const initialLoad = await discoverAndLoadExtensions(initialFiles, root, root);
		assert.equal(initialLoad.extensions.length, 1);
		assert.equal(initialLoad.errors.length, 0);

		// 2. Add dynamic tuner via file drop-in
		const dynamicTunerPath = join(tunersDir, "dynamic.ts");
		await writeFile(
			dynamicTunerPath,
			`
import { defineTunerExtension } from "${join(import.meta.dirname, "../index.ts")}";
export default defineTunerExtension({
  id: "dynamic-manifest-tuner",
  priority: 10,
  create: () => ({
    id: "dynamic-manifest-tuner",
    matches: () => true,
    transform: (payload) => ({ ...payload, manifestTunerActive: true }),
  }),
});
`,
		);

		// Reload step via discoverAndLoadExtensions
		const loadedFiles = await resolveFiles();
		const reloaded = await discoverAndLoadExtensions(loadedFiles, root, root);
		assert.equal(reloaded.extensions.length, 2);
		assert.equal(reloaded.errors.length, 0);

		// 3. Remove tuner file and reload again
		await rm(dynamicTunerPath);
		const cleanedFiles = await resolveFiles();
		const finalLoad = await discoverAndLoadExtensions(cleanedFiles, root, root);
		assert.equal(finalLoad.extensions.length, 1);
		assert.equal(finalLoad.errors.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
