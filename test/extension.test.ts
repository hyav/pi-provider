import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PiProviderDefinition, PiProviderDependencies } from "../core/extension.ts";
import { createPiProviderRuntime } from "../core/extension.ts";
import { clearPricingCache, OPENROUTER_MODELS_URL } from "../core/official-pricing.ts";
import { StatusManager } from "../core/status-manager.ts";
import type { ProviderAdapter, StatusSnapshot } from "../core/types.ts";
import * as indexExports from "../index.ts";
import { createOpenAICodexPreflightAdapter } from "../preflight/openai-codex.ts";
import { createCharmHyperAdapter } from "../providers/charm-hyper.ts";
import { createCharmHyperStatusAdapter } from "../status/charm-hyper.ts";
import { createOpenAICodexStatusAdapter } from "../status/openai-codex.ts";

function createTestRuntime(dependencies: Partial<PiProviderDependencies> = {}) {
	return createPiProviderRuntime(
		async (runtime) => ({
			providers: [await createCharmHyperAdapter(runtime.fetch, runtime.modelDiscoveryTimeoutMs, runtime.now)],
			statuses: [
				createCharmHyperStatusAdapter(runtime.statusRequestTimeoutMs),
				createOpenAICodexStatusAdapter(runtime.statusRequestTimeoutMs),
			],
			preflights: [createOpenAICodexPreflightAdapter(runtime.statusRequestTimeoutMs)],
			tuners: [],
		}),
		dependencies,
	);
}

const emptyHyperResponse = () =>
	new Response(JSON.stringify({ models: [] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

function providerDefinition(
	providerId: string,
	statusFetch?: (context: any) => Promise<any>,
	requestTimeoutMs = 1_000,
): PiProviderDefinition {
	return {
		providers: [
			{
				id: providerId,
				provider: {
					name: "Test Provider",
					baseUrl: "https://example.com/v1",
					apiKey: "$TEST_API_KEY",
					api: "openai-completions",
					models: [{ id: "model" }],
				},
			},
		],
		statuses: statusFetch
			? [
					{
						id: `${providerId}-status`,
						providerId,
						name: "Test Provider",
						cacheTtlMs: 30_000,
						requestTimeoutMs,
						fetch: statusFetch,
					},
				]
			: [],
	};
}

function createPi(commands: Record<string, any>, registrations: string[] = []) {
	return {
		registerProvider(id: string) {
			registrations.push(id);
		},
		on() {},
		registerCommand(name: string, command: any) {
			commands[name] = command;
		},
	};
}

function authContext(provider: string) {
	return {
		model: { provider, id: "model" },
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured: true, source: "test" }),
			getApiKeyForProvider: async () => "test-key",
		},
		ui: { notify: (_message: string) => {} },
	};
}

test("exports core Pi Provider host and runtime APIs without legacy aliases", () => {
	const publicApi = indexExports as unknown as Record<string, unknown>;
	assert.equal(typeof publicApi.createPiProviderHost, "function");
	assert.equal(typeof publicApi.createPiProviderRuntime, "function");
	const legacyInfix = ["Provider", "Kit"].join("");
	assert.equal(publicApi[`create${legacyInfix}Host`], undefined);
	assert.equal(publicApi[`create${legacyInfix}Runtime`], undefined);
	assert.equal(typeof indexExports.defineProviderExtension, "function");
	assert.equal(typeof indexExports.defineStatusExtension, "function");
	assert.equal(typeof indexExports.definePreflightExtension, "function");
	assert.equal(typeof indexExports.defineTunerExtension, "function");
	assert.equal(typeof indexExports.StatusManager, "function");
	assert.equal(typeof indexExports.PreflightManager, "function");
	assert.equal(typeof indexExports.LiveCheckManager, "function");
	assert.equal(typeof indexExports.applyPricingAdjustment, "function");
	assert.equal(typeof indexExports.resolvePricingDetails, "function");
	assert.equal(typeof indexExports.ProviderDataError, "function");
});

test("rejects invalid Pi Provider runtime dependencies early", () => {
	assert.throws(
		() =>
			createPiProviderRuntime(async () => providerDefinition("invalid-runtime"), { liveCheckRequestTimeoutMs: 0 }),
		/valid timeout/,
	);
});

test("the runtime registers configured providers and exposes /status only", async () => {
	const registrations: string[] = [];
	const commands: Record<string, any> = {};
	await createTestRuntime({ enableOfficialPricingFallback: false, fetch: async () => emptyHyperResponse() })(
		createPi(commands, registrations) as any,
	);

	assert.deepEqual(registrations, ["charm-hyper"]);
	assert.equal(typeof commands.status, "object");
	assert.equal(commands["provider-status"], undefined);
});

test("schedules one non-blocking model catalog refresh for an explicit runtime", async () => {
	const handlers: Record<string, (...args: any[]) => unknown> = {};
	let refreshCalls = 0;
	const extension = createPiProviderRuntime(async () => providerDefinition("catalog-runtime"), {
		enableOfficialPricingFallback: false,
	});
	await extension({
		registerProvider() {},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers[event] = handler;
		},
		registerCommand() {},
	} as any);
	const context = { modelRegistry: { refresh: async () => refreshCalls++ } };

	assert.equal(handlers.session_start?.({ reason: "startup" }, context), undefined);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(refreshCalls, 1);
	await handlers.session_start?.({ reason: "new" }, context);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(refreshCalls, 1);
	await handlers.session_start?.({ reason: "reload" }, context);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(refreshCalls, 2);
});

test("reapplies background official metadata after startup registration", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "pi-provider-background-runtime-"));
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
						id: "reference/background-model",
						pricing: { prompt: "0.000001", completion: "0.000002" },
						benchmarks: {
							artificial_analysis: { intelligence_index: 48.5 },
						},
					},
				],
			}),
			{ status: 200 },
		);
	}) as typeof globalThis.fetch;
	let adapter: ProviderAdapter | undefined;
	const extension = createPiProviderRuntime(
		async () => {
			adapter = {
				id: "background-provider",
				provider: {
					name: "Background Provider",
					baseUrl: "https://example.com/v1",
					apiKey: "$BACKGROUND_PROVIDER_KEY",
					api: "openai-completions",
					models: [{ id: "background-model" }],
				},
			};
			return { providers: [adapter] };
		},
		{
			fetch: fetchFn,
			officialPricingCacheTtlMs: 0,
			openRouterMetadataCachePath: join(cacheRoot, "metadata.json"),
		},
	);
	const registrations: Array<{ id: string; config: any }> = [];
	try {
		await extension({
			registerProvider(id: string, config: any) {
				registrations.push({ id, config });
			},
			on() {},
			registerCommand() {},
		} as any);

		assert.deepEqual(registrations[0]?.config.models?.[0]?.cost, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		await fetchStarted;
		release?.();

		await new Promise<void>((resolve, reject) => {
			let stopped = false;
			const timer = setTimeout(() => {
				stopped = true;
				reject(new Error("background metadata refresh did not re-register the Provider"));
			}, 1_000);
			const poll = () => {
				if (stopped) return;
				if (registrations.length >= 2) {
					stopped = true;
					clearTimeout(timer);
					resolve();
					return;
				}
				setImmediate(poll);
			};
			poll();
		});

		assert.deepEqual(registrations.at(-1)?.config.models?.[0]?.cost, {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
		});
		assert.equal(adapter?.registration?.modelMetadata?.["background-model"]?.pricing.source, "official");
		assert.equal(adapter?.registration?.modelMetadata?.["background-model"]?.quality?.[0]?.category, "intelligence");
	} finally {
		clearPricingCache(OPENROUTER_MODELS_URL);
		await rm(cacheRoot, { recursive: true, force: true });
	}
});

