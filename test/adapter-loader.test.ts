import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { loadPackageAdapterExtensions, resolveAdapterRoots } from "../core/adapter-loader.ts";
import { PI_PROVIDER_ADAPTER_EVENT, PI_PROVIDER_STARTUP_BRIDGE_EVENT } from "../core/adapter-protocol.ts";
import { getDefaultPiProviderDependencies } from "../core/runtime-config.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

interface RegistrationEnvelope {
	kind: string;
	id: string;
	adapter?: {
		id: string;
		provider?: { models?: Array<{ id: string }> };
	};
}

function mockPi() {
	const registrations: RegistrationEnvelope[] = [];
	return {
		events: {
			emit(channel: string, value: RegistrationEnvelope) {
				if (channel === PI_PROVIDER_ADAPTER_EVENT) registrations.push(value);
			},
		},
		on() {},
		registerProvider() {},
		registrations,
	};
}

async function writeProviderAdapter(dir: string, relativePath: string, id: string, modelId: string) {
	const abs = join(dir, relativePath);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(
		abs,
		[
			`import { defineProviderExtension } from ${JSON.stringify(`${packageRoot}/core/adapter-extensions.ts`)};`,
			`export default defineProviderExtension({`,
			`	id: ${JSON.stringify(id)},`,
			`	create: () => ({`,
			`		id: ${JSON.stringify(id)},`,
			`		provider: {`,
			`			name: "Test Provider",`,
			`			baseUrl: "https://example.com/v1",`,
			`			apiKey: "$TEST_KEY",`,
			`			api: "openai-completions",`,
			`			models: [{ id: ${JSON.stringify(modelId)} }],`,
			`		},`,
			`	}),`,
			`});`,
		].join("\n"),
		"utf8",
	);
}

test("resolveAdapterRoots scans the package root before the user root", () => {
	assert.deepEqual(resolveAdapterRoots({ packageRoot: "/pkg", agentDir: "/agent" }), [
		"/pkg",
		join("/agent", "extensions", "pi-provider"),
	]);
	assert.deepEqual(resolveAdapterRoots({ packageRoot: "/pkg" }), ["/pkg"]);
	assert.deepEqual(resolveAdapterRoots({ packageRoot: "/pkg", agentDir: "/agent", userRoot: "/custom" }), [
		"/pkg",
		"/custom",
	]);
	assert.deepEqual(resolveAdapterRoots({ packageRoot: "/pkg", agentDir: "", userRoot: "/custom" }), [
		"/pkg",
		"/custom",
	]);
});

