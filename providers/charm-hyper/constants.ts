import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageIdentity = parsePackageIdentity(require("../../package.json"));

export const HYPER_ROOT_URL = "https://hyper.charm.land";
export const HYPER_BASE_URL = `${HYPER_ROOT_URL}/v1`;
export const HYPER_USER_AGENT = `${packageIdentity.name}/${packageIdentity.version}`;

export function hyperJsonHeaders(headers: Record<string, string> = {}): Record<string, string> {
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		"User-Agent": HYPER_USER_AGENT,
		...headers,
	};
}

function parsePackageIdentity(value: unknown): { name: string; version: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("@hyav/pi-provider package.json must contain an object");
	}
	const packageJson = value as Record<string, unknown>;
	if (typeof packageJson.name !== "string" || packageJson.name.trim() === "") {
		throw new Error("@hyav/pi-provider package.json must contain a name");
	}
	if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
		throw new Error("@hyav/pi-provider package.json must contain a version");
	}
	return { name: packageJson.name, version: packageJson.version };
}
