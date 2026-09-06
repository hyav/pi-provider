import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as adapterProtocol from "../core/adapter-protocol.ts";
import {
	PI_PROVIDER_ADAPTER_EVENT,
	PI_PROVIDER_ADAPTER_PROTOCOL_VERSION,
	PI_PROVIDER_STARTUP_BRIDGE_EVENT,
} from "../core/adapter-protocol.ts";
import { createPiProviderHost } from "../core/host.ts";
import type { PreflightAdapter } from "../core/preflight-manager.ts";
import type { ProviderAdapter, StatusAdapter, TunerAdapter } from "../core/types.ts";
import {
	createModelCatalogLifecycle,
	createPiProviderExtension,
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

test("uses the Pi Provider event namespace", () => {
	const protocol = adapterProtocol as unknown as Record<string, unknown>;
	assert.equal(protocol.PI_PROVIDER_ADAPTER_EVENT, "pi-provider:adapter");
	assert.equal(protocol.PI_PROVIDER_STARTUP_BRIDGE_EVENT, "pi-provider:startup-bridge");
	assert.equal(protocol.PI_PROVIDER_HOST_CLAIM_EVENT, "pi-provider:host-claim");
	assert.equal(protocol.PI_PROVIDER_ADAPTER_PROTOCOL_VERSION, 2);
});

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

async function writeFixturePackageEntrypoint(root: string): Promise<string> {
	const entrypoint = join(root, "index.ts");
	await writeFile(
		entrypoint,
		`
import { createPiProviderExtension } from ${JSON.stringify(join(import.meta.dirname, "../index.ts"))};
export default createPiProviderExtension({
  adapterRoot: ${JSON.stringify(root)},
  dependencies: { enableOfficialPricingFallback: false },
});
`,
	);
	return entrypoint;
}

test("the package entrypoint loads every built-in adapter", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-provider-isolated-agent-");
	try {
		const pi = new TestPi();
		const piProviderExtension = createPiProviderExtension({
			dependencies: { enableOfficialPricingFallback: false },
		});
		const registrations: Array<{ kind: string; id: string }> = [];
		pi.events.on(PI_PROVIDER_ADAPTER_EVENT, (value) => {
			if (value && typeof value === "object" && "kind" in value && "id" in value) {
				registrations.push({
					kind: String(value.kind),
					id: String(value.id),
				});
			}
		});

		await piProviderExtension(pi as unknown as ExtensionAPI);

		assert.deepEqual(
			registrations.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)),
			[
				{ kind: "preflight", id: "anthropic-preflight" },
				{ kind: "preflight", id: "cerebras-preflight" },
				{ kind: "preflight", id: "charm-hyper-preflight" },
				{ kind: "preflight", id: "deepseek-preflight" },
				{ kind: "preflight", id: "github-copilot-preflight" },
				{ kind: "preflight", id: "google-preflight" },
				{ kind: "preflight", id: "groq-preflight" },
				{ kind: "preflight", id: "huggingface-preflight" },
				{ kind: "preflight", id: "mistral-preflight" },
				{ kind: "preflight", id: "moonshotai-cn-preflight" },
				{ kind: "preflight", id: "moonshotai-preflight" },
				{ kind: "preflight", id: "nvidia-preflight" },
				{ kind: "preflight", id: "openai-codex-preflight" },
				{ kind: "preflight", id: "openai-preflight" },
				{ kind: "preflight", id: "opencode-go-preflight" },
				{ kind: "preflight", id: "opencode-preflight" },
				{ kind: "preflight", id: "openrouter-preflight" },
				{ kind: "preflight", id: "vercel-ai-gateway-preflight" },
				{ kind: "preflight", id: "xai-preflight" },
				{ kind: "provider", id: "charm-hyper" },
				{ kind: "status", id: "anthropic-status" },
				{ kind: "status", id: "charm-hyper-status" },
				{ kind: "status", id: "deepseek-status" },
				{ kind: "status", id: "github-copilot-status" },
				{ kind: "status", id: "groq-status" },
				{ kind: "status", id: "huggingface-status" },
				{ kind: "status", id: "moonshotai-cn-status" },
				{ kind: "status", id: "moonshotai-status" },
				{ kind: "status", id: "openai-codex-status" },
				{ kind: "status", id: "opencode-go-status" },
				{ kind: "status", id: "openrouter-status" },
				{ kind: "status", id: "vercel-ai-gateway-status" },
				{ kind: "status", id: "xai-status" },
			],
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("the package entrypoint discovers adapters under Pi's resolved agent directory", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-provider-agent-dir-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const providersDir = join(agentDir, "extensions", "pi-provider", "providers");
		await import("node:fs/promises").then((fs) => fs.mkdir(providersDir, { recursive: true }));
		await writeFile(
			join(providersDir, "agent-provider.ts"),
			`
import { defineProviderExtension } from "@hyav/pi-provider";
export default defineProviderExtension({
  id: "agent-provider",
  create: () => ({
    id: "agent-provider",
    provider: {
      name: "Agent Provider",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "$AGENT_PROVIDER_KEY",
      api: "openai-completions",
      models: [{ id: "agent-model" }],
    },
  }),
});
`,
		);

		const pi = new TestPi();
		const piProviderExtension = createPiProviderExtension({
			dependencies: { enableOfficialPricingFallback: false },
		});
		await piProviderExtension(pi as unknown as ExtensionAPI);
		assert.ok(pi.providers.has("agent-provider"));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("reloading the package entrypoint discovers added and removed adapter files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-reload-add-"));
	try {
		const providersDir = join(root, "providers");
		await import("node:fs/promises").then((fs) => fs.mkdir(providersDir, { recursive: true }));
		const entrypoint = await writeFixturePackageEntrypoint(root);

		const loadProviderIds = async (): Promise<string[]> => {
			const result = await discoverAndLoadExtensions([entrypoint], root, root);
			assert.deepEqual(result.errors, []);
			assert.equal(result.extensions.length, 1);
			return result.runtime.pendingProviderRegistrations.map(({ name }) => name);
		};

		assert.deepEqual(await loadProviderIds(), ["charm-hyper"]);
		const providerPath = join(providersDir, "reload-provider.ts");
		await writeFile(
			providerPath,
			`
import { defineProviderExtension } from "@hyav/pi-provider";
export default defineProviderExtension({
  id: "reload-provider",
  create: () => ({
    id: "reload-provider",
    provider: {
      name: "Reload Provider",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "$RELOAD_PROVIDER_KEY",
      api: "openai-completions",
      models: [{ id: "reload-model" }],
    },
  }),
});
`,
		);

		assert.deepEqual(await loadProviderIds(), ["charm-hyper", "reload-provider"]);
		await rm(providerPath);
		assert.deepEqual(await loadProviderIds(), ["charm-hyper"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the package entrypoint isolates an invalid adapter and reports its capability path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-reload-invalid-"));
	const warnings: string[] = [];
	const originalWarn = console.warn;
	try {
		const providersDir = join(root, "providers");
		await import("node:fs/promises").then((fs) => fs.mkdir(providersDir, { recursive: true }));
		const entrypoint = await writeFixturePackageEntrypoint(root);
		await writeFile(join(providersDir, "invalid.ts"), "export default 42;\n");
		await writeFile(
			join(providersDir, "throwing.ts"),
			'export default () => { throw new Error("factory failed"); };\n',
		);
		await writeFile(
			join(providersDir, "valid.ts"),
			`
import { defineProviderExtension } from "@hyav/pi-provider";
export default defineProviderExtension({
  id: "valid-after-invalid",
  create: () => ({
    id: "valid-after-invalid",
    provider: {
      name: "Valid Provider",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "$VALID_PROVIDER_KEY",
      api: "openai-completions",
      models: [{ id: "valid-model" }],
    },
  }),
});
`,
		);
		console.warn = (message?: unknown) => warnings.push(String(message));

		const result = await discoverAndLoadExtensions([entrypoint], root, root);

		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		assert.ok(result.runtime.pendingProviderRegistrations.some(({ name }) => name === "valid-after-invalid"));
		assert.deepEqual(warnings, [
			'[pi-provider] failed to load adapter extension "providers/invalid.ts": default export must be a Pi extension factory',
			'[pi-provider] failed to load adapter extension "providers/throwing.ts": factory failed',
		]);
	} finally {
		console.warn = originalWarn;
		await rm(root, { recursive: true, force: true });
	}
});

async function loadDynamicSet(hostFirst: boolean): Promise<{ pi: TestPi; context: TestContext }> {
	const pi = new TestPi();
	const host = createPiProviderHost({
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
	const root = await mkdtemp(join(tmpdir(), "pi-provider-extension-test-"));
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
	pi.events.on(PI_PROVIDER_ADAPTER_EVENT, (value) => {
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
		assert.equal(envelope.version, PI_PROVIDER_ADAPTER_PROTOCOL_VERSION);
		assert.equal(typeof envelope.token, "object");
		assert.equal(typeof envelope.factory, "function");
		assert.equal(typeof envelope.startupDependencies, "object");
	}
});

test("an OAuth-only Provider clears a queued environment key when the session starts", async () => {
	const environmentName = "PI_PROVIDER_OAUTH_RELOAD_KEY";
	const previous = process.env[environmentName];
	delete process.env[environmentName];
	try {
		const pi = new TestPi();
		const id = "oauth-reload-provider";
		const factory = defineProviderExtension({
			id,
			create: () => ({
				...providerAdapter(id),
				provider: {
					...providerAdapter(id).provider,
					apiKey: `$${environmentName}`,
					oauth: {
						name: "OAuth Reload Provider",
						login: async () => ({ access: "access", refresh: "refresh", expires: 1 }),
						refreshToken: async (credential) => credential,
						getApiKey: (credential) => credential.access,
					},
				},
			}),
		});
		await factory(pi as unknown as ExtensionAPI);
		pi.providers.set(id, { ...pi.providers.get(id), apiKey: `$${environmentName}` });

		await pi.emit("session_start", { type: "session_start", reason: "reload" }, pi.context(id));

		assert.equal(pi.providers.get(id)?.apiKey, undefined);
		assert.equal(pi.providerCalls.filter((providerId) => providerId === id).length, 2);
	} finally {
		if (previous === undefined) delete process.env[environmentName];
		else process.env[environmentName] = previous;
	}
});

test("helpers isolate invalid static identity, returned identity, timing, shape, and factory errors", async () => {
	assert.throws(
		() => defineProviderExtension({ id: "invalid id", create: () => providerAdapter("invalid id") } as any),
		/static ID/,
	);

	const pi = new TestPi();
	const envelopes: unknown[] = [];
	pi.events.on(PI_PROVIDER_ADAPTER_EVENT, (value) => envelopes.push(value));
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
		assert.match(notifications.at(-1)?.message ?? "", /Account: fresh/);
		assert.match(notifications.at(-1)?.message ?? "", /Health: preflight passed · endpoint/);
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
	createPiProviderHost({ enableOfficialPricingFallback: false })(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "parallel-factory-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await pi.commands.get("status").handler("", context);

	assert.equal(maximumRunning, 3);
});

test("Host schedules one non-blocking model catalog refresh for startup and reload", async () => {
	const pi = new TestPi();
	createPiProviderHost({ enableOfficialPricingFallback: false })(pi as unknown as ExtensionAPI);
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

test("Host isolates malformed envelopes and resolves duplicate IDs to the latest registration", async () => {
	const pi = new TestPi();
	const host = createPiProviderHost({ enableOfficialPricingFallback: false });
	host(pi as unknown as ExtensionAPI);
	pi.events.emit(PI_PROVIDER_ADAPTER_EVENT, { version: 1, kind: "tuner", id: "broken", token: {}, adapter: null });

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
	assert.ok(pi.providers.has("preflight-provider"));
	assert.equal(pi.providers.get("conflict-provider")?.models[0]?.id, "two");
	assert.match(notifications.at(-1) ?? "", /Account: fresh/);

	const statusProviderContext = createContext(pi, "status-provider");
	const conflictNotifications: string[] = [];
	statusProviderContext.ui.notify = (message) => conflictNotifications.push(message);
	await command.handler("refresh", statusProviderContext);
	assert.match(conflictNotifications.at(-1) ?? "", /Account: fresh/);

	const preflightContext = createContext(pi, "preflight-provider");
	const preflightNotifications: string[] = [];
	preflightContext.ui.notify = (message) => preflightNotifications.push(message);
	await command.handler("refresh", preflightContext);
	assert.match(preflightNotifications.at(-1) ?? "", /Health: preflight passed/);

	const beforeRequest = pi.handlers.get("before_provider_request")?.[0];
	assert.ok(beforeRequest);
	const transformed = await beforeRequest({ payload: { order: [] } }, context);
	assert.deepEqual(transformed, { order: ["second", "good"] });
});

test("Host applies Pi catalog fallback when it registers an accepted Provider", async () => {
	const pi = new TestPi();
	const host = createPiProviderHost();
	host(pi as unknown as ExtensionAPI);
	const providerFactory = defineProviderExtension({
		id: "catalog-fallback-provider",
		create: () => ({
			id: "catalog-fallback-provider",
			provider: {
				name: "Catalog Fallback Provider",
				baseUrl: "https://fallback.invalid/v1",
				apiKey: "$FALLBACK_KEY",
				api: "openai-completions",
				models: [{ id: "deepseek-v4-flash" }],
			},
		}),
	});
	await providerFactory(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "catalog-fallback-provider", "deepseek-v4-flash");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await pi.commands.get("status").handler("", context);

	const registered = pi.providers.get("catalog-fallback-provider");
	assert.ok(registered);
	const model = registered.models[0];
	assert.ok(model);
	assert.equal(model.id, "deepseek-v4-flash");
	assert.ok(model.contextWindow >= 64_000);
	assert.ok(model.cost.input > 0);
});

test("Host uses the active Pi registry for transport-provider model metadata", async () => {
	const pi = new TestPi();
	const host = createPiProviderHost();
	host(pi as unknown as ExtensionAPI);
	const providerFactory = defineProviderExtension({
		id: "registry-fallback-provider",
		create: () => ({
			id: "registry-fallback-provider",
			provider: {
				name: "Registry Fallback Provider",
				baseUrl: "https://fallback.invalid/v1",
				apiKey: "$REGISTRY_FALLBACK_KEY",
				api: "openai-completions",
				models: [{ id: "gpt-6-astra" }],
			},
		}),
	});
	await providerFactory(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "registry-fallback-provider", "gpt-6-astra");
	(context.modelRegistry as any).getAll = () => [
		{
			id: "gpt-6-astra",
			provider: "openai",
			contextWindow: 272_000,
			maxTokens: 128_000,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		},
	];
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await pi.commands.get("status").handler("", context);

	const registered = pi.providers.get("registry-fallback-provider");
	assert.ok(registered);
	const model = registered.models[0];
	assert.equal(model.contextWindow, 272_000);
	assert.equal(model.maxTokens, 128_000);
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.cost.input, 10);
});

test("Host does not make network requests to OpenRouter on session_start", async () => {
	let requests = 0;
	const pi = new TestPi();
	createPiProviderHost({
		fetch: async (input) => {
			if (input.toString().includes("openrouter.ai")) {
				requests++;
			}
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		},
	})(pi as unknown as ExtensionAPI);

	const context = createContext(pi, "unused-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests, 0);
});

test("Host preserves a dynamically refreshed catalog", async () => {
	const pi = new TestPi();
	const host = createPiProviderHost();
	host(pi as unknown as ExtensionAPI);
	const providerFactory = defineProviderExtension({
		id: "host-dynamic-provider",
		create: () => ({
			id: "host-dynamic-provider",
			provider: {
				name: "Host Dynamic Provider",
				baseUrl: "https://provider.invalid/v1",
				apiKey: "$HOST_DYNAMIC_KEY",
				api: "openai-completions",
				models: [{ id: "initial-model" }],
				refreshModels: async () => [{ id: "dynamic-model" }],
			},
		}),
	});
	await providerFactory(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "host-dynamic-provider", "initial-model");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await pi.commands.get("status").handler("", context);

	const registered = pi.providers.get("host-dynamic-provider");
	assert.ok(registered);
	await registered.refreshModels({} as any);
	assert.equal(pi.providers.get("host-dynamic-provider")?.models[0]?.id, "dynamic-model");
});

test("Host can bind a Status Adapter to a native Pi provider", async () => {
	const pi = new TestPi();
	pi.nativeProviders.set("native-provider", { getModels: () => [{ id: "test-model" }] });
	const host = createPiProviderHost({ enableOfficialPricingFallback: false });
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
	assert.match(notifications.at(-1) ?? "", /Account: fresh/);
});

test("tuner ordering is deterministic for equal priorities", async () => {
	const pi = new TestPi();
	const host = createPiProviderHost({ enableOfficialPricingFallback: false });
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
	const firstHost = createPiProviderHost({ enableOfficialPricingFallback: false });
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
	const secondHost = createPiProviderHost({ enableOfficialPricingFallback: false });
	secondHost(secondPi as unknown as ExtensionAPI);
	const secondFactories = makeFactories(false);
	await secondFactories.provider(secondPi as unknown as ExtensionAPI);
	const secondContext = createContext(secondPi, "reload-provider");
	await secondPi.emit("session_start", { type: "session_start", reason: "reload" }, secondContext);
	const secondNotifications: string[] = [];
	secondContext.ui.notify = (message) => secondNotifications.push(message);
	await secondPi.commands.get("status").handler("", secondContext);
	assert.equal(statusCalls.count, 1);
	assert.match(secondNotifications.at(-1) ?? "", /Account: not supported/);

	const thirdPi = new TestPi();
	const thirdHost = createPiProviderHost({ enableOfficialPricingFallback: false });
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
	const host = createPiProviderHost({
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
	assert.equal(typeof PI_PROVIDER_STARTUP_BRIDGE_EVENT, "string");
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

	const host = createPiProviderHost({
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

	createPiProviderHost({
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

test("only the first Pi Provider Host installs runtime handlers", async () => {
	const pi = new TestPi();
	createPiProviderHost({ enableOfficialPricingFallback: false })(pi as unknown as ExtensionAPI);
	createPiProviderHost({ enableOfficialPricingFallback: false })(pi as unknown as ExtensionAPI);

	assert.equal(pi.handlers.get("before_provider_request")?.length, 1);
	assert.equal(pi.handlers.get("model_select")?.length, 1);
	assert.equal(pi.commands.has("status"), true);
});

test("Host does not install a registry after session shutdown cancels readiness", async () => {
	const pi = new TestPi();
	let factoryCalls = 0;
	const factory = defineProviderExtension({
		id: "shutdown-race-provider",
		create: async () => {
			factoryCalls++;
			if (factoryCalls > 1) await new Promise((resolve) => setTimeout(resolve, 20));
			return providerAdapter("shutdown-race-provider");
		},
	});
	await factory(pi as unknown as ExtensionAPI);
	createPiProviderHost({ enableOfficialPricingFallback: false })(pi as unknown as ExtensionAPI);
	const context = createContext(pi, "shutdown-race-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	const pending = pi.commands.get("status").handler("check", context);
	await new Promise((resolve) => setImmediate(resolve));
	await pi.emit("session_shutdown", { type: "session_shutdown", reason: "test" }, context);
	await pending;

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

test("Host rehydration of dynamic adapter preserves models on subsequent cache-only refresh", async () => {
	const pi = new TestPi();
	const factory = defineProviderExtension({
		id: "dynamic-rehydrate-provider",
		create: () => {
			let provider: any;
			const lifecycle = createModelCatalogLifecycle({
				ttlMs: 60_000,
				discover: () => [{ id: "model-alpha" }, { id: "model-beta" }],
				restore: () => undefined,
				persist: (models, checkedAt) => ({ models: models as any, checkedAt }),
				onUpdate: (models) => {
					if (provider) provider.models = models;
				},
				errorCode: () => "error",
			});
			provider = {
				name: "Dynamic Rehydrate Provider",
				baseUrl: "https://api.example.com/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: lifecycle.getModels(),
				refreshModels: lifecycle.refreshModels,
			};
			return {
				id: "dynamic-rehydrate-provider",
				provider,
				catalog: lifecycle.catalog,
				lifecycle,
			};
		},
	});

	await factory(pi as unknown as ExtensionAPI);
	const host = createPiProviderHost({ enableOfficialPricingFallback: false });
	host(pi as unknown as ExtensionAPI);

	const context = createContext(pi, "dynamic-rehydrate-provider");
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
	await pi.commands.get("status").handler("check", context);

	const registered = pi.providers.get("dynamic-rehydrate-provider");
	assert.ok(registered);

	// Perform initial dynamic refresh
	const refreshed = await registered.refreshModels({
		allowNetwork: true,
		force: true,
		signal: new AbortController().signal,
		publish: async ({ update }: any) => {
			update?.();
			return true;
		},
	});
	assert.deepEqual(
		refreshed.map((m: any) => m.id),
		["model-alpha", "model-beta"],
	);

	// Rebuild the adapter via session_start
	await pi.emit("session_start", { type: "session_start", reason: "reload" }, context);
	await pi.commands.get("status").handler("check", context);

	const rebuilt = pi.providers.get("dynamic-rehydrate-provider");
	assert.ok(rebuilt);
	assert.deepEqual(
		rebuilt.models.map((m: any) => m.id),
		["model-alpha", "model-beta"],
	);

	// Cache-only refresh should NOT wipe out models
	const cacheRefreshed = await rebuilt.refreshModels({
		allowNetwork: false,
		force: false,
		signal: new AbortController().signal,
		publish: async ({ update }: any) => {
			update?.();
			return true;
		},
	});
	assert.deepEqual(
		cacheRefreshed.map((m: any) => m.id),
		["model-alpha", "model-beta"],
	);
	assert.deepEqual(
		rebuilt.models.map((m: any) => m.id),
		["model-alpha", "model-beta"],
	);
});
