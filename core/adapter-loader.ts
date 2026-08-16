import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const adapterDirectories = ["providers", "status", "preflight", "tuners"] as const;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type AdapterExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

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

export async function loadPackageAdapterExtensions(pi: ExtensionAPI, root: string = packageRoot): Promise<void> {
	const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
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
