import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

test("publishes one Pi extension entrypoint for the Provider Kit package", () => {
	assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
});

test("does not publish local private provider adapters", () => {
	assert.ok(!packageJson.files?.includes("pi-provider"));
	assert.ok(!packageJson.files?.includes("pi-provider-kit"));
});

test("declares Pi-bundled runtime packages as open peers", () => {
	assert.deepEqual(packageJson.peerDependencies, {
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
	});
});

test("declares the adapter module loader as a runtime dependency", () => {
	assert.equal(packageJson.dependencies?.jiti, "^2.7.0");
});

test("typechecks the optional local private overlay when it is present", () => {
	if (!existsSync(`${packageRoot}/pi-provider-kit`)) return;
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
			"pi-provider-kit/index.ts",
		],
		{ cwd: packageRoot, stdio: "pipe" },
	);
});

test("all built-in preflight entrypoints expose loadable public extensions", async () => {
	const paths = [
		"preflight/charm-hyper.ts",
		"preflight/deepseek.ts",
		"preflight/google.ts",
		"preflight/openai-codex.ts",
		"preflight/opencode.ts",
		"preflight/opencode-go.ts",
	].map((path) => `${packageRoot}/${path}`);
	const result = await discoverAndLoadExtensions(paths, packageRoot, packageRoot);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, paths.length);
});

test("all built-in status entrypoints expose loadable public extensions", async () => {
	const paths = ["status/charm-hyper.ts", "status/deepseek.ts", "status/openai-codex.ts", "status/opencode-go.ts"].map(
		(path) => `${packageRoot}/${path}`,
	);
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
	assert.ok(!files.some((path) => path.startsWith("pi-provider-kit/")));
	assert.ok(!files.some((path) => path.startsWith("pi-provider/")));
	assert.ok(!files.some((path) => path.startsWith("test/")));
});
