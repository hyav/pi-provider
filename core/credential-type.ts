/** Non-secret credential type shared across the Status and Preflight managers. */

export function deriveCredentialType(metadata: unknown): string | undefined {
	try {
		if (metadata !== null && typeof metadata === "object" && "type" in metadata) {
			const value = (metadata as { type?: unknown }).type;
			return typeof value === "string" ? value : undefined;
		}
	} catch {
		// Credential metadata must never break status or preflight rendering.
	}
	return undefined;
}
