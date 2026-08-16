import { homedir } from "node:os";
import { join } from "node:path";
import { isValidTimeoutMs } from "./deadline.ts";
import type { PiProviderDefinition } from "./definition.ts";
import { getDefaultOpenRouterMetadataCachePath, OPENROUTER_MODELS_URL } from "./official-pricing.ts";
import { validatePricingPolicy } from "./pricing-adjustments.ts";
import type { ProviderPricingPolicy, StoredCredentialLike } from "./types.ts";

export interface PiProviderDependencies {
	fetch: typeof globalThis.fetch;
	now: () => number;
	modelDiscoveryTimeoutMs: number;
	statusRequestTimeoutMs: number;
	liveCheckRequestTimeoutMs: number;
	officialPricingUrl: string;
	officialPricingTimeoutMs: number;
	officialPricingCacheTtlMs: number;
	officialPricingMaxStaleMs: number;
	/** Resolved Pi agent directory; empty disables disk persistence of pricing metadata. */
	agentDir: string;
	/** Persistent cache for OpenRouter metadata used by the pricing fallback. */
	openRouterMetadataCachePath: string;
	/** Read Pi's stored credential metadata; injected by the Pi entrypoint. */
	readStoredCredential: (providerId: string) => StoredCredentialLike | undefined;
	/** Wrap ANSI-aware text to a render width; injected by the Pi entrypoint. */
	wrapTextWithAnsi: (text: string, width: number) => string[];
	enableOfficialPricingFallback: boolean;
	/** Optional Pi Provider-level price policies keyed by Provider ID. */
	pricingPolicies?: Record<string, ProviderPricingPolicy>;
}

export type PiProviderLoader = (runtime: PiProviderDependencies) => Promise<PiProviderDefinition>;

/**
 * Resolve Pi's agent directory without importing Pi's bundled packages, so the
 * Jiti module graph and programmatic consumers share the same default. Mirrors
 * Pi's `getAgentDir()`: `PI_CODING_AGENT_DIR` wins, `~/` expands to the home
 * directory, and the fallback is `~/.pi/agent`.
 */
export function resolveDefaultAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const raw =
		configured !== undefined && configured.trim() !== "" ? configured.trim() : join(homedir(), ".pi", "agent");
	if (raw === "~") return homedir();
	if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
	return raw;
}

/** Degraded fallback used only when the Pi entrypoint does not inject the real wrapper. */
const WIDE_CHAR_RANGES: Array<[number, number]> = [
	[0x1100, 0x115f],
	[0x2329, 0x232a],
	[0x2e80, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe4f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f64f],
	[0x1f900, 0x1f9ff],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];

function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		const wide = WIDE_CHAR_RANGES.some(([start, end]) => code >= start && code <= end);
		width += wide ? 2 : 1;
	}
	return width;
}

function defaultWrapTextWithAnsi(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
	if (displayWidth(plain) <= width) return [text];
	const chunks: string[] = [];
	let chunk = "";
	for (const ch of plain) {
		if (chunk !== "" && displayWidth(chunk) + displayWidth(ch) > width) {
			chunks.push(chunk);
			chunk = ch;
		} else {
			chunk += ch;
		}
	}
	if (chunk !== "") chunks.push(chunk);
	return chunks;
}

type DefaultDependencies = Omit<PiProviderDependencies, "agentDir" | "openRouterMetadataCachePath">;

const defaultDependencies: DefaultDependencies = {
	fetch: globalThis.fetch,
	now: Date.now,
	modelDiscoveryTimeoutMs: 3_000,
	statusRequestTimeoutMs: 8_000,
	liveCheckRequestTimeoutMs: 8_000,
	officialPricingUrl: OPENROUTER_MODELS_URL,
	officialPricingTimeoutMs: 3_000,
	officialPricingCacheTtlMs: 60 * 60 * 1_000,
	officialPricingMaxStaleMs: 24 * 60 * 60 * 1_000,
	readStoredCredential: () => undefined,
	wrapTextWithAnsi: defaultWrapTextWithAnsi,
	enableOfficialPricingFallback: true,
	pricingPolicies: {},
};

/**
 * Programmatic defaults keep the resolved agent directory and its pricing cache
 * path. The Pi entrypoint overrides `agentDir` with Pi's own resolution.
 */
export function getDefaultPiProviderDependencies(agentDir = resolveDefaultAgentDir()): PiProviderDependencies {
	return {
		...defaultDependencies,
		agentDir,
		openRouterMetadataCachePath: getDefaultOpenRouterMetadataCachePath(agentDir),
	};
}

export function validatePiProviderDependencies(runtime: PiProviderDependencies): void {
	if (typeof runtime.fetch !== "function") throw new Error("Pi Provider fetch must be a function");
	if (typeof runtime.now !== "function") throw new Error("Pi Provider now must be a function");
	for (const [name, value] of [
		["modelDiscoveryTimeoutMs", runtime.modelDiscoveryTimeoutMs],
		["statusRequestTimeoutMs", runtime.statusRequestTimeoutMs],
		["liveCheckRequestTimeoutMs", runtime.liveCheckRequestTimeoutMs],
		["officialPricingTimeoutMs", runtime.officialPricingTimeoutMs],
	] as const) {
		if (!isValidTimeoutMs(value)) throw new Error(`Pi Provider ${name} must be a valid timeout`);
	}
	for (const [name, value] of [
		["officialPricingCacheTtlMs", runtime.officialPricingCacheTtlMs],
		["officialPricingMaxStaleMs", runtime.officialPricingMaxStaleMs],
	] as const) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error(`Pi Provider ${name} must be a finite non-negative number`);
		}
	}
	if (typeof runtime.officialPricingUrl !== "string" || runtime.officialPricingUrl.trim() === "") {
		throw new Error("Pi Provider officialPricingUrl must be a non-empty string");
	}
	if (typeof runtime.openRouterMetadataCachePath !== "string") {
		throw new Error("Pi Provider openRouterMetadataCachePath must be a string");
	}
	if (typeof runtime.readStoredCredential !== "function") {
		throw new Error("Pi Provider readStoredCredential must be a function");
	}
	if (typeof runtime.wrapTextWithAnsi !== "function") {
		throw new Error("Pi Provider wrapTextWithAnsi must be a function");
	}
	if (typeof runtime.enableOfficialPricingFallback !== "boolean") {
		throw new Error("Pi Provider enableOfficialPricingFallback must be a boolean");
	}
	if (runtime.pricingPolicies !== undefined) {
		if (
			runtime.pricingPolicies === null ||
			typeof runtime.pricingPolicies !== "object" ||
			Array.isArray(runtime.pricingPolicies)
		) {
			throw new Error("Pi Provider pricingPolicies must be an object");
		}
		for (const [providerId, policy] of Object.entries(runtime.pricingPolicies)) {
			if (providerId.trim() === "") throw new Error("Pi Provider pricingPolicies has an empty Provider ID");
			validatePricingPolicy(policy, `Pi Provider pricingPolicies.${providerId}`);
		}
	}
}

export function resolvePiProviderDependencies(
	dependencies: Partial<PiProviderDependencies> = {},
): PiProviderDependencies {
	const runtime = { ...getDefaultPiProviderDependencies(), ...dependencies };
	if (runtime.pricingPolicies === undefined) runtime.pricingPolicies = {};
	validatePiProviderDependencies(runtime);
	return runtime;
}
