import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPackageAdapterExtensions, resolveAdapterRoots } from "../core/adapter-loader.ts";
import { PI_PROVIDER_ADAPTER_EVENT } from "../core/adapter-protocol.ts";

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
		// Built-in adapters (18 preflight + 12 status + 1 provider) plus their copies in the user root;
		// helper subdirectories are not scanned.
		assert.equal(pi.registrations.length, 62);
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
