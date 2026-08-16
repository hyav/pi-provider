import type { StatusAdapter, StatusEntry, StatusSnapshot } from "@hyav/pi-provider";
import { defineStatusExtension, ProviderDataError, parseRetryAfter } from "@hyav/pi-provider";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";

interface CodexUsageWindow {
	usedPercent: number;
	windowSeconds: number;
	resetAt: number;
}

interface CodexUsagePayload {
	planType?: unknown;
	primaryWindow?: CodexUsageWindow;
	secondaryWindow?: CodexUsageWindow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safePlanLabel(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f]/.test(value)) return "Unknown";
	const raw = value.trim().toLowerCase();
	const known: Record<string, string> = {
		free: "Free",
		go: "Go",
		plus: "Plus",
		pro: "Pro",
		prolite: "Pro Lite",
		free_workspace: "Free Workspace",
		team: "Business",
		self_serve_business_prolite: "Business",
		self_serve_business_usage_based: "Business",
		business: "Enterprise",
		ent26: "Enterprise",
		enterprise_cbp_automation: "Enterprise (Automation)",
		enterprise_cbp_usage_based: "Enterprise",
		education: "Education",
		quorum: "Quorum",
		k12: "K-12",
		enterprise: "Enterprise",
		edu: "Edu",
		guest: "Guest",
		unknown: "Unknown",
	};
	if (known[raw]) return known[raw];
	return (
		raw
			.split(/[_-]+/)
			.filter(Boolean)
			.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
			.join(" ") || "Unknown"
	);
}

function parseWindow(value: unknown): CodexUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = finiteNumber(value.used_percent);
	const windowSeconds = finiteNumber(value.limit_window_seconds);
	const resetAt = finiteNumber(value.reset_at);
	if (
		usedPercent === undefined ||
		windowSeconds === undefined ||
		resetAt === undefined ||
		usedPercent < 0 ||
		usedPercent > 100 ||
		windowSeconds <= 0 ||
		resetAt < 0
	) {
		return undefined;
	}
	return { usedPercent, windowSeconds, resetAt };
}

function isApproximate(value: number, expected: number): boolean {
	return value >= expected * 0.95 && value <= expected * 1.05;
}

interface CodexWindowDisplay {
	id: string;
	label: string;
}

function describeWindow(seconds: number, secondary: boolean): CodexWindowDisplay {
	const minutes = seconds / 60;
	if (isApproximate(minutes, 5 * 60)) return { id: "primary-window", label: "5h" };
	if (isApproximate(minutes, 24 * 60)) return { id: "daily-window", label: "Daily" };
	if (isApproximate(minutes, 7 * 24 * 60)) return { id: "weekly-window", label: "Weekly" };
	if (isApproximate(minutes, 30 * 24 * 60)) return { id: "monthly-window", label: "Monthly" };
	if (isApproximate(minutes, 365 * 24 * 60)) return { id: "annual-window", label: "Annual" };
	return secondary ? { id: "secondary-window", label: "Secondary usage" } : { id: "primary-window", label: "Usage" };
}

export function parseCodexUsage(payload: unknown): CodexUsagePayload {
	if (!isRecord(payload)) {
		throw new ProviderDataError("OpenAI Codex status returned an invalid response", "badjson");
	}
	const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
	return {
		planType: payload.plan_type,
		primaryWindow: parseWindow(rateLimit?.primary_window),
		secondaryWindow: parseWindow(rateLimit?.secondary_window),
	};
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	try {
		const segment = token.split(".")[1];
		if (!segment) return undefined;
		const base64 = segment
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(segment.length / 4) * 4, "=");
		const binary = atob(base64);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const payload = JSON.parse(new TextDecoder().decode(bytes));
		return isRecord(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

export function extractCodexAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const auth = payload?.[ACCOUNT_ID_CLAIM];
	if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string" || auth.chatgpt_account_id.trim() === "") {
		return undefined;
	}
	return auth.chatgpt_account_id.trim();
}

function statusEntries(payload: CodexUsagePayload): StatusEntry[] {
	const entries: StatusEntry[] = [{ kind: "text", id: "plan", label: "Plan", value: safePlanLabel(payload.planType) }];
	const usedIds = new Set(entries.map(({ id }) => id));
	for (const [window, secondary] of [
		[payload.primaryWindow, false],
		[payload.secondaryWindow, true],
	] as const) {
		if (!window) continue;
		const display = describeWindow(window.windowSeconds, secondary);
		let id = display.id;
		if (usedIds.has(id)) {
			const role = secondary ? "secondary" : "primary";
			id = `${id}-${role}`;
		}
		usedIds.add(id);
		entries.push({
			kind: "window",
			id,
			label: display.label,
			remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
			resetAt: window.resetAt * 1_000,
		});
	}
	if (entries.length === 1) {
		entries.push({ kind: "text", id: "limits", label: "Limits", value: "not available" });
	}
	return entries;
}

export const openAICodexStatusAdapter: StatusAdapter = {
	id: "openai-codex-status",
	providerId: "openai-codex",
	name: "OpenAI Codex",
	cacheTtlMs: 60_000,
	requestTimeoutMs: 8_000,
	async fetch(context): Promise<StatusSnapshot> {
		const key = await context.getApiKey();
		if (!key || key === "proxy-managed") {
			throw new ProviderDataError("OpenAI Codex status requires ChatGPT OAuth", "auth");
		}
		const accountId = extractCodexAccountId(key);
		if (!accountId) {
			throw new ProviderDataError("OpenAI Codex OAuth token has no account ID", "auth");
		}
		const response = await context.fetch(CODEX_USAGE_URL, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				Authorization: `Bearer ${key}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
				"User-Agent": "@hyav/pi-provider",
			},
			signal: context.signal,
		});
		if (!response.ok) {
			throw new ProviderDataError(
				`OpenAI Codex status failed: HTTP ${response.status}`,
				`http${response.status}`,
				parseRetryAfter(response.headers.get("retry-after"), context.now()),
				response.status,
			);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new ProviderDataError("OpenAI Codex status returned invalid JSON", "badjson");
		}
		const payload = parseCodexUsage(body);
		return { entries: statusEntries(payload), updatedAt: context.now() };
	},
};

export function createOpenAICodexStatusAdapter(requestTimeoutMs: number): StatusAdapter {
	return { ...openAICodexStatusAdapter, requestTimeoutMs };
}

const openAICodexStatusExtension = defineStatusExtension({
	id: "openai-codex-status",
	providerId: "openai-codex",
	create: ({ statusRequestTimeoutMs }) => createOpenAICodexStatusAdapter(statusRequestTimeoutMs),
});

export default openAICodexStatusExtension;
