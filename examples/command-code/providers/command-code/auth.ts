import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeText(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001f\u007f]/.test(value);
}

function extractKeyFromRecord(record: Record<string, unknown>): string | undefined {
	const candidates = [
		record.apiKey,
		record.api_key,
		record.token,
		record.access_token,
		record.accessToken,
		record.key,
		record.jwt,
		record.secret,
	];

	for (const candidate of candidates) {
		if (isSafeText(candidate)) {
			return candidate.trim();
		}
	}

	const nestedObjects = [
		record.auth,
		record.credentials,
		record.tokens,
		record.default,
		record.current_profile,
		record.profiles,
	];

	for (const nested of nestedObjects) {
		if (isRecord(nested)) {
			const nestedKey = extractKeyFromRecord(nested);
			if (nestedKey) return nestedKey;
		}
	}

	return undefined;
}

export function resolveCommandCodeApiKey(): string | undefined {
	// 1. Check all possible environment variable aliases
	const envVars = [
		process.env.COMMAND_CODE_API_KEY,
		process.env.CMD_API_KEY,
		process.env.COMMANDCODE_API_KEY,
		process.env.CMD_KEY,
		process.env.COMMAND_CODE_KEY,
		process.env.COMMANDCODE_KEY,
	];

	for (const val of envVars) {
		if (isSafeText(val)) {
			const trimmed = val.trim();
			syncCommandCodeEnv(trimmed);
			return trimmed;
		}
	}

	// 2. Priority: Local config/auth files in user home directory
	const homeDir = os.homedir();
	const candidatePaths = [
		path.join(homeDir, ".commandcode", "auth.json"),
		path.join(homeDir, ".commandcode", "config.json"),
		path.join(homeDir, ".commandcode", "credentials.json"),
		path.join(homeDir, ".config", "commandcode", "auth.json"),
		path.join(homeDir, ".config", "commandcode", "config.json"),
		path.join(homeDir, ".config", "commandcode", "credentials.json"),
		path.join(homeDir, ".config", "command-code", "auth.json"),
		path.join(homeDir, ".config", "command-code", "config.json"),
		path.join(homeDir, ".config", "command-code", "credentials.json"),
		path.join(homeDir, ".command-code", "auth.json"),
		path.join(homeDir, ".command-code", "config.json"),
		path.join(homeDir, ".command-code", "credentials.json"),
	];

	for (const candidate of candidatePaths) {
		try {
			if (!fs.existsSync(candidate)) continue;
			const content = fs.readFileSync(candidate, "utf8");
			const json = JSON.parse(content);
			if (typeof json === "string" && isSafeText(json)) {
				const key = json.trim();
				syncCommandCodeEnv(key);
				return key;
			}
			if (isRecord(json)) {
				const key = extractKeyFromRecord(json);
				if (key) {
					syncCommandCodeEnv(key);
					return key;
				}
			}
		} catch {
			// Ignore file read or parse issues
		}
	}

	return undefined;
}

/**
 * Synchronizes the resolved key into all common environment variable names
 * so Pi and downstream tools find it regardless of which alias is inspected.
 */
export function syncCommandCodeEnv(key?: string): string | undefined {
	const resolvedKey = key || resolveCommandCodeApiKey();
	if (resolvedKey) {
		if (!process.env.COMMAND_CODE_API_KEY) {
			process.env.COMMAND_CODE_API_KEY = resolvedKey;
		}
		if (!process.env.CMD_API_KEY) {
			process.env.CMD_API_KEY = resolvedKey;
		}
		if (!process.env.COMMANDCODE_API_KEY) {
			process.env.COMMANDCODE_API_KEY = resolvedKey;
		}
	}
	return resolvedKey;
}

// Auto-sync on module load
syncCommandCodeEnv();
