import type { StatusAdapter, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";
import { hyperJsonHeaders } from "../providers/charm-hyper/constants.ts";

const CREDITS_URL = "https://hyper.charm.land/v1/credits";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseHyperTeamName(credential: unknown): string | undefined {
	if (credential === null || typeof credential !== "object" || Array.isArray(credential)) return undefined;
	const value = credential as Record<string, unknown>;
	if (value.type !== "oauth" || typeof value.teamName !== "string") return undefined;
	const teamName = value.teamName.trim();
	if (teamName === "" || teamName.length > 256 || /[\u0000-\u001f\u007f]/.test(teamName)) return undefined;
	return teamName;
}

export const hyperStatusAdapter: StatusAdapter = {
	id: "charm-hyper-status",
	providerId: "charm-hyper",
	name: "Charm Hyper",
	cacheTtlMs: 60_000,
	requestTimeoutMs: 8_000,
	async fetch(context): Promise<StatusSnapshot> {
		const key = await context.getApiKey();
		const headers = new Headers(hyperJsonHeaders({ "Accept-Encoding": "identity" }));
		if (key && key !== "proxy-managed") headers.set("Authorization", `Bearer ${key}`);
		const response = await context.fetch(CREDITS_URL, { headers, signal: context.signal });
		if (!response.ok) {
			throw new ProviderDataError(
				`Charm Hyper status failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ProviderDataError("Charm Hyper status returned invalid JSON", "badjson");
		}
		if (
			!isRecord(payload) ||
			Object.keys(payload).some((key) => key !== "balance") ||
			typeof payload.balance !== "number" ||
			!Number.isFinite(payload.balance)
		) {
			throw new ProviderDataError("Charm Hyper status returned an invalid balance", "badjson");
		}
		const teamName = parseHyperTeamName(context.getCredentialMetadata?.());
		return {
			entries: [
				...(teamName ? [{ kind: "text" as const, id: "team", label: "Team", value: teamName }] : []),
				{ kind: "amount", id: "balance", label: "Balance", value: payload.balance, unit: "credits" },
			],
			updatedAt: context.now(),
		};
	},
};

export function createCharmHyperStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...hyperStatusAdapter, requestTimeoutMs };
}

const charmHyperStatusExtension = defineStatusExtension({
	id: "charm-hyper-status",
	providerId: "charm-hyper",
	create: ({ statusRequestTimeoutMs }) => createCharmHyperStatusAdapter(statusRequestTimeoutMs),
});

export default charmHyperStatusExtension;
