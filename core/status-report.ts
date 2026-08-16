import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveCheckDiagnostics } from "./live-check-manager.ts";
import type { PreflightAdapter, PreflightDiagnostics } from "./preflight-manager.ts";
import type { StatusDiagnostics } from "./status-manager.ts";
import type {
	ModelFieldSource,
	ModelMetadataStatus,
	ModelQualityScore,
	ProviderAdapter,
	ProviderCost,
	ProviderModelMetadata,
	StatusAdapter,
	StatusAmountEntry,
	StatusEntry,
} from "./types.ts";

type ActiveModel = NonNullable<ExtensionContext["model"]>;
type ModelRegistry = ExtensionContext["modelRegistry"];
export type NativeProvider = NonNullable<ReturnType<ModelRegistry["getProvider"]>>;

export type NativeProviderRegistry = {
	getProvider?: (provider: string) => NativeProvider | undefined;
};

export interface NativeProviderLookup {
	available: boolean;
	provider?: NativeProvider;
}

export interface NativePreflightStatus {
	providerAvailable: boolean;
	modelMatched: boolean;
}

export type StatusWarningLevel = "none" | "soft" | "hard";

export interface StatusReportOptions {
	liveCheckRequested?: boolean;
	showLiveCheckScope?: boolean;
	modelMetadata?: ProviderModelMetadata;
	metadataStatus?: ModelMetadataStatus;
}

interface ReportIssue {
	level: StatusWarningLevel;
	key?: string;
}

const STATUS_MODE_COMPLETIONS = [
	{
		value: "refresh",
		label: "refresh",
		description: "Refresh account status and free access checks; no model generation",
	},
	{
		value: "check",
		label: "check",
		description: "Refresh free checks and run one live model check; may incur usage",
	},
];

export type StatusMode = "default" | "refresh" | "check";

export function getStatusModeCompletions(prefix: string) {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const matches = STATUS_MODE_COMPLETIONS.filter(({ value }) => value.startsWith(normalizedPrefix));
	return matches.length > 0 ? matches.map((item) => ({ ...item })) : null;
}

export function parseStatusMode(args: string): StatusMode | undefined {
	switch (args.trim()) {
		case "":
			return "default";
		case "refresh":
			return "refresh";
		case "check":
			return "check";
		default:
			return undefined;
	}
}

function formatTokens(count: number | undefined): string {
	if (count === undefined || !Number.isFinite(count)) return "unknown";
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return "unknown";
	return value.toFixed(2).replace(/\.?(0+)$/, "");
}

function formatAge(now: number, timestamp: number): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function formatUntil(now: number, timestamp: number): string {
	const seconds = Math.max(0, Math.ceil((timestamp - now) / 1_000));
	if (seconds === 0) return "now";
	if (seconds < 60) return `in ${seconds}s`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) return `in ${hours}h`;
	return `in ${Math.ceil(hours / 24)}d`;
}

