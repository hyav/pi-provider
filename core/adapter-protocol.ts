import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OfficialModelMeta } from "./official-pricing.ts";
import type { PreflightAdapter } from "./preflight-manager.ts";
import type { PiProviderDependencies } from "./runtime-config.ts";
import type { ProviderAdapter, ProviderModelDraft, StatusAdapter, TunerAdapter } from "./types.ts";

/** Registration protocol version shared by Host and Adapter Extensions. */
export const PI_PROVIDER_ADAPTER_PROTOCOL_VERSION = 2 as const;

/** Event-bus channel used for Adapter Extension registration envelopes. */
export const PI_PROVIDER_ADAPTER_EVENT = "pi-provider:adapter";

/** Event-bus channel used by the Host to expose the factory-stage startup bridge. */
export const PI_PROVIDER_STARTUP_BRIDGE_EVENT = "pi-provider:startup-bridge";

/** Event-bus channel used to detect more than one Pi Provider Host. */
export const PI_PROVIDER_HOST_CLAIM_EVENT = "pi-provider:host-claim";

export type AdapterKind = "provider" | "status" | "preflight" | "tuner";

export interface AdapterFactoryContext extends PiProviderDependencies {
	pi: ExtensionAPI;
}

export type AdapterFactory = (
	context: AdapterFactoryContext,
) =>
	| ProviderAdapter
	| StatusAdapter
	| PreflightAdapter
	| TunerAdapter
	| Promise<ProviderAdapter | StatusAdapter | PreflightAdapter | TunerAdapter>;

export interface AdapterRegistrationEnvelopeBase {
	version: typeof PI_PROVIDER_ADAPTER_PROTOCOL_VERSION;
	kind: AdapterKind;
	id: string;
	token: object;
	/** Factory retained for Host-side rehydration when Host loaded after Adapter. */
	factory: AdapterFactory;
	/** Exact dependency object used by the initial factory invocation. */
	startupDependencies: PiProviderDependencies;
}

export interface ProviderAdapterRegistrationEnvelope extends AdapterRegistrationEnvelopeBase {
	kind: "provider";
	adapter: ProviderAdapter;
	/** Original model drafts, before the startup catalog is normalized. */
	modelDrafts?: ProviderModelDraft[];
}

export interface StatusAdapterRegistrationEnvelope extends AdapterRegistrationEnvelopeBase {
	kind: "status";
	providerId: string;
	adapter: StatusAdapter;
}

export interface PreflightAdapterRegistrationEnvelope extends AdapterRegistrationEnvelopeBase {
	kind: "preflight";
	providerId: string;
	adapter: PreflightAdapter;
}

export interface TunerAdapterRegistrationEnvelope extends AdapterRegistrationEnvelopeBase {
	kind: "tuner";
	adapter: TunerAdapter;
}

export type AdapterRegistrationEnvelope =
	| ProviderAdapterRegistrationEnvelope
	| StatusAdapterRegistrationEnvelope
	| PreflightAdapterRegistrationEnvelope
	| TunerAdapterRegistrationEnvelope;

export interface StartupBridge {
	dependencies: PiProviderDependencies;
	officialPricing: Promise<Record<string, OfficialModelMeta>>;
}

export interface StartupBridgeRequest {
	bridge?: StartupBridge;
}

export interface HostClaimRequest {
	token: object;
	occupied: boolean;
}

export function isHostClaimRequest(value: unknown): value is HostClaimRequest {
	return (
		value !== null &&
		typeof value === "object" &&
		"token" in value &&
		(value as { token?: unknown }).token !== null &&
		typeof (value as { token?: unknown }).token === "object" &&
		"occupied" in value &&
		typeof (value as { occupied?: unknown }).occupied === "boolean"
	);
}

export function isAdapterRegistrationEnvelope(value: unknown): value is AdapterRegistrationEnvelope {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Partial<AdapterRegistrationEnvelope>;
	return (
		candidate.version === PI_PROVIDER_ADAPTER_PROTOCOL_VERSION &&
		(candidate.kind === "provider" ||
			candidate.kind === "status" ||
			candidate.kind === "preflight" ||
			candidate.kind === "tuner") &&
		typeof candidate.id === "string" &&
		candidate.token !== null &&
		typeof candidate.token === "object" &&
		typeof candidate.factory === "function" &&
		candidate.startupDependencies !== null &&
		typeof candidate.startupDependencies === "object" &&
		candidate.adapter !== null &&
		typeof candidate.adapter === "object" &&
		(candidate.kind !== "provider" || candidate.modelDrafts === undefined || Array.isArray(candidate.modelDrafts))
	);
}