test("loads built-in adapters before user adapters", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-loader-"));
	try {
		const builtinRoot = join(root, "builtin");
		const userRoot = join(root, "user");
		await writeProviderAdapter(builtinRoot, "providers/builtin-provider.ts", "builtin-provider", "builtin-model");
		await writeProviderAdapter(userRoot, "providers/user-provider.ts", "user-provider", "user-model");

		const pi = mockPi();
		await loadPackageAdapterExtensions(pi as never, { packageRoot: builtinRoot, userRoot });
		assert.deepEqual(
			pi.registrations.map((entry) => entry.id),
			["builtin-provider", "user-provider"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolves same-ID collisions to the user adapter loaded last", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-loader-"));
	try {
		const builtinRoot = join(root, "builtin");
		const userRoot = join(root, "user");
		await writeProviderAdapter(builtinRoot, "providers/dup-provider.ts", "dup-provider", "builtin-model");
		await writeProviderAdapter(userRoot, "providers/dup-provider.ts", "dup-provider", "user-model");

		const pi = mockPi();
		await loadPackageAdapterExtensions(pi as never, { packageRoot: builtinRoot, userRoot });
		assert.deepEqual(
			pi.registrations.map((entry) => entry.id),
			["dup-provider", "dup-provider"],
		);
		const providerEnvelope = pi.registrations.at(-1);
		assert.equal(providerEnvelope?.adapter?.provider?.models?.[0]?.id, "user-model");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("user adapters can import helpers and types from the public entrypoint", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-public-api-"));
	try {
		const statusDir = join(root, "status");
		await mkdir(statusDir, { recursive: true });
		await writeFile(
			join(statusDir, "public-api.ts"),
			[
				`import { defineStatusExtension, parseRetryAfter, ProviderDataError } from "@hyav/pi-provider";`,
				`import type { StatusAdapter, StatusSnapshot } from "@hyav/pi-provider";`,
				`export default defineStatusExtension({`,
				`	id: "public-api-status",`,
				`	providerId: "public-api-provider",`,
				`	create: () => ({`,
				`		id: "public-api-status",`,
				`		providerId: "public-api-provider",`,
				`		name: "Public API",`,
				`		cacheTtlMs: 30_000,`,
				`		requestTimeoutMs: 1_000,`,
				`		async fetch() {`,
				`			parseRetryAfter(null, Date.now());`,
				`			throw new ProviderDataError("boom", "boom");`,
				`		},`,
				`	} as StatusAdapter),`,
				`});`,
			].join("\n"),
			"utf8",
		);

		const pi = mockPi();
		await loadPackageAdapterExtensions(pi as never, { userRoot: root });
		assert.equal(pi.registrations.at(-1)?.id, "public-api-status");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a copy of every built-in adapter loads from the public entrypoint", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-builtin-copy-"));
	const originalWarn = console.warn;
	try {
		const copyTree = async (source: string, target: string): Promise<number> => {
			const fs = await import("node:fs/promises");
			let entries: import("node:fs").Dirent[];
			try {
				entries = await fs.readdir(source, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
				throw error;
			}
			await mkdir(target, { recursive: true });
			let files = 0;
			for (const entry of entries) {
				const sourcePath = join(source, entry.name);
				const targetPath = join(target, entry.name);
				if (entry.isDirectory()) {
					files += await copyTree(sourcePath, targetPath);
				} else if (entry.name.endsWith(".ts")) {
					const content = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));
					const rewritten = content
						.replace(/from "(\.[./]*core\/)[^"]+"/g, 'from "@hyav/pi-provider"')
						.replace(
							/(?:from|require)\("(\.[./]*package\.json)"\)/g,
							`require(${JSON.stringify(join(packageRoot, "package.json"))})`,
						);
					await writeFile(targetPath, rewritten, "utf8");
					files++;
				}
			}
			return files;
		};

		for (const dir of ["providers", "status", "preflight", "tuners"]) {
			await copyTree(join(packageRoot, dir), join(root, dir));
		}

		const pi = mockPi();
		const warnings: string[] = [];
		console.warn = (message?: unknown) => warnings.push(String(message));
		await loadPackageAdapterExtensions(pi as never, { userRoot: root });
		console.warn = originalWarn;

		assert.deepEqual(warnings, []);
		// Built-in adapters (19 preflight + 13 status + 1 provider) plus their copies in the user root;
		// helper subdirectories are not scanned.
		assert.equal(pi.registrations.length, 66);
	} finally {
		console.warn = originalWarn;
		await rm(root, { recursive: true, force: true });
	}
});

test("the Pi entrypoint re-exports every public adapter API for programmatic consumers", async () => {
	const indexNamespace = await import("../index.ts");
	const publicAdaptersNamespace = await import("../core/public-adapters.ts");
	const publicKeys = Object.keys(publicAdaptersNamespace).sort();
	const missing = publicKeys.filter((key) => !(key in indexNamespace));
	assert.deepEqual(missing, []);
});