test("offers filtered status mode completions with descriptions", async () => {
	const commands: Record<string, any> = {};
	await createPiProviderRuntime(async () => providerDefinition("completion-provider"), {
		enableOfficialPricingFallback: false,
	})(createPi(commands) as any);

	const completions = commands.status.getArgumentCompletions("");
	assert.deepEqual(
		completions.map(({ value, label, description }: any) => ({ value, label, description })),
		[
			{
				value: "refresh",
				label: "refresh",
				description: "Refresh account status and free access checks; no model generation",
			},
			{
				value: "check",
				label: "check",
				description: "Refresh free checks and run one live model check; may incur usage",
			},
		],
	);
	assert.deepEqual(
		commands.status.getArgumentCompletions("che").map(({ value }: any) => value),
		["check"],
	);
	assert.equal(commands.status.getArgumentCompletions("ver"), null);
	assert.equal(commands.status.getArgumentCompletions("pro"), null);
});

test("wires request tuners into before_provider_request when provided", async () => {
	let beforeRequest: ((event: any, context: any) => unknown) | undefined;
	const customTuner = {
		id: "mock-tuner",
		priority: 10,
		matches: () => true,
		transform: (payload: any) => ({ ...payload, customHeader: "active" }),
	};
	await createPiProviderRuntime(
		async () => ({
			providers: [],
			preflights: [],
			statuses: [],
			tuners: [customTuner],
		}),
		{ enableOfficialPricingFallback: false, fetch: async () => emptyHyperResponse() },
	)({
		registerProvider() {},
		on(event: string, handler: (...args: any[]) => unknown) {
			if (event === "before_provider_request") beforeRequest = handler;
		},
		registerCommand() {},
	} as any);
	const payload = { model: "test-model", messages: [{ role: "user", content: "hello" }] };
	const transformed = await beforeRequest?.(
		{ payload },
		{
			model: {
				id: "test-model",
				provider: "test-provider",
			},
		},
	);
	assert.deepEqual((transformed as any).customHeader, "active");
});

test("normalizes incomplete provider models before registration", async () => {
	const registrations: Array<{ id: string; config: any }> = [];
	const extension = createPiProviderRuntime(
		async () => ({
			providers: [
				{
					id: "draft-provider",
					provider: {
						name: "Draft Provider",
						baseUrl: "https://example.com/v1",
						apiKey: "$DRAFT_API_KEY",
						api: "openai-completions",
						models: [{ id: "draft-model" }],
					},
				},
			],
		}),
		{ enableOfficialPricingFallback: false },
	);
	await extension({
		registerProvider(id: string, config: any) {
			registrations.push({ id, config });
		},
		on() {},
		registerCommand() {},
	} as any);

	assert.deepEqual(registrations[0]?.config.models, [
		{
			id: "draft-model",
			name: "draft-model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		},
	]);
});

test("reports invalid status snapshots as badjson", async () => {
	const commands: Record<string, any> = {};
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("invalid-status", async () => ({
				entries: [{ kind: "window", id: "window", label: "5h", remainingPercent: Number.NaN }],
				updatedAt: Date.now(),
			})),
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = authContext("invalid-status");
	ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });
	await commands.status.handler("refresh", ctx);

	assert.match(notifications.at(-1)?.message ?? "", /Error: badjson/);
	assert.equal(notifications.at(-1)?.level, "warning");
});

test("rejects invalid status timeout settings while loading", async () => {
	for (const requestTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2_147_483_648]) {
		const extension = createPiProviderRuntime(
			async () =>
				providerDefinition(
					"invalid-timeout",
					async () => ({ entries: [], updatedAt: Date.now() }),
					requestTimeoutMs,
				),
			{ enableOfficialPricingFallback: false },
		);
		await assert.rejects(extension(createPi({}) as any), /invalid timing settings/);
	}
});

test("keeps default status cache-only and refreshes it explicitly", async () => {
	const commands: Record<string, any> = {};
	let requests = 0;
	let now = 1_000;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("cached-status", async (context) => ({
				entries: [{ kind: "amount", id: "balance", label: "Balance", value: ++requests, unit: "credits" }],
				updatedAt: context.now(),
			})),
		{ enableOfficialPricingFallback: false, now: () => now },
	);
	await extension(createPi(commands) as any);
	const ctx = authContext("cached-status");

	await commands.status.handler("", ctx);
	assert.equal(requests, 0);

	await commands.status.handler("refresh", ctx);
	assert.equal(requests, 1);

	await commands.status.handler("", ctx);
	assert.equal(requests, 1);

	now += 31_000;
	await commands.status.handler("", ctx);
	assert.equal(requests, 1);

	await commands.status.handler("refresh", ctx);
	assert.equal(requests, 2);
});

test("distinguishes live and cached status reports with compact sections", async () => {
	const commands: Record<string, any> = {};
	let requests = 0;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("status-presentation", async (context) => ({
				entries: [{ kind: "amount", id: "balance", label: "Balance", value: ++requests, unit: "USD" }],
				updatedAt: context.now(),
			})),
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);

	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = authContext("status-presentation");
	ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });

	await commands.status.handler("refresh", ctx);
	assert.equal(requests, 1);
	assert.match(notifications.at(-1)?.message ?? "", /Provider: status-presentation\nModel: model/);
	assert.doesNotMatch(notifications.at(-1)?.message ?? "", /Live check scope:/);
	assert.doesNotMatch(notifications.at(-1)?.message ?? "", /^(↻|◌|✓)/);
	assert.doesNotMatch(notifications.at(-1)?.message ?? "", /\[(accent|dim)\]/);

	await commands.status.handler("", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /Account:\n {2}Status: fresh/);
	assert.doesNotMatch(notifications.at(-1)?.message ?? "", /^(↻|◌|✓)/);
});