function formatDateTime(timestamp: number): string {
	const date = new Date(timestamp);
	if (!Number.isFinite(timestamp) || !Number.isFinite(date.getTime())) return "unknown";
	const pad = (value: number): string => value.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRate(value: number): string {
	if (!Number.isFinite(value)) return "unknown";
	if (value === 0) return "$0";
	const decimals = value < 1 ? 3 : 2;
	return `$${value.toFixed(decimals).replace(/\.?(0+)$/, "")}`;
}

function formatPricing(model: ActiveModel, metadata?: ProviderModelMetadata): string {
	const cost = model.cost;
	const knownFree = metadata?.pricing.known === true && cost !== undefined;
	if (
		!cost ||
		(!knownFree && cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0)
	) {
		return "unavailable";
	}
	const rates = [`${formatRate(cost.input)} input`, `${formatRate(cost.output)} output`];
	if (cost.cacheRead > 0) rates.push(`${formatRate(cost.cacheRead)} cache read`);
	if (cost.cacheWrite > 0) rates.push(`${formatRate(cost.cacheWrite)} cache write`);
	return `${rates.join(" / ")} per 1M tokens`;
}

function formatPricingTier(tier: NonNullable<ProviderCost["tiers"]>[number]): string {
	const rates = [`${formatRate(tier.input)} input`, `${formatRate(tier.output)} output`];
	if (tier.cacheRead > 0) rates.push(`${formatRate(tier.cacheRead)} cache read`);
	if (tier.cacheWrite > 0) rates.push(`${formatRate(tier.cacheWrite)} cache write`);
	return `above ${formatTokens(tier.inputTokensAbove)} · ${rates.join(" / ")} per 1M tokens`;
}

function formatQuality(quality: ModelQualityScore[], status: ModelMetadataStatus | undefined, now: number): string[] {
	const scores = quality.filter(
		(score) => score.source === "artificial-analysis" && score.benchmark === "Artificial Analysis",
	);
	if (scores.length === 0) return [];
	const statusParts = [`Status: ${status?.state ?? "available"}`];
	if (status?.updatedAt !== undefined) statusParts.push(formatAge(now, status.updatedAt));
	return [
		statusParts.join(" · "),
		`Source: ${status?.source ?? "AA/OpenRouter"}`,
		`Indices: ${scores.map((score) => `${score.category} ${formatNumber(score.value)}`).join(" · ")}`,
	];
}

function formatModelFieldSource(source: ModelFieldSource | undefined): string {
	if (source === undefined) return "";
	const label =
		source === "native"
			? "Pi native"
			: source === "provider"
				? "Provider catalog"
				: source === "official"
					? "OpenRouter"
					: source === "fallback"
						? "Provider fallback"
						: "Pi default";
	return ` · ${label}`;
}

function formatPricingSource(metadata: ProviderModelMetadata): string {
	const source =
		metadata.pricing.source === "provider"
			? "Provider catalog"
			: metadata.pricing.source === "fallback"
				? "Provider fallback"
				: metadata.pricing.source === "official"
					? "OpenRouter"
					: metadata.pricing.source === "native"
						? "Pi native"
						: undefined;
	const parts = source ? [source] : [];
	if (metadata.pricing.adjustment) parts.push(metadata.pricing.adjustment.label);
	if (metadata.pricing.known) parts.push("estimate");
	return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function formatQualitySource(
	quality: ModelQualityScore[] | undefined,
	status: ModelMetadataStatus | undefined,
	now: number,
): string[] {
	const scores = quality ? formatQuality(quality, status, now) : [];
	if (scores.length > 0) return scores;
	if (!status?.source) return [];
	return [
		status.source === "AA/OpenRouter"
			? "Status: unavailable · no AA/OpenRouter metric"
			: "Status: unavailable · no public score",
	];
}

const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function getSupportedReasoningLevels(model: ActiveModel): string[] {
	return REASONING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function formatReasoning(model: ActiveModel): string {
	if (!model.reasoning) return "not supported";
	const levels = getSupportedReasoningLevels(model);
	return levels.length > 0 ? `supported (${levels.join(", ")})` : "supported";
}

export function resolveNativeProvider(modelRegistry: NativeProviderRegistry, providerId: string): NativeProviderLookup {
	if (typeof modelRegistry.getProvider !== "function") return { available: false };
	try {
		return { available: true, provider: modelRegistry.getProvider(providerId) };
	} catch {
		return { available: true };
	}
}

function getNativeModelCount(provider: NativeProvider | undefined): number | undefined {
	if (!provider) return undefined;
	try {
		return provider.getModels().length;
	} catch {
		return undefined;
	}
}

export function nativeModelMatches(provider: NativeProvider | undefined, modelId: string): boolean {
	if (!provider) return false;
	try {
		return provider.getModels().some(({ id }) => id === modelId);
	} catch {
		return false;
	}
}

function formatCatalog(
	adapter: ProviderAdapter | undefined,
	nativeProvider: NativeProvider | undefined,
	nativeLookupAvailable: boolean,
	now: number,
): { lines: string[]; issue: ReportIssue } {
	if (!adapter) {
		if (!nativeLookupAvailable) return { lines: ["Status: not managed by Provider Kit"], issue: { level: "none" } };
		if (!nativeProvider) return { lines: ["Status: unavailable in Pi"], issue: { level: "none" } };
		const count = getNativeModelCount(nativeProvider);
		return {
			lines: ["Status: static · Pi native", `Models: ${count === undefined ? "unknown" : count}`],
			issue: { level: "none" },
		};
	}
	const catalog = adapter.catalog;
	const count = catalog?.modelCount ?? adapter.provider.models.length;
	const source = catalog?.source ?? "static";
	const freshness = catalog?.lastError ? "stale" : catalog?.updatedAt !== undefined ? "fresh" : undefined;
	const statusParts = freshness ? [freshness, source] : [source];
	if (catalog?.updatedAt !== undefined) statusParts.push(formatAge(now, catalog.updatedAt));
	const lines = [`Status: ${statusParts.join(" · ")}`, `Models: ${count}`];
	if (catalog?.lastError) lines.push(`Error: ${catalog.lastError}`);
	const issue =
		catalog?.lastError !== undefined
			? {
					level: count > 0 ? ("soft" as const) : ("hard" as const),
					key: `catalog:${catalog.lastError}`,
				}
			: { level: "none" as const };
	return { lines, issue };
}

function classifyError(code: string, httpStatus: number | undefined): StatusWarningLevel {
	if (code === "auth" || code === "config" || code === "badjson" || code === "unsupported") return "hard";
	if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
		return "hard";
	}
	return "soft";
}

function errorIssue(scope: string, code: string, httpStatus: number | undefined): ReportIssue {
	return {
		level: classifyError(code, httpStatus),
		key: `${scope}:${code}`,
	};
}

function combineIssues(...issues: ReportIssue[]): ReportIssue {
	return (
		issues.find(({ level }) => level === "hard") ?? issues.find(({ level }) => level === "soft") ?? { level: "none" }
	);
}

function scopeIssue(issue: ReportIssue, scope: string): ReportIssue {
	return issue.level === "none" ? issue : { ...issue, key: `${scope}:${issue.key ?? issue.level}` };
}

function indentLines(lines: string[]): string[] {
	return lines.map((line) => (line === "" ? "" : `  ${line}`));
}

function formatStatusAmount(entry: StatusAmountEntry): string {
	const unit = entry.unit.trim();
	if (unit.toUpperCase() === "USD") return `$${entry.value.toFixed(2)}`;
	return `${formatNumber(entry.value)} ${unit}`;
}

function formatStatusEntry(entry: StatusEntry): string {
	if (entry.kind === "text") return `${entry.label}: ${entry.value}`;
	if (entry.kind === "amount") return `${entry.label}: ${formatStatusAmount(entry)}`;
	const remaining = `${formatNumber(entry.remainingPercent)}% remaining`;
	return `${entry.label}: ${remaining}${entry.resetAt !== undefined ? ` · reset at ${formatDateTime(entry.resetAt)}` : ""}`;
}

function appendStatusReport(
	lines: string[],
	status: StatusAdapter | undefined,
	diagnostics: StatusDiagnostics | undefined,
	authConfigured: boolean,
	now: number,
): ReportIssue {
	if (!status) {
		lines.push("Status: not supported");
		return { level: "none" };
	}
	if (!authConfigured) {
		lines.push("Status: unavailable · auth missing");
		return { level: "none" };
	}
	if (diagnostics?.snapshot) {
		const expired = now - diagnostics.snapshot.updatedAt >= status.cacheTtlMs;
		const stale = diagnostics.lastError !== undefined || expired;
		lines.push(`Status: ${stale ? "stale" : "fresh"} · ${formatAge(now, diagnostics.snapshot.updatedAt)}`);
		for (const entry of diagnostics.snapshot.entries) lines.push(formatStatusEntry(entry));
	} else if (diagnostics?.pending) {
		lines.push("Status: checking");
	} else {
		lines.push("Status: unavailable");
	}
	if (!diagnostics?.lastError) return { level: "none" };
	const httpStatus =
		diagnostics.lastError.httpStatus !== undefined ? ` · ${formatHttpStatus(diagnostics.lastError.httpStatus)}` : "";
	lines.push(`Error: ${diagnostics.lastError.code}${httpStatus}`);
	if (diagnostics.lastError.retryAt !== undefined && diagnostics.lastError.retryAt > now) {
		lines.push(`Retry: ${formatUntil(now, diagnostics.lastError.retryAt)}`);
	}
	return errorIssue("status", diagnostics.lastError.code, diagnostics.lastError.httpStatus);
}

function appendPreflightReport(
	lines: string[],
	preflight: PreflightAdapter | undefined,
	diagnostics: PreflightDiagnostics | undefined,
	nativePreflight: NativePreflightStatus | undefined,
	authConfigured: boolean,
	now: number,
): ReportIssue {
	if (!preflight) {
		if (!nativePreflight) {
			lines.push("Preflight: not configured");
			return { level: "none" };
		}
		if (!nativePreflight.providerAvailable) {
			lines.push("Preflight: failed · Pi provider unavailable");
			return { level: "hard", key: "preflight:provider-unavailable" };
		}
		if (!authConfigured) {
			lines.push("Preflight: native · provider/catalog · auth missing");
			return { level: "none" };
		}
		if (!nativePreflight.modelMatched) {
			lines.push("Preflight: failed · native/provider/auth/catalog");
			lines.push("Preflight detail: model not in Pi catalog");
			return { level: "hard", key: "preflight:model-not-in-catalog" };
		}
		lines.push("Preflight: native · provider/auth/catalog");
		return { level: "none" };
	}
	if (!authConfigured) {
		lines.push("Preflight: skipped · auth missing");
		return { level: "none" };
	}
	if (!diagnostics?.snapshot) {
		if (diagnostics?.pending) {
			lines.push("Preflight: checking");
			return { level: "none" };
		}
		if (diagnostics?.lastError) {
			const httpStatus =
				diagnostics.lastError.httpStatus !== undefined
					? ` · ${formatHttpStatus(diagnostics.lastError.httpStatus)}`
					: "";
			lines.push(`Preflight: unavailable · error ${diagnostics.lastError.code}${httpStatus}`);
			if (diagnostics.lastError.retryAt !== undefined && diagnostics.lastError.retryAt > now) {
				lines.push(`Retry: ${formatUntil(now, diagnostics.lastError.retryAt)}`);
			}
			return errorIssue("preflight", diagnostics.lastError.code, diagnostics.lastError.httpStatus);
		}
		lines.push("Preflight: not checked");
		return { level: "none" };
	}

	const expired = now - diagnostics.snapshot.updatedAt >= preflight.cacheTtlMs;
	const stale = expired || diagnostics.lastError !== undefined;
	const state = diagnostics.snapshot.passed ? "passed" : "failed";
	const freshness = stale ? "stale" : "fresh";
	const checks = diagnostics.snapshot.checks.length > 0 ? ` · ${diagnostics.snapshot.checks.join("/")}` : "";
	lines.push(`Preflight: ${state}${checks} · ${freshness} · ${formatAge(now, diagnostics.snapshot.updatedAt)}`);
	if (diagnostics.lastError) {
		const httpStatus =
			diagnostics.lastError.httpStatus !== undefined
				? ` · ${formatHttpStatus(diagnostics.lastError.httpStatus)}`
				: "";
		lines.push(`Preflight error: ${diagnostics.lastError.code}${httpStatus}`);
		if (diagnostics.lastError.retryAt !== undefined && diagnostics.lastError.retryAt > now) {
			lines.push(`Retry: ${formatUntil(now, diagnostics.lastError.retryAt)}`);
		}
	}
	if (!diagnostics.snapshot.passed) {
		return { level: "hard", key: "preflight:failed" };
	}
	return diagnostics.lastError
		? errorIssue("preflight", diagnostics.lastError.code, diagnostics.lastError.httpStatus)
		: { level: "none" };
}

function formatLatency(latencyMs: number): string {
	if (!Number.isFinite(latencyMs)) return "unknown";
	return `${Math.max(0, Math.round(latencyMs))}ms`;
}

function formatHttpStatus(status: number): string {
	const labels: Record<number, string> = {
		200: "OK",
		201: "Created",
		202: "Accepted",
		204: "No Content",
		400: "Bad Request",
		401: "Unauthorized",
		403: "Forbidden",
		404: "Not Found",
		408: "Request Timeout",
		409: "Conflict",
		429: "Rate Limited",
		500: "Server Error",
		502: "Bad Gateway",
		503: "Service Unavailable",
		504: "Gateway Timeout",
	};
	return `HTTP ${status}${labels[status] ? ` ${labels[status]}` : ""}`;
}

function appendLiveCheckReport(
	lines: string[],
	diagnostics: LiveCheckDiagnostics | undefined,
	authConfigured: boolean,
	now: number,
	options: { requested?: boolean; showScope?: boolean } = {},
): ReportIssue {
	if (!authConfigured) {
		lines.push("Availability: skipped · auth missing");
		return { level: "none" };
	}
	if (options.showScope) {
		lines.push("Live check scope: streamSimple() · Provider Kit tuners only (other hooks not replayed)");
	}
	if (diagnostics?.pending) lines.push("Availability: checking");
	else if (!diagnostics?.snapshot && !diagnostics?.lastError) lines.push("Availability: not checked");
	else if (!diagnostics?.snapshot && diagnostics.lastError) {
		const status =
			diagnostics.lastError.httpStatus !== undefined
				? ` · ${formatHttpStatus(diagnostics.lastError.httpStatus)}`
				: "";
		lines.push(`Availability: failed${status}`);
		lines.push(`Live check error: ${diagnostics.lastError.code}`);
		if (diagnostics.lastError.retryAt !== undefined && diagnostics.lastError.retryAt > now) {
			lines.push(`Retry: ${formatUntil(now, diagnostics.lastError.retryAt)}`);
		}
		return options.requested ? { level: "hard", key: `live-check:${diagnostics.lastError.code}` } : { level: "soft" };
	} else if (diagnostics?.snapshot) {
		const stale = diagnostics.lastError !== undefined;
		lines.push(`Availability: ${stale ? "stale" : "verified"} · ${formatAge(now, diagnostics.snapshot.checkedAt)}`);
		const httpStatus =
			diagnostics.snapshot.httpStatus !== undefined
				? formatHttpStatus(diagnostics.snapshot.httpStatus)
				: "HTTP status unknown";
		lines.push(
			`Live check: ${stale ? "last success" : "success"} · ${httpStatus} · ${formatLatency(diagnostics.snapshot.latencyMs)}`,
		);
		if (diagnostics.lastError) {
			lines.push(`Live check error: ${diagnostics.lastError.code}`);
			if (diagnostics.lastError.retryAt !== undefined && diagnostics.lastError.retryAt > now) {
				lines.push(`Retry: ${formatUntil(now, diagnostics.lastError.retryAt)}`);
			}
			return options.requested
				? { level: "hard", key: `live-check:${diagnostics.lastError.code}` }
				: { level: "soft" };
		}
	}
	return { level: "none" };
}

export function formatProviderStatus(
	model: ActiveModel,
	provider: ProviderAdapter | undefined,
	status: StatusAdapter | undefined,
	preflight: PreflightAdapter | undefined,
	nativePreflight: NativePreflightStatus | undefined,
	auth: { configured: boolean; source?: string },
	diagnostics: StatusDiagnostics | undefined,
	preflightDiagnostics: PreflightDiagnostics | undefined,
	liveCheckDiagnostics: LiveCheckDiagnostics | undefined,
	nativeProvider: NativeProvider | undefined,
	nativeLookupAvailable: boolean,
	now: number,
	options: StatusReportOptions = {},
): { report: string; warningKey?: string; warningLevel: StatusWarningLevel } {
	const catalog = formatCatalog(provider, nativeProvider, nativeLookupAvailable, now);
	const catalogIssue = scopeIssue(catalog.issue, `catalog:${model.provider}`);
	const healthLines: string[] = [];
	const preflightIssue = scopeIssue(
		appendPreflightReport(healthLines, preflight, preflightDiagnostics, nativePreflight, auth.configured, now),
		`preflight:${model.provider}/${model.id}`,
	);
	const liveCheckIssue = scopeIssue(
		appendLiveCheckReport(healthLines, liveCheckDiagnostics, auth.configured, now, {
			requested: options.liveCheckRequested,
			showScope: options.showLiveCheckScope,
		}),
		`live-check:${model.provider}/${model.id}`,
	);
	const accountLines: string[] = [];
	const statusIssue = scopeIssue(
		appendStatusReport(accountLines, status, diagnostics, auth.configured, now),
		`status:${model.provider}`,
	);
	const fieldSources = options.modelMetadata?.fieldSources;
	const qualityLines = formatQualitySource(options.modelMetadata?.quality, options.metadataStatus, now);
	const pricingSource = options.modelMetadata?.pricing ? formatPricingSource(options.modelMetadata) : "";
	const lines = [
		`Provider: ${model.provider}`,
		`Model: ${model.id}`,
		`Auth: ${auth.configured ? `configured${auth.source ? ` (${auth.source})` : ""}` : "missing"}`,
		"",
		"Catalog:",
		...indentLines(catalog.lines),
		"",
		"Health:",
		...indentLines(healthLines),
		"",
		"Account:",
		...indentLines(accountLines),
		"",
		"Model details:",
		`  API: ${model.api ?? provider?.provider.api ?? "managed by Pi"}`,
		`  Endpoint: ${model.baseUrl ?? provider?.provider.baseUrl ?? "managed by Pi"}`,
		`  Context: ${formatTokens(model.contextWindow)}${formatModelFieldSource(fieldSources?.contextWindow)}`,
		`  Max output: ${formatTokens(model.maxTokens)}${formatModelFieldSource(fieldSources?.maxTokens)}`,
		`  Input: ${model.input?.join(", ") || "unknown"}${formatModelFieldSource(fieldSources?.input)}`,
		`  Reasoning: ${formatReasoning(model)}${formatModelFieldSource(fieldSources?.reasoning)}`,
		`  Pricing: ${formatPricing(model, options.modelMetadata)}${pricingSource}`,
		...(model.cost?.tiers?.map((tier) => `  Pricing tier: ${formatPricingTier(tier)}`) ?? []),
		...(options.modelMetadata?.pricing?.note ? [`  Pricing note: ${options.modelMetadata.pricing.note}`] : []),
		...(qualityLines.length > 0 ? ["", "Quality:", ...indentLines(qualityLines)] : []),
	];
	const issue = combineIssues(catalogIssue, preflightIssue, liveCheckIssue, statusIssue);
	return {
		report: lines.join("\n"),
		...(issue.level === "hard" ? { warningKey: issue.key ?? "provider-status" } : {}),
		warningLevel: issue.level,
	};
}
