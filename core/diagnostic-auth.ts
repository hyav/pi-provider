import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProviderDataError } from "./errors.ts";
import type { ProviderRequestAuth } from "./types.ts";

type DiagnosticModel = NonNullable<ExtensionContext["model"]>;
type ModelRegistry = ExtensionContext["modelRegistry"];

export interface DiagnosticModelRegistry {
	getApiKeyAndHeaders?: ModelRegistry["getApiKeyAndHeaders"];
	getApiKeyForProvider?: ModelRegistry["getApiKeyForProvider"];
}

export async function resolveDiagnosticAuth(
	model: DiagnosticModel,
	modelRegistry: DiagnosticModelRegistry,
): Promise<ProviderRequestAuth> {
	if (typeof modelRegistry.getApiKeyAndHeaders === "function") {
		const resolved = await modelRegistry.getApiKeyAndHeaders(model);
		if (!resolved.ok) throw new ProviderDataError(resolved.error, "auth");
		return {
			...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
			...(resolved.headers !== undefined ? { headers: { ...resolved.headers } } : {}),
			baseUrl: resolved.baseUrl ?? model.baseUrl,
			...(resolved.env !== undefined ? { env: { ...resolved.env } } : {}),
		};
	}

	const apiKey =
		typeof modelRegistry.getApiKeyForProvider === "function"
			? await modelRegistry.getApiKeyForProvider(model.provider)
			: undefined;
	return {
		...(apiKey !== undefined ? { apiKey } : {}),
		baseUrl: model.baseUrl,
	};
}

export function applyDiagnosticBaseUrl<T extends DiagnosticModel>(model: T, auth: ProviderRequestAuth): T {
	return auth.baseUrl !== undefined && auth.baseUrl !== model.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
}

/** Read full diagnostic auth, falling back to the legacy API-key accessor for direct adapter use. */
export async function getContextAuth(context: {
	getAuth?: () => Promise<ProviderRequestAuth>;
	getApiKey: () => Promise<string | undefined>;
	model?: { baseUrl?: string };
}): Promise<ProviderRequestAuth> {
	if (context.getAuth) return await context.getAuth();
	const apiKey = await context.getApiKey();
	return {
		...(apiKey !== undefined ? { apiKey } : {}),
		...(context.model?.baseUrl !== undefined ? { baseUrl: context.model.baseUrl } : {}),
	};
}

/** Test resolved headers case-insensitively, including explicit null removals. */
export function authDefinesHeader(auth: ProviderRequestAuth, name: string): boolean {
	const expected = name.toLowerCase();
	return Object.keys(auth.headers ?? {}).some((candidate) => candidate.toLowerCase() === expected);
}

/** Apply Pi-resolved request headers over adapter defaults. */
export function mergeDiagnosticHeaders(auth: ProviderRequestAuth, defaults: Record<string, string> = {}): Headers {
	const headers = new Headers(defaults);
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
	return headers;
}

function httpUrl(value: string | undefined): URL | undefined {
	if (!value) return undefined;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Match an effective model endpoint to a trusted origin; absent model context preserves direct adapter use. */
export function hasBaseUrlOrigin(baseUrl: string | undefined, expectedUrl: string): boolean {
	if (baseUrl === undefined) return true;
	const actual = httpUrl(baseUrl);
	const expected = httpUrl(expectedUrl);
	return actual !== undefined && expected !== undefined && actual.origin === expected.origin;
}

/** Resolve a provider-relative diagnostic path without changing the effective endpoint origin. */
export function appendBaseUrlPath(
	baseUrl: string | undefined,
	path: string,
	fallbackBaseUrl?: string,
): string | undefined {
	const parsed = httpUrl(baseUrl) ?? httpUrl(fallbackBaseUrl);
	if (!parsed) return undefined;
	const suffix = path.replace(/^\/+/, "");
	parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/${suffix}`;
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
}