test("renders command status in a transient widget and clears it on input", async () => {
	const commands: Record<string, any> = {};
	const handlers: Record<string, (...args: any[]) => unknown> = {};
	const widgetUpdates: Array<{ key: string; content: unknown; options: unknown }> = [];
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("transient-status", async (context) => ({
				entries: [{ kind: "amount", id: "balance", label: "Balance", value: 75, unit: "credits" }],
				updatedAt: context.now(),
			})),
		{ enableOfficialPricingFallback: false },
	);
	await extension({
		registerProvider() {},
		registerCommand(name: string, command: any) {
			commands[name] = command;
		},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers[event] = handler;
		},
	} as any);

	const notifications: Array<{ message: string; level?: string }> = [];
	const themeCalls: Array<{ color: string; text: string }> = [];
	const ctx: any = authContext("transient-status");
	ctx.model.id = "模型模型模型模型模型模型";
	ctx.mode = "tui";
	ctx.ui.theme = {
		fg: (color: string, text: string) => {
			themeCalls.push({ color, text });
			return `[${color}]${text}[/${color}]`;
		},
	};
	ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });
	ctx.ui.setWidget = (key: string, content: unknown, options: unknown) => {
		widgetUpdates.push({ key, content, options });
	};

	await commands.status.handler("", ctx);

	assert.equal(notifications.length, 0);
	assert.equal(widgetUpdates.length, 1);
	assert.equal(widgetUpdates[0]?.key, "pi-provider-status");
	assert.equal(typeof widgetUpdates[0]?.content, "function");
	const widgetFactory = widgetUpdates[0]?.content as (
		tui: unknown,
		theme: typeof ctx.ui.theme,
	) => { render(width: number): string[]; invalidate(): void };
	const widget = widgetFactory({}, ctx.ui.theme);
	const widgetMessage = widget.render(200).join("\n");
	assert.match(widgetMessage, /^ \[dim\]Provider: transient-status/);
	assert.doesNotMatch(widgetMessage, /^(↻|◌|✓)/);
	assert.equal(themeCalls[0]?.color, "dim");
	assert.equal(themeCalls[0]?.text.startsWith("Provider: transient-status"), true);
	assert.equal(widget.render(200).at(-1), "");

	const widthCheckedWidget = widgetFactory(
		{},
		{
			fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[22m`,
		},
	);
	for (const line of widthCheckedWidget.render(12)) {
		assert.ok(visibleWidth(line) <= 12, `widget line exceeds its render width: ${JSON.stringify(line)}`);
	}

	await handlers.input?.({ type: "input", text: "next message", source: "interactive" }, ctx);

	assert.equal(widgetUpdates.at(-1)?.key, "pi-provider-status");
	assert.equal(widgetUpdates.at(-1)?.content, undefined);
});

test("runs account status and preflight checks concurrently", async () => {
	const commands: Record<string, any> = {};
	const started = new Set<string>();
	let resolveStatus: ((snapshot: unknown) => void) | undefined;
	let resolvePreflight: ((snapshot: unknown) => void) | undefined;
	const extension = createPiProviderRuntime(
		async () =>
			({
				providers: [
					{
						id: "parallel-checks",
						provider: {
							name: "Parallel Checks",
							baseUrl: "https://example.com/v1",
							apiKey: "$TEST_API_KEY",
							api: "openai-completions",
							models: [{ id: "model" }],
						},
					},
				],
				statuses: [
					{
						id: "parallel-status",
						providerId: "parallel-checks",
						name: "Parallel Checks",
						cacheTtlMs: 0,
						requestTimeoutMs: 1_000,
						fetch: async () => {
							started.add("status");
							return await new Promise((resolve) => {
								resolveStatus = resolve;
							});
						},
					},
				],
				preflights: [
					{
						id: "parallel-preflight",
						providerId: "parallel-checks",
						name: "Parallel Checks",
						cacheTtlMs: 0,
						requestTimeoutMs: 1_000,
						fetch: async () => {
							started.add("preflight");
							return await new Promise((resolve) => {
								resolvePreflight = resolve;
							});
						},
					},
				],
			}) as any,
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);

	const request = commands.status.handler("refresh", authContext("parallel-checks"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual([...started].sort(), ["preflight", "status"]);

	resolveStatus?.({ entries: [], updatedAt: Date.now() });
	resolvePreflight?.({ passed: true, checks: [], updatedAt: Date.now() });
	await request;
});

test("runs account status, free preflight, and live check concurrently", async () => {
	const commands: Record<string, any> = {};
	const started = new Set<string>();
	let resolveStatus: ((snapshot: unknown) => void) | undefined;
	let resolvePreflight: ((snapshot: unknown) => void) | undefined;
	const extension = createPiProviderRuntime(
		async () =>
			({
				providers: [
					{
						id: "parallel-live-check",
						provider: {
							name: "Parallel Live Check",
							baseUrl: "https://example.com/v1",
							apiKey: "$TEST_API_KEY",
							api: "openai-completions",
							models: [{ id: "model" }],
						},
					},
				],
				statuses: [
					{
						id: "parallel-live-status",
						providerId: "parallel-live-check",
						name: "Parallel Live Check",
						cacheTtlMs: 0,
						requestTimeoutMs: 1_000,
						fetch: async () => {
							started.add("status");
							return await new Promise((resolve) => {
								resolveStatus = resolve;
							});
						},
					},
				],
				preflights: [
					{
						id: "parallel-live-preflight",
						providerId: "parallel-live-check",
						name: "Parallel Live Check",
						cacheTtlMs: 0,
						requestTimeoutMs: 1_000,
						fetch: async () => {
							started.add("preflight");
							return await new Promise((resolve) => {
								resolvePreflight = resolve;
							});
						},
					},
				],
			}) as any,
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);

	const ctx: any = authContext("parallel-live-check");
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });
	ctx.modelRegistry.getProvider = () => {
		started.add("live");
		return {
			streamSimple() {
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done", reason: "stop", message: {} };
					},
				};
			},
		};
	};

	const request = commands.status.handler("check", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual([...started].sort(), ["live", "preflight", "status"]);

	resolveStatus?.({ entries: [], updatedAt: Date.now() });
	resolvePreflight?.({ passed: true, checks: [], updatedAt: Date.now() });
	await request;
});

test("runs the live check with a fresh account status on /status check", async () => {
	const commands: Record<string, any> = {};
	let statusRequests = 0;
	let liveCheckRequests = 0;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("check-command", async () => {
				statusRequests++;
				return { entries: [], updatedAt: Date.now() };
			}),
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);

	const ctx: any = authContext("check-command");
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });
	ctx.modelRegistry.getProvider = () => ({
		streamSimple() {
			liveCheckRequests++;
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", reason: "stop", message: {} };
				},
			};
		},
	});

	await commands.status.handler("check", ctx);

	assert.equal(statusRequests, 1);
	assert.equal(liveCheckRequests, 1);
});

test("runs one minimal live check for the active provider and model on check", async () => {
	const commands: Record<string, any> = {};
	const liveCheckRequests: Array<{ model: any; context: any; options: any }> = [];
	const extension = createPiProviderRuntime(async () => providerDefinition("check-provider"), {
		enableOfficialPricingFallback: false,
		now: () => 1_000,
	});
	await extension(createPi(commands) as any);

	const notifications: string[] = [];
	const ctx: any = authContext("check-provider");
	ctx.mode = "tui";
	ctx.ui.theme = {
		fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
	};
	ctx.ui.notify = (message: string) => notifications.push(message);
	ctx.model = {
		provider: "check-provider",
		id: "model",
		api: "openai-completions",
		baseUrl: "https://example.com/v1",
	};
	ctx.modelRegistry.getApiKeyAndHeaders = async (model: any) => {
		assert.equal(model, ctx.model);
		return { ok: true, apiKey: "test-key", headers: { "x-test": "check" } };
	};
	ctx.modelRegistry.getProvider = (provider: string) => {
		assert.equal(provider, "check-provider");
		return {
			streamSimple(model: any, context: any, options: any) {
				liveCheckRequests.push({ model, context, options });
				options.onResponse?.({ status: 200, headers: {} }, model);
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "OK" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done", reason: "stop", message };
					},
					result: async () => message,
				};
			},
		};
	};

	await commands.status.handler("check", ctx);

	assert.equal(liveCheckRequests.length, 1);
	assert.equal(liveCheckRequests[0]?.model, ctx.model);
	assert.equal(liveCheckRequests[0]?.context.systemPrompt, "");
	assert.equal(liveCheckRequests[0]?.context.tools, undefined);
	assert.equal(liveCheckRequests[0]?.context.messages.length, 1);
	assert.equal(typeof liveCheckRequests[0]?.context.messages[0]?.content, "string");
	assert.equal(liveCheckRequests[0]?.options.reasoning, undefined);
	assert.equal(liveCheckRequests[0]?.options.apiKey, "test-key");
	assert.deepEqual(liveCheckRequests[0]?.options.headers, { "x-test": "check" });
	assert.ok(liveCheckRequests[0]?.options.signal instanceof AbortSignal);
	assert.match(notifications.at(-1) ?? "", /^Provider: check-provider\n/);
	assert.doesNotMatch(notifications.at(-1) ?? "", /\[(accent|dim)\]/);
	assert.match(notifications.at(-1) ?? "", /Availability: verified/);
	assert.match(notifications.at(-1) ?? "", /Live check: success · HTTP 200 OK · \d+ms/);
	assert.match(
		notifications.at(-1) ?? "",
		/Live check scope: streamSimple\(\) · Pi Provider tuners only \(other hooks not replayed\)/,
	);
	assert.doesNotMatch(notifications.at(-1) ?? "", /Live check: model ·/);

	await commands.status.handler("check", ctx);
	assert.equal(liveCheckRequests.length, 2);
	assert.match(notifications.at(-1) ?? "", /^Provider: check-provider\n/);
	assert.doesNotMatch(notifications.at(-1) ?? "", /\[(accent|dim)\]/);
	assert.match(notifications.at(-1) ?? "", /Availability: verified/);
	assert.match(notifications.at(-1) ?? "", /Live check: success · HTTP 200 OK · \d+ms/);
});

test("passes the runtime fetch implementation to a live check", async () => {
	const commands: Record<string, any> = {};
	const runtimeFetch = (async () => new Response("unused")) as typeof globalThis.fetch;
	let receivedFetch: typeof globalThis.fetch | undefined;
	const extension = createPiProviderRuntime(async () => providerDefinition("check-fetch"), {
		enableOfficialPricingFallback: false,
		fetch: runtimeFetch,
	});
	await extension(createPi(commands) as any);

	const ctx: any = authContext("check-fetch");
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });
	ctx.modelRegistry.getProvider = () => ({
		streamSimple(_model: any, _context: any, options: any) {
			receivedFetch = options.fetch;
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", reason: "stop", message: {} };
				},
			};
		},
	});

	await commands.status.handler("check", ctx);
	assert.equal(receivedFetch, runtimeFetch);
});

test("does not start a provider stream after live check authentication times out", async () => {
	const commands: Record<string, any> = {};
	let resolveAuth: ((result: unknown) => void) | undefined;
	let streamCalls = 0;
	const auth = new Promise((resolve) => {
		resolveAuth = resolve;
	});
	const extension = createPiProviderRuntime(async () => providerDefinition("late-check-auth"), {
		enableOfficialPricingFallback: false,
		liveCheckRequestTimeoutMs: 5,
	});
	await extension(createPi(commands) as any);

	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx: any = authContext("late-check-auth");
	ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });
	ctx.modelRegistry.getApiKeyAndHeaders = async () => await auth;
	ctx.modelRegistry.getProvider = () => ({
		streamSimple() {
			streamCalls++;
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", reason: "stop", message: {} };
				},
			};
		},
	});

	await commands.status.handler("check", ctx);

	resolveAuth?.({ ok: true, apiKey: "test-key" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(streamCalls, 0);
});

test("refreshes free preflight without running a paid live check", async () => {
	const commands: Record<string, any> = {};
	let preflightRequests = 0;
	let liveCheckRequests = 0;
	let now = 1_000;
	const extension = createPiProviderRuntime(
		async () =>
			({
				providers: [
					{
						id: "preflight-provider",
						provider: {
							name: "Preflight Provider",
							baseUrl: "https://example.com/v1",
							apiKey: "$TEST_API_KEY",
							api: "openai-completions",
							models: [{ id: "model" }],
						},
					},
				],
				preflights: [
					{
						id: "preflight-provider-check",
						providerId: "preflight-provider",
						name: "Preflight Provider",
						cacheTtlMs: 30_000,
						requestTimeoutMs: 1_000,
						fetch: async (context: any) => {
							preflightRequests++;
							assert.equal(context.model.provider, "preflight-provider");
							return {
								passed: true,
								checks: ["endpoint", "auth", "catalog"],
								updatedAt: context.now(),
							};
						},
					},
				],
			}) as any,
		{ enableOfficialPricingFallback: false, now: () => now },
	);
	await extension(createPi(commands) as any);

	const notifications: string[] = [];
	const ctx: any = authContext("preflight-provider");
	ctx.ui.notify = (message: string) => notifications.push(message);
	ctx.modelRegistry.getProvider = () => ({
		streamSimple() {
			liveCheckRequests++;
			throw new Error("paid live check should not run");
		},
	});
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });

	await commands.status.handler("", ctx);
	await commands.status.handler("", ctx);
	assert.equal(preflightRequests, 0);

	now += 31_000;
	await commands.status.handler("", ctx);
	assert.equal(preflightRequests, 0);

	await commands.status.handler("refresh", ctx);
	assert.equal(preflightRequests, 1);
	assert.equal(liveCheckRequests, 0);
	assert.match(notifications.at(-1) ?? "", /Preflight: passed · endpoint\/auth\/catalog/);
});

test("keeps preflight caches separate for each active model", async () => {
	const commands: Record<string, any> = {};
	let requests = 0;
	const extension = createPiProviderRuntime(
		async () =>
			({
				providers: [
					{
						id: "model-isolated-preflight",
						provider: {
							name: "Model Isolated Preflight",
							baseUrl: "https://example.com/v1",
							apiKey: "$TEST_API_KEY",
							api: "openai-completions",
							models: [{ id: "model" }],
						},
					},
				],
				preflights: [
					{
						id: "model-isolated-preflight-check",
						providerId: "model-isolated-preflight",
						name: "Model Isolated Preflight",
						cacheTtlMs: 30_000,
						requestTimeoutMs: 1_000,
						fetch: async (context: any) => {
							requests++;
							return {
								passed: context.model.id === "sol",
								checks: ["catalog"],
								updatedAt: context.now(),
							};
						},
					},
				],
			}) as any,
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);

	const notifications: string[] = [];
	const ctx: any = authContext("model-isolated-preflight");
	ctx.ui.notify = (message: string) => notifications.push(message);
	ctx.model = { ...ctx.model, id: "sol" };
	await commands.status.handler("refresh", ctx);
	ctx.model = { ...ctx.model, id: "luna" };
	await commands.status.handler("refresh", ctx);

	assert.equal(requests, 2);
	assert.match(notifications.at(-1) ?? "", /Preflight: failed · catalog/);
});

test("keeps the last successful live check when a later live check fails", async () => {
	const commands: Record<string, any> = {};
	let attempts = 0;
	const extension = createPiProviderRuntime(async () => providerDefinition("stale-check"), {
		enableOfficialPricingFallback: false,
	});
	await extension(createPi(commands) as any);

	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx: any = authContext("stale-check");
	ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });
	ctx.modelRegistry.getProvider = () => ({
		streamSimple(_model: any, _context: any, options: any) {
			attempts++;
			options.onResponse?.({ status: attempts === 1 ? 200 : 502, headers: {} }, _model);
			if (attempts === 1) {
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done", reason: "stop", message: {} };
					},
				};
			}
			return {
				async *[Symbol.asyncIterator]() {
					yield {
						type: "error",
						reason: "error",
						error: { errorMessage: "bad gateway" },
					};
				},
			};
		},
	});

	await commands.status.handler("check", ctx);
	await commands.status.handler("check", ctx);

	assert.equal(attempts, 2);
	assert.match(notifications.at(-1)?.message ?? "", /Availability: stale/);
	assert.match(notifications.at(-1)?.message ?? "", /Live check: last success · HTTP 200 OK · \d+ms/);
	assert.match(notifications.at(-1)?.message ?? "", /Live check error: upstream/);
	assert.equal(notifications.at(-1)?.level, "warning");

	await commands.status.handler("", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /Availability: stale/);
	assert.equal(notifications.at(-1)?.level, "info");
});

test("respects Retry-After after a rate-limited live check", async () => {
	const commands: Record<string, any> = {};
	let attempts = 0;
	let now = 1_000;
	const extension = createPiProviderRuntime(async () => providerDefinition("retry-check"), {
		enableOfficialPricingFallback: false,
		now: () => now,
	});
	await extension(createPi(commands) as any);

	const ctx: any = authContext("retry-check");
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });
	ctx.modelRegistry.getProvider = () => ({
		streamSimple(_model: any, _context: any, options: any) {
			attempts++;
			options.onResponse?.(
				{
					status: attempts === 1 ? 429 : 200,
					headers: attempts === 1 ? { "retry-after": "10" } : {},
				},
				_model,
			);
			if (attempts === 1) {
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "error", reason: "error", error: { errorMessage: "rate limited" } };
					},
				};
			}
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", reason: "stop", message: {} };
				},
			};
		},
	});

	await commands.status.handler("check", ctx);
	now += 9_000;
	await commands.status.handler("check", ctx);
	assert.equal(attempts, 1);

	now += 2_000;
	await commands.status.handler("check", ctx);
	assert.equal(attempts, 2);
});

test("keeps live check caches separate for each active model", async () => {
	const commands: Record<string, any> = {};
	const checkedModels: string[] = [];
	const extension = createPiProviderRuntime(async () => providerDefinition("model-isolated-check"), {
		enableOfficialPricingFallback: false,
	});
	await extension(createPi(commands) as any);

	const notifications: string[] = [];
	const ctx: any = authContext("model-isolated-check");
	ctx.ui.notify = (message: string) => notifications.push(message);
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });
	ctx.modelRegistry.getProvider = () => ({
		streamSimple(model: any, _context: any, options: any) {
			checkedModels.push(model.id);
			options.onResponse?.({ status: 200, headers: {} }, model);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", reason: "stop", message: {} };
				},
			};
		},
	});

	ctx.model = { ...ctx.model, id: "sol" };
	await commands.status.handler("check", ctx);
	ctx.model = { ...ctx.model, id: "luna" };
	await commands.status.handler("check", ctx);
	assert.deepEqual(checkedModels, ["sol", "luna"]);

	ctx.model = { ...ctx.model, id: "sol" };
	await commands.status.handler("check", ctx);
	assert.deepEqual(checkedModels, ["sol", "luna", "sol"]);
	assert.match(notifications.at(-1) ?? "", /Live check: success · HTTP 200 OK · \d+ms/);
});

test("keeps transient status failures informational when repeated", async () => {
	const commands: Record<string, any> = {};
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("manual-warning", async () => {
				throw new Error("temporary network failure");
			}),
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);

	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = authContext("manual-warning");
	ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });

	await commands.status.handler("refresh", ctx);
	await commands.status.handler("refresh", ctx);

	assert.equal(notifications.length, 2);
	assert.deepEqual(
		notifications.map(({ level }) => level),
		["info", "info"],
	);
});

test("reports a live check timeout without hanging the check command", async () => {
	const commands: Record<string, any> = {};
	const extension = createPiProviderRuntime(async () => providerDefinition("timeout-check"), {
		enableOfficialPricingFallback: false,
		liveCheckRequestTimeoutMs: 5,
	});
	await extension(createPi(commands) as any);

	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx: any = authContext("timeout-check");
	ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });
	ctx.modelRegistry.getProvider = () => ({
		streamSimple() {
			return (async function* () {
				await new Promise(() => {});
			})();
		},
	});

	const deadline = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("check command did not meet its deadline")), 100);
	});
	await Promise.race([commands.status.handler("check", ctx), deadline]);

	assert.match(notifications.at(-1)?.message ?? "", /Availability: failed/);
	assert.match(notifications.at(-1)?.message ?? "", /Live check error: timeout/);
	assert.equal(notifications.at(-1)?.level, "warning");
});

test("rejects flag-style status modes without requesting status", async () => {
	const commands: Record<string, any> = {};
	let requests = 0;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("invalid-status-mode", async () => {
				requests++;
				return { entries: [], updatedAt: Date.now() };
			}),
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = authContext("invalid-status-mode");
	ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });

	await commands.status.handler("--refresh", ctx);

	assert.equal(requests, 0);
	assert.match(notifications.at(-1)?.message ?? "", /Usage: \/status \[refresh\|check\]/);
	assert.equal(notifications.at(-1)?.level, "warning");
});

test("returns after a status timeout when the adapter ignores cancellation", async () => {
	const manager = new StatusManager(
		[
			{
				id: "timeout-status",
				providerId: "timeout-provider",
				name: "Timeout Provider",
				cacheTtlMs: 30_000,
				requestTimeoutMs: 5,
				fetch: async () => await new Promise(() => {}),
			},
		],
		(async () => new Response("unused")) as typeof globalThis.fetch,
		() => 1_000,
	);
	const context = {
		model: { provider: "timeout-provider" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("status update did not meet its deadline")), 100);
	});
	try {
		await Promise.race([manager.update(context), guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}
	assert.equal(manager.getDiagnostics("timeout-provider").lastError?.code, "timeout");
});

test("reports an invalid direct status timeout without throwing", async () => {
	const manager = new StatusManager(
		[
			{
				id: "invalid-direct-timeout",
				providerId: "invalid-direct-provider",
				name: "Invalid Direct Provider",
				cacheTtlMs: 30_000,
				requestTimeoutMs: 0.5,
				fetch: async () => ({ entries: [], updatedAt: 1_000 }),
			},
		],
		(async () => new Response("unused")) as typeof globalThis.fetch,
		() => 1_000,
	);
	await assert.doesNotReject(
		manager.update({
			model: { provider: "invalid-direct-provider" },
			modelRegistry: { getApiKeyForProvider: async () => "test-key" },
		}),
	);
	assert.equal(manager.getDiagnostics("invalid-direct-provider").lastError?.code, "config");
});

test("ignores a status snapshot that resolves after its deadline", async () => {
	let resolveStatus: ((snapshot: StatusSnapshot) => void) | undefined;
	const manager = new StatusManager(
		[
			{
				id: "late-status",
				providerId: "late-provider",
				name: "Late Provider",
				cacheTtlMs: 30_000,
				requestTimeoutMs: 5,
				fetch: async () =>
					await new Promise((resolve) => {
						resolveStatus = resolve;
					}),
			},
		],
		(async () => new Response("unused")) as typeof globalThis.fetch,
		() => 1_000,
	);
	const context = {
		model: { provider: "late-provider" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
	};

	await manager.update(context);
	assert.equal(manager.getDiagnostics("late-provider").lastError?.code, "timeout");
	resolveStatus?.({ entries: [], updatedAt: 2_000 });
	await new Promise((resolve) => setImmediate(resolve));

	const diagnostics = manager.getDiagnostics("late-provider");
	assert.equal(diagnostics.snapshot, undefined);
	assert.equal(diagnostics.lastError?.code, "timeout");
});

test("deduplicates concurrent status requests", async () => {
	const commands: Record<string, any> = {};
	let requests = 0;
	let resolveStatus: ((snapshot: unknown) => void) | undefined;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("dedup-status", async () => {
				requests++;
				return await new Promise((resolve) => {
					resolveStatus = resolve;
				});
			}),
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);
	const ctx = authContext("dedup-status");
	const first = commands.status.handler("refresh", ctx);
	const second = commands.status.handler("refresh", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests, 1);
	resolveStatus?.({ entries: [], updatedAt: Date.now() });
	await Promise.all([first, second]);
});

test("keeps an in-flight status request when the model changes", async () => {
	const handlers: Record<string, (...args: any[]) => unknown> = {};
	const commands: Record<string, any> = {};
	let resolveStarted: (() => void) | undefined;
	let resolveStatus: ((snapshot: unknown) => void) | undefined;
	let aborted = false;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("cancel-status", async (context) => {
				resolveStarted?.();
				return await new Promise((resolve, reject) => {
					resolveStatus = resolve;
					context.signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			}),
		{ enableOfficialPricingFallback: false },
	);
	await extension({
		registerProvider() {},
		registerCommand(name: string, command: any) {
			commands[name] = command;
		},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers[event] = handler;
		},
	} as any);
	const ctx = authContext("cancel-status");
	const query = commands.status.handler("refresh", ctx);
	await started;
	await handlers.model_select?.({ model: ctx.model, previousModel: undefined, source: "cycle" }, ctx);
	assert.equal(aborted, false);
	resolveStatus?.({ entries: [], updatedAt: Date.now() });
	await query;
});

test("clears status presentation on an expired model restore without requesting it", async () => {
	const handlers: Record<string, (...args: any[]) => unknown> = {};
	const commands: Record<string, any> = {};
	let requests = 0;
	let now = 1_000;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("expired-selection", async (context) => ({
				entries: [{ kind: "amount", id: "balance", label: "Balance", value: ++requests, unit: "credits" }],
				updatedAt: context.now(),
			})),
		{ enableOfficialPricingFallback: false, now: () => now },
	);
	await extension({
		registerProvider() {},
		registerCommand(name: string, command: any) {
			commands[name] = command;
		},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers[event] = handler;
		},
	} as any);
	const notifications: string[] = [];
	const ctx = authContext("expired-selection");
	ctx.ui.notify = (message: string) => notifications.push(message);

	await commands.status.handler("refresh", ctx);
	const notificationCount = notifications.length;
	now += 31_000;
	await handlers.model_select?.({ model: ctx.model, previousModel: undefined, source: "restore" }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(requests, 1);
	assert.equal(notifications.length, notificationCount);

	await commands.status.handler("", ctx);
	assert.equal(requests, 1);
	assert.equal(notifications.length, notificationCount + 1);
	assert.match(notifications.at(-1) ?? "", /Status: stale/);
});

test("does not warn when an active model has no auth configured", async () => {
	const commands: Record<string, any> = {};
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("missing-auth", async () => ({
				entries: [],
				updatedAt: Date.now(),
			})),
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);

	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = authContext("missing-auth");
	ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: false, source: "test" });
	ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });

	await commands.status.handler("", ctx);

	assert.match(notifications.at(-1)?.message ?? "", /Auth: missing/);
	assert.match(notifications.at(-1)?.message ?? "", /Status: unavailable · auth missing/);
	assert.equal(notifications.at(-1)?.level, "info");

	await commands.status.handler("check", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /Availability: skipped · auth missing/);
	assert.equal(notifications.at(-1)?.level, "info");
});

test("does not query or show status for repeated model selections", async () => {
	const handlers: Record<string, (...args: any[]) => unknown> = {};
	let requests = 0;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("warning-once", async () => {
				requests++;
				throw new Error("temporary network failure");
			}),
		{ enableOfficialPricingFallback: false },
	);
	await extension({
		registerProvider() {},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers[event] = handler;
		},
	} as any);

	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = authContext("warning-once");
	ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });
	const selectModel = async () => {
		await handlers.model_select?.({ model: ctx.model, previousModel: undefined, source: "cycle" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
	};

	await selectModel();
	await selectModel();

	assert.equal(requests, 0);
	assert.equal(notifications.length, 0);
});

test("does not render cached status on model selection", async () => {
	const handlers: Record<string, (...args: any[]) => unknown> = {};
	const commands: Record<string, any> = {};
	let requests = 0;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("cached-selection", async (context) => ({
				entries: [{ kind: "amount", id: "balance", label: "Balance", value: ++requests, unit: "credits" }],
				updatedAt: context.now(),
			})),
		{ enableOfficialPricingFallback: false },
	);
	await extension({
		registerProvider() {},
		registerCommand(name: string, command: any) {
			commands[name] = command;
		},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers[event] = handler;
		},
	} as any);
	const notifications: string[] = [];
	const ctx = authContext("cached-selection");
	ctx.ui.notify = (message: string) => notifications.push(message);
	await commands.status.handler("refresh", ctx);
	const selectedModel = { ...ctx.model, id: "next-model", name: "Next Model" };
	await handlers.model_select?.(
		{ model: selectedModel, previousModel: ctx.model, source: "cycle" },
		{
			...ctx,
			model: selectedModel,
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(requests, 1);
	assert.equal(notifications.length, 1);
	assert.match(notifications.at(-1) ?? "", /Model: model/);
	assert.doesNotMatch(notifications.at(-1) ?? "", /next-model/);
	assert.match(notifications.at(-1) ?? "", /Balance: 1 credits/);
});

test("does not fetch or render status during model selection", async () => {
	const handlers: Record<string, (...args: any[]) => unknown> = {};
	let requests = 0;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("selection-status", async () => {
				requests++;
				return { entries: [], updatedAt: Date.now() };
			}),
		{ enableOfficialPricingFallback: false },
	);
	await extension({
		registerProvider() {},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers[event] = handler;
		},
	} as any);
	const notifications: string[] = [];
	const ctx = authContext("selection-status");
	ctx.ui.notify = (message: string) => notifications.push(message);

	for (const source of ["restore", "set", "cycle"] as const) {
		await handlers.model_select?.({ model: ctx.model, previousModel: undefined, source }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(requests, 0);
		assert.equal(notifications.length, 0);
	}
});

test("keeps a stale status snapshot and recovers on a later query", async () => {
	const commands: Record<string, any> = {};
	let requests = 0;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("recovering-status", async () => {
				requests++;
				if (requests === 2) throw new Error("temporary network failure");
				return {
					entries: [{ kind: "amount", id: "balance", label: "Balance", value: 80, unit: "credits" }],
					updatedAt: Date.now(),
				};
			}),
		{ enableOfficialPricingFallback: false },
	);
	await extension(createPi(commands) as any);
	const notifications: string[] = [];
	const ctx = authContext("recovering-status");
	ctx.ui.notify = (message: string) => notifications.push(message);

	await commands.status.handler("refresh", ctx);
	await commands.status.handler("refresh", ctx);
	assert.match(notifications.at(-1) ?? "", /Status: stale/);
	assert.match(notifications.at(-1) ?? "", /Balance: 80 credits/);
	assert.match(notifications.at(-1) ?? "", /Error: fetch/);

	await commands.status.handler("refresh", ctx);
	assert.match(notifications.at(-1) ?? "", /Status: fresh/);
	assert.equal(requests, 3);
});

test("does not query statuses during session lifecycle events", async () => {
	const handlers: Record<string, (...args: any[]) => unknown> = {};
	let requests = 0;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("lifecycle-status", async () => {
				requests++;
				return { entries: [], updatedAt: Date.now() };
			}),
		{ enableOfficialPricingFallback: false },
	);
	await extension({
		registerProvider() {},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers[event] = handler;
		},
	} as any);

	await handlers.session_start?.({}, authContext("lifecycle-status"));
	assert.equal(requests, 0);
});

test("queries Charm Hyper status on demand", async () => {
	const commands: Record<string, any> = {};
	const requests: Array<{ url: string; authorization?: string }> = [];
	const extension = createTestRuntime({
		enableOfficialPricingFallback: false,
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input.toString();
			const headers = new Headers(init?.headers);
			requests.push({ url, authorization: headers.get("authorization") ?? undefined });
			if (url.endsWith("/provider")) return emptyHyperResponse();
			return new Response(JSON.stringify({ balance: 75 }), { status: 200 });
		},
	});
	await extension(createPi(commands) as any);
	const notifications: string[] = [];
	const ctx = authContext("charm-hyper");
	ctx.model.id = "glm-5";
	ctx.ui.notify = (message: string) => notifications.push(message);

	await commands.status.handler("refresh", ctx);
	assert.deepEqual(
		[...requests].reverse().find(({ url }) => url.endsWith("/credits")),
		{
			url: "https://hyper.charm.land/v1/credits",
			authorization: "Bearer test-key",
		},
	);
	assert.match(notifications.at(-1) ?? "", /Status: fresh/);
	assert.match(notifications.at(-1) ?? "", /Balance: 75 credits/);
});

test("reports effective reasoning levels from Pi's sparse model map", async () => {
	const commands: Record<string, any> = {};
	const extension = createPiProviderRuntime(async () => providerDefinition("reasoning-provider"), {
		enableOfficialPricingFallback: false,
	});
	await extension(createPi(commands) as any);

	const notifications: string[] = [];
	const ctx: any = {
		model: {
			provider: "reasoning-provider",
			id: "reasoning-model",
			name: "Reasoning Model",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
			input: ["text"],
			contextWindow: 400_000,
			maxTokens: 128_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured: true, source: "test" }),
		},
		ui: { notify: (message: string) => notifications.push(message) },
	};

	await commands.status.handler("", ctx);
	assert.match(notifications.at(-1) ?? "", /Reasoning: supported \(off, minimal, low, medium, high, xhigh, max\)/);

	ctx.model.thinkingLevelMap = {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	};
	await commands.status.handler("", ctx);
	assert.match(notifications.at(-1) ?? "", /Reasoning: supported \(low, high, max\)/);
});

function base64Url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("reports the native OpenAI Codex status without registering a fake provider", async () => {
	const commands: Record<string, any> = {};
	const registrations: string[] = [];
	const requests: Array<{ url: string; headers: Headers }> = [];
	const now = 1_700_000_000_000;
	const token = `${base64Url({ alg: "none" })}.${base64Url({
		"https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
	})}.signature`;
	const extension = createTestRuntime({
		enableOfficialPricingFallback: false,
		now: () => now,
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input.toString();
			const headers = new Headers(init?.headers);
			requests.push({ url, headers });
			if (url.endsWith("/provider")) return emptyHyperResponse();
			if (url.includes("/codex/models?client_version=")) {
				return new Response(
					JSON.stringify({
						models: [{ slug: "gpt-5.5", visibility: "list", supported_in_api: true }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					plan_type: "pro",
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: {
							used_percent: 18,
							limit_window_seconds: 18_000,
							reset_at: now / 1_000 + 7_200,
						},
						secondary_window: {
							used_percent: 36,
							limit_window_seconds: 604_800,
							reset_at: now / 1_000 + 345_600,
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	});
	await extension(createPi(commands, registrations) as any);
	const notifications: string[] = [];
	const ctx = {
		model: {
			provider: "openai-codex",
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			contextWindow: 400_000,
			maxTokens: 128_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured: true, source: "oauth" }),
			getApiKeyForProvider: async () => token,
		},
		ui: { notify: (message: string) => notifications.push(message) },
	};

	await commands.status.handler("refresh", ctx);
	const report = notifications.at(-1) ?? "";

	assert.deepEqual(registrations, ["charm-hyper"]);
	assert.match(report, /Provider: openai-codex/);
	assert.doesNotMatch(report, /Provider: OpenAI Codex/);
	assert.match(report, /Model: gpt-5\.5/);
	assert.doesNotMatch(report, /Model: GPT-5\.5/);
	assert.match(report, /Plan: Pro/);
	const primaryReset = new Date(now + 7_200_000);
	const pad = (value: number): string => value.toString().padStart(2, "0");
	const primaryResetLabel = `${primaryReset.getFullYear()}-${pad(primaryReset.getMonth() + 1)}-${pad(primaryReset.getDate())} ${pad(primaryReset.getHours())}:${pad(primaryReset.getMinutes())}`;
	assert.ok(report.includes(`5h: 82% remaining · reset at ${primaryResetLabel}`));
	assert.doesNotMatch(report, /reset in \d/);
	assert.match(report, /Availability: not checked/);
	assert.doesNotMatch(report, /Live check scope:/);
	assert.match(report, /Weekly: 64% remaining/);
	const usageRequest = requests.find(({ url }) => url === "https://chatgpt.com/backend-api/wham/usage");
	const catalogRequest = requests.find(({ url }) => url.includes("/codex/models?client_version="));
	assert.ok(usageRequest);
	assert.ok(catalogRequest);
	assert.equal(usageRequest.headers.get("authorization"), `Bearer ${token}`);
	assert.equal(usageRequest.headers.get("chatgpt-account-id"), "account-123");
	assert.equal(usageRequest.headers.get("originator"), "pi");
	assert.match(report, /Preflight: passed · endpoint\/auth\/catalog/);
});

test("shows quality and native field sources without replacing its price", async () => {
	const commands: Record<string, any> = {};
	const registrations: string[] = [];
	const extension = createPiProviderRuntime(async () => providerDefinition("managed-provider"), {
		officialPricingUrl: "https://reference.invalid/models",
		fetch: async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "openai/gpt-5",
							pricing: { prompt: "0.000001", completion: "0.000002" },
							benchmarks: {
								artificial_analysis: {
									intelligence_index: 51.2,
									coding_index: 71.4,
									agentic_index: 45.6,
								},
							},
							context_length: 128_000,
							top_provider: { max_completion_tokens: 32_000 },
							architecture: { input_modalities: ["text", "image"] },
							reasoning: { supported_efforts: ["low", "high"] },
							supported_parameters: ["reasoning_effort"],
						},
					],
				}),
				{ status: 200 },
			),
	});
	await extension(createPi(commands, registrations) as any);

	const notifications: string[] = [];
	const ctx: any = {
		model: {
			provider: "openai-codex",
			id: "gpt-5",
			api: "openai-completions",
			baseUrl: "https://native.example/v1",
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 16_384,
			reasoning: false,
			cost: { input: 7, output: 9, cacheRead: 0, cacheWrite: 0 },
		},
		modelRegistry: {
			getProvider: (provider: string) =>
				provider === "openai-codex" ? { getModels: () => [{ id: "gpt-5" }] } : undefined,
			getProviderAuthStatus: () => ({ configured: true, source: "native" }),
			getApiKeyForProvider: async () => "native-key",
		},
		ui: { notify: (message: string) => notifications.push(message) },
	};

	await commands.status.handler("", ctx);
	const report = notifications.at(-1) ?? "";
	assert.deepEqual(registrations, ["managed-provider"]);
	assert.match(report, /Context: 128k · Pi native/);
	assert.match(report, /Max output: 16k · Pi native/);
	assert.match(report, /Input: text · Pi native/);
	assert.match(report, /Reasoning: not supported · Pi native/);
	assert.match(
		report,
		/Quality:\n {2}Status: fresh · just now\n {2}Source: Official metadata\n {2}Indices: intelligence 51.2 · coding 71.4 · agentic 45.6/,
	);
	assert.match(report, /Pricing: \$7 input \/ \$9 output per 1M tokens · Pi native · estimate/);
	assert.doesNotMatch(report, /Capability reference:/);
	assert.doesNotMatch(report, /Pricing source:/);
	assert.equal(ctx.model.reasoning, false);
	assert.deepEqual(ctx.model.cost, { input: 7, output: 9, cacheRead: 0, cacheWrite: 0 });
});

test("updates native quality metrics after a non-blocking metadata refresh", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-native-reference-"));
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
						id: "openai/gpt-5",
						pricing: { prompt: "0.000001", completion: "0.000002" },
						benchmarks: {
							artificial_analysis: { intelligence_index: 51.2 },
						},
						context_length: 128_000,
					},
				],
			}),
			{ status: 200 },
		);
	}) as typeof globalThis.fetch;
	try {
		const commands: Record<string, any> = {};
		const extension = createPiProviderRuntime(async () => providerDefinition("managed-provider"), {
			fetch: fetchFn,
			officialPricingCacheTtlMs: 0,
			openRouterMetadataCachePath: join(root, "metadata.json"),
		});
		await extension(createPi(commands) as any);

		const notifications: string[] = [];
		const ctx: any = {
			model: {
				provider: "openai-codex",
				id: "gpt-5",
				api: "openai-completions",
				baseUrl: "https://native.example/v1",
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 16_384,
				reasoning: false,
				cost: { input: 7, output: 9, cacheRead: 0, cacheWrite: 0 },
			},
			modelRegistry: {
				getProvider: (provider: string) =>
					provider === "openai-codex" ? { getModels: () => [{ id: "gpt-5" }] } : undefined,
				getProviderAuthStatus: () => ({ configured: true, source: "native" }),
				getApiKeyForProvider: async () => "native-key",
			},
			ui: { notify: (message: string) => notifications.push(message) },
		};

		await fetchStarted;
		await commands.status.handler("", ctx);
		assert.match(notifications.at(-1) ?? "", /Quality:\n {2}Status: unavailable · no AA\/OpenRouter metric/);
		release?.();
		for (let attempt = 0; attempt < 100; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			await commands.status.handler("", ctx);
			if ((notifications.at(-1) ?? "").includes("Source: AA/OpenRouter")) break;
		}
		assert.match(
			notifications.at(-1) ?? "",
			/Quality:\n {2}Status: stale · just now\n {2}Source: AA\/OpenRouter\n {2}Indices: intelligence 51.2/,
		);
	} finally {
		clearPricingCache(OPENROUTER_MODELS_URL);
		await rm(root, { recursive: true, force: true });
	}
});

test("reports native Pi catalogs and local preflight without registering a duplicate provider", async () => {
	const commands: Record<string, any> = {};
	const registrations: string[] = [];
	const nativeProvider = {
		getModels: () => [{ id: "native-model" }],
	};
	const extension = createPiProviderRuntime(async () => providerDefinition("managed-provider"), {
		enableOfficialPricingFallback: false,
	});
	await extension(createPi(commands, registrations) as any);

	const notifications: string[] = [];
	const ctx: any = {
		model: {
			provider: "native-provider",
			id: "native-model",
			api: "openai-completions",
			baseUrl: "https://native.example/v1",
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 16_384,
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		modelRegistry: {
			getProvider: (provider: string) => (provider === "native-provider" ? nativeProvider : undefined),
			getProviderAuthStatus: () => ({ configured: true, source: "native" }),
			getApiKeyForProvider: async () => "native-key",
		},
		ui: { notify: (message: string) => notifications.push(message) },
	};

	await commands.status.handler("", ctx);
	const report = notifications.at(-1) ?? "";
	assert.deepEqual(registrations, ["managed-provider"]);
	assert.match(report, /Catalog:\n {2}Status: static · Pi native\n {2}Models: 1/);
	assert.match(report, /Preflight: native · provider\/auth\/catalog/);
	assert.doesNotMatch(report, /not managed by Pi Provider/);
});

test("injects the stored credential reader and text wrapper into status reporting", async () => {
	const commands: Record<string, any> = {};
	let seenCredentialMetadata: unknown;
	let wrapCalls = 0;
	const extension = createPiProviderRuntime(
		async () =>
			providerDefinition("injected-deps", async (context) => {
				seenCredentialMetadata = context.getCredentialMetadata?.();
				return {
					entries: [{ kind: "amount", id: "balance", label: "Balance", value: 75, unit: "credits" }],
					updatedAt: context.now(),
				};
			}),
		{
			enableOfficialPricingFallback: false,
			readStoredCredential: () => ({ type: "oauth", teamName: "acme" }),
			wrapTextWithAnsi: (text, width) => {
				wrapCalls++;
				return [text.slice(0, width)];
			},
		},
	);
	await extension(createPi(commands) as any);
	const notifications: string[] = [];
	const widgetUpdates: Array<{ content: unknown }> = [];
	const ctx: any = authContext("injected-deps");
	ctx.mode = "tui";
	ctx.ui.notify = (message: string) => notifications.push(message);
	ctx.ui.setWidget = (_key: string, content: unknown) => widgetUpdates.push({ content });
	await commands.status.handler("refresh", ctx);

	assert.deepEqual(seenCredentialMetadata, { type: "oauth", teamName: "acme" });
	const widgetFactory = widgetUpdates[0]?.content as (
		tui: unknown,
		theme: unknown,
	) => { render(width: number): string[]; invalidate(): void };
	const widget = widgetFactory({}, { fg: (_color: string, text: string) => text });
	widget.render(200);
	assert.ok(wrapCalls > 0);
});

test("programmatic defaults keep the agent-dir pricing cache path", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = join(tmpdir(), "pi-provider-default-agent-");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const deps = indexExports.getDefaultPiProviderDependencies();
		assert.equal(deps.agentDir, agentDir);
		assert.equal(deps.openRouterMetadataCachePath, join(agentDir, "extensions", "pi-provider", "openrouter-model-metadata.json"));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
