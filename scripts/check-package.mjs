import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-provider-artifact-"));
const nestedNpmEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_dry_run"),
);
nestedNpmEnvironment.npm_config_dry_run = "false";

const requiredFiles = [
	"index.ts",
	"providers/charm-hyper.ts",
	"preflight/charm-hyper.ts",
	"preflight/deepseek.ts",
	"preflight/google.ts",
	"preflight/openai-codex.ts",
	"preflight/opencode.ts",
	"preflight/opencode-go.ts",
	"status/charm-hyper.ts",
	"status/deepseek.ts",
	"status/openai-codex.ts",
	"status/opencode-go.ts",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"SECURITY.md",
	"SUPPORT.md",
	"LICENSE",
];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function run() {
	if (!existsSync(join(repositoryRoot, "node_modules"))) {
		throw new Error("node_modules is missing; run npm ci before checking the package artifact");
	}

	const repositoryPackage = readJson(join(repositoryRoot, "package.json"));
	const output = execFileSync("npm", ["pack", "--pack-destination", temporaryRoot, "--json", "--dry-run=false"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: nestedNpmEnvironment,
	});
	const metadata = JSON.parse(output)[0];
	if (!metadata?.filename || !Array.isArray(metadata.files)) throw new Error("npm pack returned invalid metadata");

	const artifactFiles = metadata.files.map(({ path }) => path);
	for (const file of requiredFiles) {
		if (!artifactFiles.includes(file)) throw new Error(`npm artifact is missing ${file}`);
	}
	const forbiddenPrefixes = ["test/", "scripts/", "pi-provider/", "docs/", "node_modules/"];
	for (const file of artifactFiles) {
		if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
			throw new Error(`npm artifact contains private or repository-only path ${file}`);
		}
		if (file.includes(".DS_Store") || file.endsWith(".tgz")) {
			throw new Error(`npm artifact contains local/generated state ${file}`);
		}
	}

	const archivePath = join(temporaryRoot, metadata.filename);
	const consumerRoot = join(temporaryRoot, "consumer");
	mkdirSync(consumerRoot);
	writeFileSync(
		join(consumerRoot, "package.json"),
		`${JSON.stringify({ name: "pi-provider-artifact-consumer", private: true, type: "module" })}\n`,
	);
	const peerNames = Object.keys(repositoryPackage.peerDependencies ?? {});
	for (const name of peerNames) {
		const testedVersion = repositoryPackage.devDependencies?.[name];
		const source = join(repositoryRoot, "node_modules", name);
		if (!testedVersion || !existsSync(source)) {
			throw new Error(`tested peer dependency ${name} is missing; run npm ci`);
		}
		if (readJson(join(source, "package.json")).version !== testedVersion) {
			throw new Error(`installed ${name} does not match tested version ${testedVersion}`);
		}
	}

	execFileSync(
		"npm",
		[
			"--prefix",
			consumerRoot,
			"install",
			"--offline",
			"--legacy-peer-deps",
			"--ignore-scripts",
			"--no-package-lock",
			"--no-save",
			"--no-fund",
			"--no-audit",
			archivePath,
		],
		{ stdio: "pipe", env: nestedNpmEnvironment },
	);

	for (const name of peerNames) {
		const source = join(repositoryRoot, "node_modules", name);
		const target = join(consumerRoot, "node_modules", name);
		mkdirSync(dirname(target), { recursive: true });
		symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
	}

	const packageRoot = join(consumerRoot, "node_modules", repositoryPackage.name);
	const packageJson = readJson(join(packageRoot, "package.json"));
	if (packageJson.name !== repositoryPackage.name || packageJson.version !== repositoryPackage.version) {
		throw new Error("installed artifact identity does not match repository metadata");
	}
	const rootExport = packageJson.exports?.["."];
	if (typeof rootExport !== "string" || !existsSync(join(packageRoot, rootExport))) {
		throw new Error("npm artifact has no existing root export target");
	}
	if (JSON.stringify(packageJson.pi?.extensions) !== JSON.stringify(["./index.ts"])) {
		throw new Error("npm artifact has an unexpected Pi extension manifest");
	}

	const paths = [join(packageRoot, "index.ts")];
	return discoverAndLoadExtensions(paths, packageRoot, packageRoot).then((result) => {
		if (result.errors.length > 0) {
			throw new Error(`published Pi entry points failed to load: ${JSON.stringify(result.errors)}`);
		}
		if (result.extensions.length !== paths.length) {
			throw new Error(`expected ${paths.length} published Pi entry points, loaded ${result.extensions.length}`);
		}
		if (!result.runtime.pendingProviderRegistrations.some(({ name }) => name === "charm-hyper")) {
			throw new Error("published root entrypoint did not load the built-in Charm Hyper Provider Adapter");
		}
		console.log(
			`artifact ok: ${metadata.filename} (${artifactFiles.length} files, ${result.extensions.length} Pi entry points)`,
		);
	});
}

try {
	await run();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
