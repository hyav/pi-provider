import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const adapterDirectories = ["providers", "status", "preflight", "tuners"] as const;
const defaultPackageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
/** Jiti-safe module that adapter files reach through the `@hyav/pi-provider` alias. */
const publicAdaptersPath = join(defaultPackageRoot, "core", "public-adapters.ts");

type AdapterExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export interface AdapterRootOptions {
	/** Package root containing built-in adapters; defaults to this package. */
	packageRoot?: string;
	/** Pi's resolved agent directory; user adapters are discovered under `<agentDir>/extensions/pi-provider`. */
	agentDir?: string;
	/** Explicit user adapter root; replaces the agentDir-based default when provided. */
	userRoot?: string;
}

/** Built-in adapters always load first; user adapters load last so they can override. */
export function resolveAdapterRoots(options: AdapterRootOptions): string[] {
	const { packageRoot, agentDir, userRoot } = options;
	const defaultUserRoot =
		agentDir !== undefined && agentDir !== "" ? join(agentDir, "extensions", "pi-provider") : undefined;
	const resolvedUserRoot = userRoot ?? defaultUserRoot;
	const roots = [packageRoot ?? defaultPackageRoot];
	if (resolvedUserRoot !== undefined) roots.push(resolvedUserRoot);
	return roots;
}

/**
 * Jiti's module cache is Node's global `require.cache`, so a reload would
 * otherwise reuse previously loaded adapter modules without reading the disk.
 * Drop every cached module under the adapter roots before each load so edits
 * to existing adapter files take effect on `/reload`.
 */
function clearAdapterModuleCache(roots: string[]): void {
	const require = createRequire(import.meta.url);
	for (const key of Object.keys(require.cache)) {
		if (roots.some((root) => key.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) {
			delete require.cache[key];
		}
	}
}

function isAdapterFile(name: string): boolean {
	if (name.endsWith(".d.ts")) return false;
	return extname(name) === ".ts" || extname(name) === ".js";
}

function warnAdapterLoadIssue(path: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.warn(`[pi-provider] failed to load adapter extension ${JSON.stringify(path)}: ${message}`);
}

async function discoverAdapterPaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	for (const directory of adapterDirectories) {
		let entries: Dirent[];
		try {
			entries = await readdir(join(root, directory), { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			if (entry.isFile() && isAdapterFile(entry.name)) paths.push(join(root, directory, entry.name));
		}
	}
	return paths.sort();
}

export async function loadPackageAdapterExtensions(pi: ExtensionAPI, options: AdapterRootOptions = {}): Promise<void> {
	const roots = resolveAdapterRoots(options);
	clearAdapterModuleCache(roots);
	const jiti = createJiti(import.meta.url, {
		moduleCache: true,
		tryNative: false,
		alias: { "@hyav/pi-provider": publicAdaptersPath },
	});
	for (const root of roots) {
		for (const path of await discoverAdapterPaths(root)) {
			try {
				const factory = (await jiti.import(path, { default: true })) as unknown;
				if (typeof factory !== "function") {
					throw new TypeError("default export must be a Pi extension factory");
				}
				await (factory as AdapterExtensionFactory)(pi);
			} catch (error) {
				warnAdapterLoadIssue(relative(root, path).replaceAll("\\", "/"), error);
			}
		}
	}
}