test("reload reflects modified adapter files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-reload-mod-"));
	try {
		const providersDir = join(root, "providers");
		await mkdir(providersDir, { recursive: true });
		const file = join(providersDir, "mod-provider.ts");
		const writeAdapter = (modelId: string) =>
			writeFile(
				file,
				[
					`import { defineProviderExtension } from "@hyav/pi-provider";`,
					`export default defineProviderExtension({`,
					`	id: "mod-provider",`,
					`	create: () => ({`,
					`		id: "mod-provider",`,
					`		provider: {`,
					`			name: "Mod",`,
					`			baseUrl: "https://x.invalid/v1",`,
					`			apiKey: "$K",`,
					`			api: "openai-completions",`,
					`			models: [{ id: ${JSON.stringify(modelId)} }],`,
					`		},`,
					`	}),`,
					`});`,
				].join("\n"),
			);
		const loadModels = async (): Promise<string[]> => {
			const models: string[] = [];
			const pi = {
				events: {
					emit(channel: string, value: RegistrationEnvelope) {
						if (
							channel === PI_PROVIDER_ADAPTER_EVENT &&
							value.kind === "provider" &&
							value.id === "mod-provider"
						) {
							models.push(value.adapter?.provider?.models?.[0]?.id ?? "");
						}
					},
				},
				on() {},
				registerProvider() {},
			};
			await loadPackageAdapterExtensions(pi as never, { userRoot: root });
			return models;
		};

		await writeAdapter("one");
		assert.deepEqual(await loadModels(), ["one"]);
		await writeAdapter("two");
		assert.deepEqual(await loadModels(), ["two"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("façade namespace contains all adapter runtime helpers and type fixture compiles", async () => {
	const publicAdaptersNamespace = await import("../core/public-adapters.ts");
	const expectedRuntimeHelpers = [
		"definePreflightExtension",
		"defineProviderExtension",
		"defineStatusExtension",
		"defineTunerExtension",
		"MAX_PROVIDER_MODEL_COUNT",
		"validateProviderModelDrafts",
		"createCatalogPreflightAdapter",
		"withDeadline",
		"appendBaseUrlPath",
		"authDefinesHeader",
		"getContextAuth",
		"hasBaseUrlOrigin",
		"mergeDiagnosticHeaders",
		"isProviderDataError",
		"ProviderDataError",
		"createModelCatalogLifecycle",
		"createOpenCodeCatalogPreflightAdapter",
		"isLegacyNormalizedModel",
		"isLegacyNormalizedSnapshot",
		"normalizeProviderModels",
		"parseRetryAfter",
	];

	for (const helper of expectedRuntimeHelpers) {
		assert.equal(
			typeof (publicAdaptersNamespace as Record<string, unknown>)[helper] !== "undefined",
			true,
			`Missing runtime helper in façade: ${helper}`,
		);
	}

	const publicAdaptersPath = join(packageRoot, "core", "public-adapters.ts");
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.Node16,
		moduleResolution: ts.ModuleResolutionKind.Node16,
		strict: true,
		noEmit: true,
		baseUrl: packageRoot,
		paths: {
			"@hyav/pi-provider": [publicAdaptersPath],
		},
	};

	const fixtureCode = `
import type {
	AdapterExtensionContext,
	PreflightExtensionDefinition,
	ProviderExtensionDefinition,
	StatusExtensionDefinition,
	TunerExtensionDefinition,
	ModelCatalogDiagnostics,
	ModelCatalogDiscoveryResult,
	ModelCatalogLifecycle,
	ModelCatalogLifecycleOptions,
	ModelCatalogSource,
	ModelCatalogStatus,
	PreflightAdapter,
	PreflightContextLike,
	PreflightModel,
	PreflightSnapshot,
	StatusContextLike,
	ActiveModel,
	ProviderAdapter,
	ProviderCost,
	ProviderModel,
	ProviderModelDraft,
	ProviderPricingAdjustment,
	ProviderPricingPolicy,
	ProviderPricingSource,
	ProviderRefreshContext,
	ProviderRequestAuth,
	StatusAdapter,
	StatusContext,
	StatusEntry,
	StatusSnapshot,
	StoredCredentialLike,
	ThinkingLevel,
	TunerAdapter,
	TunerContext,
} from "@hyav/pi-provider";
import {
	definePreflightExtension,
	defineProviderExtension,
	defineStatusExtension,
	defineTunerExtension,
	MAX_PROVIDER_MODEL_COUNT,
	validateProviderModelDrafts,
	createCatalogPreflightAdapter,
	withDeadline,
	appendBaseUrlPath,
	authDefinesHeader,
	getContextAuth,
	hasBaseUrlOrigin,
	mergeDiagnosticHeaders,
	isProviderDataError,
	ProviderDataError,
	createModelCatalogLifecycle,
	createOpenCodeCatalogPreflightAdapter,
	isLegacyNormalizedModel,
	isLegacyNormalizedSnapshot,
	normalizeProviderModels,
	parseRetryAfter,
} from "@hyav/pi-provider";
`;

	const host = ts.createCompilerHost(options);
	const originalGetSourceFile = host.getSourceFile;
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
		if (fileName.endsWith("typecheck-fixture.ts")) {
			return ts.createSourceFile(fileName, fixtureCode, languageVersion);
		}
		return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
	};

	const program = ts.createProgram([join(packageRoot, "typecheck-fixture.ts")], options, host);
	const diagnostics = ts
		.getPreEmitDiagnostics(program)
		.filter((d) => d.file?.fileName.endsWith("typecheck-fixture.ts"));
	assert.deepEqual(diagnostics, []);
});

test("user adapter loaded via Jiti invokes validateProviderModelDrafts and isLegacyNormalizedSnapshot", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-user-helpers-"));
	try {
		const providersDir = join(root, "providers");
		await mkdir(providersDir, { recursive: true });
		await writeFile(
			join(providersDir, "user-validation-adapter.ts"),
			[
				`import { defineProviderExtension, isLegacyNormalizedSnapshot, validateProviderModelDrafts } from "@hyav/pi-provider";`,
				`export default defineProviderExtension({`,
				`	id: "user-validation-provider",`,
				`	create: () => {`,
				`		validateProviderModelDrafts([{ id: "valid-draft" }]);`,
				`		const isLegacy = isLegacyNormalizedSnapshot([{`,
				`			id: "legacy",`,
				`			name: "legacy",`,
				`			provider: "test",`,
				`			baseUrl: "https://example.com/v1",`,
				`			api: "openai-completions",`,
				`			contextWindow: 128_000,`,
				`			maxTokens: 16_384,`,
				`			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },`,
				`			reasoning: false,`,
				`			input: ["text"],`,
				`		}]);`,
				`		if (!isLegacy) throw new Error("Expected isLegacyNormalizedSnapshot to return true");`,
				`		return {`,
				`			id: "user-validation-provider",`,
				`			provider: {`,
				`				name: "User Validation",`,
				`				baseUrl: "https://example.com/v1",`,
				`				apiKey: "$KEY",`,
				`				api: "openai-completions",`,
				`				models: [{ id: "valid-draft" }],`,
				`			},`,
				`		};`,
				`	},`,
				`});`,
			].join("\n"),
			"utf8",
		);

		const pi = mockPi();
		await loadPackageAdapterExtensions(pi as never, { userRoot: root });
		const registration = pi.registrations.find((r) => r.id === "user-validation-provider");
		assert.ok(registration);
		assert.equal(registration.adapter?.provider?.models?.[0]?.id, "valid-draft");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("real providers/charm-hyper.ts loaded via Jiti executes refreshModels against simulated provider", async () => {
	const requestedUrls: string[] = [];
	const customFetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
		requestedUrls.push(url);
		if (url === "https://hyper.charm.land/v1/provider") {
			return new Response(
				JSON.stringify({
					models: [
						{
							id: "charm-hyper-sim-model",
							name: "Charm Hyper Sim Model",
							cost_per_1m_in: 1.5,
							cost_per_1m_out: 3.0,
							cost_per_1m_in_cached: 0.75,
							context_window: 200_000,
							default_max_tokens: 32_000,
							can_reason: true,
							supports_attachments: true,
							reasoning_levels: ["low", "medium", "high"],
							default_reasoning_effort: "medium",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("Not found", { status: 404 });
	};

	let registeredAdapter: any;
	const pi = {
		events: {
			emit(channel: string, value: any) {
				if (channel === PI_PROVIDER_STARTUP_BRIDGE_EVENT) {
					value.bridge = {
						dependencies: {
							...getDefaultPiProviderDependencies(),
							fetch: customFetch,
						},
						piCatalog: Promise.resolve({ models: {}, providers: {}, updatedAt: Date.now() }),
					};
				}
				if (channel === PI_PROVIDER_ADAPTER_EVENT && value.id === "charm-hyper" && value.kind === "provider") {
					registeredAdapter = value.adapter;
				}
			},
		},
		on() {},
		registerProvider() {},
	};

	await loadPackageAdapterExtensions(pi as never, { packageRoot });
	assert.ok(registeredAdapter, "Charm Hyper adapter should be registered");
	assert.ok(registeredAdapter.provider?.refreshModels, "refreshModels must be defined");

	// Verify cache restoration with legacy snapshot discards it cleanly without error
	const legacyResult = await registeredAdapter.provider.refreshModels({
		allowNetwork: false,
		force: false,
		signal: new AbortController().signal,
		publish: async ({ update }: any) => {
			update?.();
			return true;
		},
		stored: {
			checkedAt: Date.now(),
			models: [
				{
					id: "legacy-model",
					name: "legacy-model",
					provider: "charm-hyper",
					baseUrl: "https://hyper.charm.land/v1",
					api: "openai-completions",
					contextWindow: 128_000,
					maxTokens: 16_384,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					reasoning: false,
					input: ["text"],
				},
			],
		},
	});
	assert.equal(legacyResult.length, 0);

	const refreshed = await registeredAdapter.provider.refreshModels({
		allowNetwork: true,
		force: true,
		signal: new AbortController().signal,
		publish: async ({ update }: any) => {
			update?.();
			return true;
		},
	});

	assert.ok(
		requestedUrls.includes("https://hyper.charm.land/v1/provider"),
		"Discovery endpoint should have been requested",
	);
	assert.equal(refreshed.length, 1);
	const model = refreshed[0];
	assert.equal(model.id, "charm-hyper-sim-model");
	assert.equal(model.contextWindow, 200_000);
	assert.equal(model.maxTokens, 32_000);
	assert.deepEqual(model.cost, { input: 1.5, output: 3.0, cacheRead: 0.75, cacheWrite: 0 });
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.reasoning, true);
	assert.ok(model.thinkingLevelMap);
	assert.equal(model.thinkingLevelMap.low, "low");
	assert.equal(model.thinkingLevelMap.medium, "medium");
	assert.equal(model.thinkingLevelMap.high, "high");
	assert.equal(model.compat?.supportsReasoningEffort, true);
});
