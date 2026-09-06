import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	files?: string[];
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	pi?: { extensions?: string[] };
};

function capabilityEntrypoints(directory: string): string[] {
	const root = join(packageRoot, directory);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
		.map((entry) => join(root, entry.name))
		.sort();
}

test("publishes one Pi extension entrypoint for the Pi Provider package", () => {
	assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
});

test("does not publish local private provider adapters", () => {
	assert.ok(!packageJson.files?.includes("pi-provider"));
});

test("documents and prepares the agentDir adapter cache under extensions/pi-provider", () => {
	const entrypoint = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(entrypoint, /<agentDir>\/extensions\/pi-provider/);

	const publishWorkflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
	assert.match(publishWorkflow, /cache_dir="\$agent_dir\/extensions\/pi-provider"/);
});

test("declares Pi-bundled runtime packages as open peers", () => {
	assert.deepEqual(packageJson.peerDependencies, {
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
	});
});

test("pins the adapter module loader runtime dependency", () => {
	assert.equal(packageJson.dependencies?.jiti, "2.7.0");
});

test("typechecks the optional local private overlay when it is present", () => {
	if (!existsSync(`${packageRoot}/pi-provider`)) return;
	execFileSync(
		"npx",
		[
			"tsc",
			"--noEmit",
			"--target",
			"ES2022",
			"--module",
			"Node16",
			"--moduleResolution",
			"Node16",
			"--strict",
			"--esModuleInterop",
			"--skipLibCheck",
			"--allowImportingTsExtensions",
			"pi-provider/index.ts",
		],
		{ cwd: packageRoot, stdio: "pipe" },
	);
});

test("all built-in capability entrypoints expose loadable public extensions", async () => {
	const byCapability = Object.fromEntries(
		["providers", "preflight", "status", "tuners"].map((directory) => [directory, capabilityEntrypoints(directory)]),
	) as Record<string, string[]>;
	assert.deepEqual(
		Object.fromEntries(Object.entries(byCapability).map(([directory, paths]) => [directory, paths.length])),
		{ providers: 1, preflight: 19, status: 13, tuners: 0 },
	);
	const paths = Object.values(byCapability).flat();
	const result = await discoverAndLoadExtensions(paths, packageRoot, packageRoot);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, paths.length);
});

test("public examples expose loadable Provider, Preflight, and Status extensions", async () => {
	const paths = [
		join(packageRoot, "examples/maas/providers/maas.ts"),
		join(packageRoot, "examples/maas/preflight/maas.ts"),
		join(packageRoot, "examples/command-code/providers/command-code.ts"),
		join(packageRoot, "examples/command-code/preflight/command-code.ts"),
		join(packageRoot, "examples/command-code/status/command-code.ts"),
	];
	const result = await discoverAndLoadExtensions(paths, packageRoot, packageRoot);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, paths.length);
});

test("the npm tarball contains only public capability entrypoints", () => {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: packageRoot,
		encoding: "utf8",
	});
	const metadata = JSON.parse(output) as Array<{ files?: Array<{ path: string }> }>;
	const files = metadata[0]?.files?.map(({ path }) => path) ?? [];
	assert.ok(files.includes("index.ts"));
	assert.ok(files.includes("providers/charm-hyper.ts"));
	assert.ok(files.includes("preflight/charm-hyper.ts"));
	for (const path of [
		"preflight/deepseek.ts",
		"preflight/google.ts",
		"preflight/openai-codex.ts",
		"preflight/opencode.ts",
		"preflight/opencode-go.ts",
	]) {
		assert.ok(files.includes(path), `${path} should be published`);
	}
	for (const path of [
		"status/charm-hyper.ts",
		"status/deepseek.ts",
		"status/openai-codex.ts",
		"status/opencode-go.ts",
	]) {
		assert.ok(files.includes(path), `${path} should be published`);
	}
	assert.ok(files.includes("CHANGELOG.md"));
	assert.ok(files.includes("README.md"));
	assert.ok(files.includes("LICENSE"));
	assert.ok(!files.includes("CONTEXT.md"));
	assert.ok(!files.some((path) => path.startsWith("docs/")));
	assert.ok(!files.some((path) => path.startsWith("pi-provider/")));
	assert.ok(!files.some((path) => path.startsWith("pi-provider/")));
	assert.ok(!files.some((path) => path.startsWith("test/")));
});

test("the npm tarball contains no legacy product terminology", () => {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: packageRoot,
		encoding: "utf8",
	});
	const metadata = JSON.parse(output) as Array<{ files?: Array<{ path: string }> }>;
	const files = metadata[0]?.files?.map(({ path }) => path) ?? [];
	const legacyTerms = [["provider", "kit"].join(""), ["provider", "kit"].join("-"), ["provider", "kit"].join(" ")];
	for (const path of files) {
		const content = readFileSync(join(packageRoot, path), "utf8").toLowerCase();
		for (const term of legacyTerms) {
			assert.equal(content.includes(term), false, `${path} contains legacy product terminology`);
		}
	}
});
