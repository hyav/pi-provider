import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPackageAdapterExtensions } from "./adapter-loader.ts";
import { createPiProviderHost } from "./host.ts";
import type { PiProviderDependencies } from "./runtime-config.ts";
import type { StoredCredentialLike } from "./types.ts";

/** Runtime values resolved by the Pi-loaded entrypoint and injected into the Jiti graph. */
export interface PiProviderEntry {
	agentDir: string;
	readStoredCredential: (providerId: string) => StoredCredentialLike | undefined;
	wrapTextWithAnsi: (text: string, width: number) => string[];
	adapterRoot?: string;
	dependencies?: Partial<PiProviderDependencies>;
}

/** Runs the Pi Provider host and adapter discovery inside a single Jiti module graph. */
export async function runPiProviderEntry(pi: ExtensionAPI, entry: PiProviderEntry): Promise<void> {
	const piProviderHost = createPiProviderHost({
		agentDir: entry.agentDir,
		readStoredCredential: entry.readStoredCredential,
		wrapTextWithAnsi: entry.wrapTextWithAnsi,
		...entry.dependencies,
	});
	piProviderHost(pi);
	await loadPackageAdapterExtensions(pi, { agentDir: entry.agentDir, userRoot: entry.adapterRoot });
}
