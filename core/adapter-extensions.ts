import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AdapterKind,
	type AdapterRegistrationEnvelope,
	PI_PROVIDER_ADAPTER_EVENT,
	PI_PROVIDER_ADAPTER_PROTOCOL_VERSION,
	PI_PROVIDER_STARTUP_BRIDGE_EVENT,
	type StartupBridge,
	type StartupBridgeRequest,
} from "./adapter-protocol.ts";
import { isStableAdapterId, validateAdapter, validateAdapterIdentity } from "./adapter-validation.ts";
import type { PreflightAdapter } from "./preflight-manager.ts";
import { registerProviderAdapter } from "./provider-registration.ts";
import type { PiProviderDependencies } from "./runtime-config.ts";
import { getDefaultPiProviderDependencies } from "./runtime-config.ts";
import type { ProviderAdapter, StatusAdapter, TunerAdapter } from "./types.ts";

/** Context supplied to an Adapter Extension factory. */
export interface AdapterExtensionContext extends PiProviderDependencies {
	/** The Pi API that owns this extension factory. */
	pi: ExtensionAPI;
}

export interface ProviderExtensionDefinition {
	id: string;
	create(context: AdapterExtensionContext): ProviderAdapter | Promise<ProviderAdapter>;
}

export interface StatusExtensionDefinition {
	id: string;
	providerId: string;
	create(context: AdapterExtensionContext): StatusAdapter | Promise<StatusAdapter>;
}

export interface PreflightExtensionDefinition {
	id: string;
	providerId: string;
	create(context: AdapterExtensionContext): PreflightAdapter | Promise<PreflightAdapter>;
}

export interface TunerExtensionDefinition {
	id: string;
	create(context: AdapterExtensionContext): TunerAdapter | Promise<TunerAdapter>;
}

function validateStaticIdentity(kind: AdapterKind, id: string, providerId?: string): void {
	if (!isStableAdapterId(id)) throw new Error(`${kind} static ID must be a non-empty ID without whitespace`);
	if ((kind === "status" || kind === "preflight") && !isStableAdapterId(providerId)) {
		throw new Error(`${kind} static provider ID must be a non-empty ID without whitespace`);
	}
}

function getStartupBridge(pi: ExtensionAPI): StartupBridge {
	const request: StartupBridgeRequest = {};
	pi.events.emit(PI_PROVIDER_STARTUP_BRIDGE_EVENT, request);
	return (
		request.bridge ?? {
			dependencies: getDefaultPiProviderDependencies(),
			officialPricing: Promise.resolve({}),
		}
	);
}

function emitRegistration(pi: ExtensionAPI, envelope: AdapterRegistrationEnvelope): void {
	pi.events.emit(PI_PROVIDER_ADAPTER_EVENT, envelope);
	pi.on("session_start", () => {
		pi.events.emit(PI_PROVIDER_ADAPTER_EVENT, envelope);
	});
}

function createAdapterExtension<TAdapter extends ProviderAdapter | StatusAdapter | PreflightAdapter | TunerAdapter>(
	kind: AdapterKind,
	id: string,
	providerId: string | undefined,
	create: (context: AdapterExtensionContext) => TAdapter | Promise<TAdapter>,
): (pi: ExtensionAPI) => Promise<void> {
	validateStaticIdentity(kind, id, providerId);
	const token = {};
	return async (pi) => {
		const bridge = getStartupBridge(pi);
		const createAdapter = (context: AdapterExtensionContext) => create(context);
		const adapter = await createAdapter({ ...bridge.dependencies, pi });
		if (kind === "provider") {
			const providerAdapter = adapter as ProviderAdapter;
			validateAdapter("provider", providerAdapter);
			validateAdapterIdentity("provider", id, providerAdapter);
			const modelDrafts = providerAdapter.provider.models;
			// The startup registration is intentionally independent of Host
			// acknowledgement. Host re-registers the accepted catalog after the
			// session_start barrier with official pricing and conflict resolution.
			// Keep the pre-normalization drafts in the plain event envelope: the
			// Host runs in a different Pi module context and cannot use this
			// extension's module-local state. The factory is retained so a Host
			// loaded later can recreate the adapter with its configured runtime.
			registerProviderAdapter(pi, providerAdapter, bridge.dependencies, {}, modelDrafts);
			emitRegistration(pi, {
				version: PI_PROVIDER_ADAPTER_PROTOCOL_VERSION,
				kind: "provider",
				id,
				token,
				adapter: providerAdapter,
				factory: createAdapter,
				startupDependencies: bridge.dependencies,
				modelDrafts,
			});
			return;
		}
		if (kind === "status") {
			const statusAdapter = adapter as StatusAdapter;
			validateAdapter("status", statusAdapter);
			validateAdapterIdentity("status", id, providerId, statusAdapter);
			emitRegistration(pi, {
				version: PI_PROVIDER_ADAPTER_PROTOCOL_VERSION,
				kind: "status",
				id,
				providerId: providerId!,
				token,
				adapter: statusAdapter,
				factory: createAdapter,
				startupDependencies: bridge.dependencies,
			});
			return;
		}
		if (kind === "preflight") {
			const preflightAdapter = adapter as PreflightAdapter;
			validateAdapter("preflight", preflightAdapter);
			validateAdapterIdentity("preflight", id, providerId, preflightAdapter);
			emitRegistration(pi, {
				version: PI_PROVIDER_ADAPTER_PROTOCOL_VERSION,
				kind: "preflight",
				id,
				providerId: providerId!,
				token,
				adapter: preflightAdapter,
				factory: createAdapter,
				startupDependencies: bridge.dependencies,
			});
			return;
		}
		const tunerAdapter = adapter as TunerAdapter;
		validateAdapter("tuner", tunerAdapter);
		validateAdapterIdentity("tuner", id, tunerAdapter);
		emitRegistration(pi, {
			version: PI_PROVIDER_ADAPTER_PROTOCOL_VERSION,
			kind: "tuner",
			id,
			token,
			adapter: tunerAdapter,
			factory: createAdapter,
			startupDependencies: bridge.dependencies,
		});
	};
}

/** Define a Pi extension factory that contributes one Provider Adapter. */
export function defineProviderExtension(definition: ProviderExtensionDefinition): (pi: ExtensionAPI) => Promise<void> {
	return createAdapterExtension("provider", definition.id, undefined, definition.create);
}

/** Define a Pi extension factory that contributes one Status Adapter. */
export function defineStatusExtension(definition: StatusExtensionDefinition): (pi: ExtensionAPI) => Promise<void> {
	return createAdapterExtension("status", definition.id, definition.providerId, definition.create);
}

/** Define a Pi extension factory that contributes one Preflight Adapter. */
export function definePreflightExtension(
	definition: PreflightExtensionDefinition,
): (pi: ExtensionAPI) => Promise<void> {
	return createAdapterExtension("preflight", definition.id, definition.providerId, definition.create);
}

/** Define a Pi extension factory that contributes one Tuner Adapter. */
export function defineTunerExtension(definition: TunerExtensionDefinition): (pi: ExtensionAPI) => Promise<void> {
	return createAdapterExtension("tuner", definition.id, undefined, definition.create);
}
