import { validateAdapter } from "./adapter-validation.ts";
import type { PreflightAdapter } from "./preflight-manager.ts";
import type { ProviderAdapter, StatusAdapter, TunerAdapter } from "./types.ts";

export interface PiProviderDefinition {
	providers: ProviderAdapter[];
	statuses?: StatusAdapter[];
	preflights?: PreflightAdapter[];
	tuners?: TunerAdapter[];
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function rejectDuplicate(ids: Set<string>, id: string, label: string): void {
	if (ids.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
	ids.add(id);
}

/**
 * Validate a complete, programmatically assembled definition.
 *
 * Dynamic Hosts use the same adapter validators while resolving conflicts, but
 * keep invalid entries isolated instead of failing the whole registry.
 */
export function validatePiProviderDefinition(value: unknown): asserts value is PiProviderDefinition {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Pi Provider definition must be an object");
	}
	const definition = value as Partial<PiProviderDefinition>;
	assertArray(definition.providers, "Pi Provider definition providers");
	if (definition.statuses !== undefined) assertArray(definition.statuses, "Pi Provider definition statuses");
	if (definition.preflights !== undefined) assertArray(definition.preflights, "Pi Provider definition preflights");
	if (definition.tuners !== undefined) assertArray(definition.tuners, "Pi Provider definition tuners");

	const providerIds = new Set<string>();
	for (const adapter of definition.providers) {
		validateAdapter("provider", adapter);
		rejectDuplicate(providerIds, adapter.id, "provider adapter ID");
	}

	const statusIds = new Set<string>();
	const statusProviders = new Set<string>();
	for (const adapter of definition.statuses ?? []) {
		validateAdapter("status", adapter);
		rejectDuplicate(statusIds, adapter.id, "status adapter ID");
		rejectDuplicate(statusProviders, adapter.providerId, "status adapter provider ID");
	}

	const preflightIds = new Set<string>();
	const preflightProviders = new Set<string>();
	for (const adapter of definition.preflights ?? []) {
		validateAdapter("preflight", adapter);
		rejectDuplicate(preflightIds, adapter.id, "preflight adapter ID");
		rejectDuplicate(preflightProviders, adapter.providerId, "preflight adapter provider ID");
	}

	const tunerIds = new Set<string>();
	for (const adapter of definition.tuners ?? []) {
		validateAdapter("tuner", adapter);
		rejectDuplicate(tunerIds, adapter.id, "tuner adapter ID");
	}
}
