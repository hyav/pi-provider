import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiProviderDefinition } from "./definition.ts";
import { validatePiProviderDefinition } from "./definition.ts";
import { LiveCheckManager, type LiveCheckResult } from "./live-check-manager.ts";
import {
	fetchOfficialPricing,
	findOfficialMeta,
	getPricingCacheAge,
	type OfficialModelMeta,
	OPENROUTER_MODELS_URL,
} from "./official-pricing.ts";
import type { PreflightContextLike } from "./preflight-manager.ts";
import { PreflightManager } from "./preflight-manager.ts";
import { refreshProviderRegistrations, registerProviderAdapter } from "./provider-registration.ts";
import type { PiProviderDependencies, PiProviderLoader } from "./runtime-config.ts";
import { resolvePiProviderDependencies } from "./runtime-config.ts";
import type { StatusContextLike } from "./status-manager.ts";
import { StatusManager } from "./status-manager.ts";
import {
	formatProviderStatus,
	getStatusModeCompletions,
	type NativeProviderRegistry,
	nativeModelMatches,
	parseStatusMode,
	resolveNativeProvider,
} from "./status-report.ts";
import { applyTunerAdapters, sortTunerAdapters } from "./tuner-manager.ts";
import type {
	ModelMetadataStatus,
	ProviderAdapter,
	ProviderCost,
	ProviderModelDraft,
	ProviderModelMetadata,
	StoredCredentialLike,
} from "./types.ts";

type ActiveModel = NonNullable<ExtensionContext["model"]>;
type StatusNotificationContext = Pick<ExtensionContext, "modelRegistry" | "ui"> & {
	mode?: ExtensionContext["mode"];
};
const STATUS_WIDGET_KEY = "pi-provider-status";

function readProviderCredentialMetadata(
	provider: string,
	readStoredCredential: (providerId: string) => StoredCredentialLike | undefined,
): unknown {
	try {
		const credential = readStoredCredential(provider);
		const type = credential?.type;
		if (type !== "oauth" && type !== "api_key") return undefined;
		return {
			type,
			...(type === "oauth" && typeof credential?.teamName === "string" ? { teamName: credential.teamName } : {}),
		};
	} catch {
		return undefined;
	}
}

function clearTransientStatus(ctx: Pick<ExtensionContext, "ui">): void {
	if (typeof ctx.ui.setWidget !== "function") return;
	ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined);
}

function showTransientStatus(
	message: string,
	ctx: StatusNotificationContext,
	wrapTextWithAnsi: (text: string, width: number) => string[],
): boolean {
	if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || typeof ctx.ui.setWidget !== "function") return false;
	// RPC cannot render component factories, so keep its plain text protocol unchanged.
	if (ctx.mode === "rpc") {
		ctx.ui.setWidget(STATUS_WIDGET_KEY, [message], { placement: "aboveEditor" });
		return true;
	}
	// Use the active Pi theme's dim status text instead of the terminal's foreground.
	// Keep the report in one component so Pi's widget line cap does not truncate it.
	const widgetMessage = `${message}\n`;
	ctx.ui.setWidget(
		STATUS_WIDGET_KEY,
		(_tui, theme) => ({
			render(width: number): string[] {
				if (width <= 0) return [];
				const padding = width > 2 ? " " : "";
				const contentWidth = Math.max(1, width - padding.length * 2);
				return widgetMessage.split("\n").flatMap((line) => {
					if (line === "") return [""];
					return wrapTextWithAnsi(theme.fg("dim", line), contentWidth).map(
						(chunk) => `${padding}${chunk}${padding}`,
					);
				});
			},
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);
	return true;
}

function compareAdapterIds(left: { id: string }, right: { id: string }): number {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function scheduleModelCatalogRefresh(ctx: Pick<ExtensionContext, "modelRegistry">, reason: string): void {
	if (reason !== "startup" && reason !== "reload") return;
	const refresh = ctx.modelRegistry?.refresh;
	if (typeof refresh !== "function") return;
	void Promise.resolve()
		.then(() => refresh.call(ctx.modelRegistry))
		.catch(() => undefined);
}

export interface PiProviderRuntimeController {
	resetForSession(): void;
	updateOfficialPricing?(snapshot: Record<string, OfficialModelMeta>): void;
	shutdown(): void;
	clearStatusPresentation(ctx: Pick<ExtensionContext, "ui">): void;
	applyTunerPayload(payload: unknown, model: ActiveModel): unknown | undefined | Promise<unknown | undefined>;
	handleModelSelect(model: ActiveModel, ctx: Pick<ExtensionContext, "modelRegistry" | "ui">): void;
	handleStatusCommand(args: string, ctx: ExtensionContext): Promise<void>;
}

function createNativeProviderRegistry(modelRegistry: ExtensionContext["modelRegistry"]): NativeProviderRegistry {
	return modelRegistry as unknown as NativeProviderRegistry;
}

function cloneProviderCost(cost: ProviderCost): ProviderCost {
	return {
		...cost,
		...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
	};
}

function getOfficialMetadataStatus(
	snapshot: Record<string, OfficialModelMeta>,
	runtime: PiProviderDependencies,
): ModelMetadataStatus | undefined {
	const source = runtime.officialPricingUrl === OPENROUTER_MODELS_URL ? "AA/OpenRouter" : "Official metadata";
	if (!runtime.enableOfficialPricingFallback && Object.keys(snapshot).length === 0) return undefined;
	if (Object.keys(snapshot).length === 0) return { state: "unavailable", source };
	const now = runtime.now();
	const age = getPricingCacheAge(runtime.officialPricingUrl, now);
	const updatedAt = age === undefined ? now : now - age;
	return {
		state: age !== undefined && age >= runtime.officialPricingCacheTtlMs ? "stale" : "fresh",
		updatedAt,
		source,
	};
}

function hasKnownNativeCost(cost: ProviderCost | undefined): cost is ProviderCost {
	if (!cost) return false;
	return (
		[cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some((rate) => Number.isFinite(rate) && rate > 0) ||
		(cost.tiers?.some((tier) =>
			[tier.input, tier.output, tier.cacheRead, tier.cacheWrite].some((rate) => Number.isFinite(rate) && rate > 0),
		) ??
			false)
	);
}

/** Build report-only metadata; never merge external fields into Pi's native model. */
function getNativeModelMetadata(
	model: ActiveModel,
	officialPricing: Record<string, OfficialModelMeta>,
): ProviderModelMetadata {
	const officialMeta =
		findOfficialMeta(`${model.provider}/${model.id}`, officialPricing) ?? findOfficialMeta(model.id, officialPricing);
	const knownPrice = hasKnownNativeCost(model.cost);
	return {
		pricing: {
			known: knownPrice,
			source: "native",
			...(knownPrice
				? { baseCost: cloneProviderCost(model.cost), effectiveCost: cloneProviderCost(model.cost) }
				: {}),
		},
		fieldSources: {
			contextWindow: "native",
			maxTokens: "native",
			input: "native",
			reasoning: "native",
		},
		...(officialMeta?.quality
			? {
					quality: officialMeta.quality.map((score) => ({
						...score,
						...(score.confidenceInterval ? { confidenceInterval: { ...score.confidenceInterval } } : {}),
					})),
				}
			: {}),
	};
}

export function installPiProviderRuntime(
	pi: ExtensionAPI,
	runtime: PiProviderDependencies,
	definition: PiProviderDefinition,
	officialPricing: Record<string, OfficialModelMeta> = {},
	options: {
		registerHandlers?: boolean;
		providerDrafts?: ReadonlyMap<ProviderAdapter, ProviderModelDraft[]>;
	} = {},
): PiProviderRuntimeController {
	validatePiProviderDefinition(definition);
	const registerHandlers = options.registerHandlers ?? true;
	let currentOfficialPricing = officialPricing;
	let currentOfficialMetadataStatus = getOfficialMetadataStatus(officialPricing, runtime);
	const providers = [...definition.providers].sort(compareAdapterIds);
	const statuses = [...(definition.statuses ?? [])].sort(compareAdapterIds);
	const preflights = [...(definition.preflights ?? [])].sort(compareAdapterIds);
	const tuners = sortTunerAdapters(definition.tuners ?? []);

	for (const adapter of providers) {
		registerProviderAdapter(pi, adapter, runtime, officialPricing, options.providerDrafts?.get(adapter));
	}

	const statusManager = new StatusManager(statuses, runtime.fetch, runtime.now);
	const preflightManager = new PreflightManager(preflights, runtime.fetch, runtime.now);
	const liveCheckManager = new LiveCheckManager(runtime.liveCheckRequestTimeoutMs, runtime.fetch, runtime.now);
	let lifecycleGeneration = 0;
	let statusPresentationGeneration = 0;
	let statusPresentationVisible = false;
	const clearStatusPresentation = (ctx: Pick<ExtensionContext, "ui">): void => {
		statusPresentationGeneration++;
		if (!statusPresentationVisible) return;
		statusPresentationVisible = false;
		clearTransientStatus(ctx);
	};

	const getStatusDetails = (model: ActiveModel, ctx: Pick<ExtensionContext, "modelRegistry">) => {
		const provider = providers.find(({ id }) => id === model.provider);
		const native = resolveNativeProvider(createNativeProviderRegistry(ctx.modelRegistry), model.provider);
		return {
			provider,
			metadataStatus: currentOfficialMetadataStatus,
			modelMetadata:
				provider?.registration?.modelMetadata?.[model.id] ??
				(provider === undefined ? getNativeModelMetadata(model, currentOfficialPricing) : undefined),
			status: statuses.find(({ providerId }) => providerId === model.provider),
			preflight: preflights.find(({ providerId }) => providerId === model.provider),
			nativeProvider: native.provider,
			nativeLookupAvailable: native.available,
			nativePreflight:
				provider === undefined && native.available
					? {
							providerAvailable: native.provider !== undefined,
							modelMatched: nativeModelMatches(native.provider, model.id),
						}
					: undefined,
			auth: ctx.modelRegistry.getProviderAuthStatus(model.provider),
		};
	};

	const notifyProviderStatus = (
		model: ActiveModel,
		ctx: StatusNotificationContext,
		generation: number,
		options: {
			presentationGeneration?: number;
			liveCheckRequested?: boolean;
			showLiveCheckScope?: boolean;
		} = {},
	): void => {
		if (
			generation !== lifecycleGeneration ||
			(options.presentationGeneration !== undefined &&
				options.presentationGeneration !== statusPresentationGeneration)
		)
			return;
		const {
			provider,
			modelMetadata,
			status,
			preflight,
			nativeProvider,
			nativeLookupAvailable,
			nativePreflight,
			auth,
			metadataStatus,
		} = getStatusDetails(model, ctx);
		const diagnostics = status ? statusManager.getDiagnostics(model.provider) : undefined;
		const preflightDiagnostics = preflightManager.getDiagnostics(model.provider, model.id);
		const liveCheckDiagnostics = liveCheckManager.getDiagnostics(model.provider, model.id);
		const report = formatProviderStatus(
			model,
			provider,
			status,
			preflight,
			nativePreflight,
			auth,
			diagnostics,
			preflightDiagnostics,
			liveCheckDiagnostics,
			nativeProvider,
			nativeLookupAvailable,
			runtime.now(),
			{
				liveCheckRequested: options.liveCheckRequested,
				showLiveCheckScope:
					options.showLiveCheckScope ??
					(liveCheckDiagnostics?.snapshot !== undefined ||
						liveCheckDiagnostics?.pending === true ||
						liveCheckDiagnostics?.lastError !== undefined),
				modelMetadata,
				metadataStatus,
			},
		);
		const message = report.report;
		if (report.warningLevel !== "hard") {
			statusPresentationVisible = showTransientStatus(message, ctx, runtime.wrapTextWithAnsi);
			if (!statusPresentationVisible) ctx.ui.notify(message, "info");
			return;
		}
		statusPresentationVisible = false;
		ctx.ui.notify(report.report, "warning");
	};

	const handleModelSelect = (_model: ActiveModel, ctx: Pick<ExtensionContext, "modelRegistry" | "ui">): void => {
		lifecycleGeneration++;
		clearStatusPresentation(ctx);
	};

	const handleStatusCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
		clearStatusPresentation(ctx);
		const generation = lifecycleGeneration;
		const presentationGeneration = statusPresentationGeneration;
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No active model", "warning");
			return;
		}
		const mode = parseStatusMode(args);
		if (mode === undefined) {
			ctx.ui.notify("Usage: /status [refresh|check]", "warning");
			return;
		}
		const { status, preflight, auth } = getStatusDetails(model, ctx);
		let liveCheckRequested = false;
		if ((mode === "refresh" || mode === "check") && auth.configured) {
			const getCredentialMetadata = () =>
				readProviderCredentialMetadata(model.provider, runtime.readStoredCredential);
			const statusContext: StatusContextLike = {
				model,
				modelRegistry: ctx.modelRegistry,
				getCredentialKey: () => ctx.modelRegistry.getApiKeyForProvider(model.provider),
				getCredentialMetadata,
			};
			const preflightContext: PreflightContextLike = {
				model,
				modelRegistry: ctx.modelRegistry,
				getCredentialMetadata,
			};
			const refreshChecks: Array<Promise<unknown>> = [];
			if (status) refreshChecks.push(statusManager.update(statusContext, { force: true }));
			if (preflight) refreshChecks.push(preflightManager.update(preflightContext, { force: true }));

			let liveCheck: Promise<LiveCheckResult | undefined> = Promise.resolve(undefined);
			if (mode === "check") {
				liveCheckRequested = true;
				liveCheck = liveCheckManager.check({
					model,
					modelRegistry: ctx.modelRegistry,
					...(tuners.length > 0
						? {
								onPayload: (payload, liveCheckModel) =>
									applyTunerAdapters(payload, { model: liveCheckModel }, tuners),
							}
						: {}),
				});
			}
			// Account status, free preflight, and the live check are independent requests.
			// Start all of them before awaiting any result so /status check waits only for the slowest one.
			await Promise.all([Promise.all(refreshChecks), liveCheck]);
			if (generation !== lifecycleGeneration) return;
		}
		if (generation !== lifecycleGeneration) return;
		notifyProviderStatus(model, ctx, generation, {
			presentationGeneration,
			liveCheckRequested,
			showLiveCheckScope: mode === "check",
		});
	};

	const resetForSession = (): void => {
		lifecycleGeneration++;
		statusPresentationGeneration++;
		statusPresentationVisible = false;
	};

	const shutdown = (): void => {
		lifecycleGeneration++;
		statusPresentationGeneration++;
		statusPresentationVisible = false;
		statusManager.cancelAll();
		statusManager.clear();
		preflightManager.cancelAll();
		preflightManager.clear();
		liveCheckManager.cancelAll();
		liveCheckManager.clear();
	};

	const controller: PiProviderRuntimeController = {
		resetForSession,
		updateOfficialPricing(snapshot) {
			currentOfficialPricing = snapshot;
			currentOfficialMetadataStatus = getOfficialMetadataStatus(snapshot, runtime);
		},
		shutdown,
		clearStatusPresentation,
		applyTunerPayload(payload, model) {
			if (tuners.length === 0) return undefined;
			return applyTunerAdapters(payload, { model }, tuners);
		},
		handleModelSelect,
		handleStatusCommand,
	};

	if (registerHandlers) {
		pi.on("before_provider_request", async (event, ctx) => {
			if (!ctx.model) return;
			return controller.applyTunerPayload(event.payload, ctx.model);
		});
		pi.on("input", (_event, ctx) => controller.clearStatusPresentation(ctx));
		pi.on("session_start", (event, ctx) => {
			resetForSession();
			scheduleModelCatalogRefresh(ctx, event.reason);
		});
		pi.on("model_select", (event, ctx) => handleModelSelect(event.model, ctx));
		pi.on("session_shutdown", () => shutdown());
		pi.registerCommand("status", {
			description: "Show status and diagnostics for the active provider",
			getArgumentCompletions: getStatusModeCompletions,
			handler: async (args, ctx) => handleStatusCommand(args, ctx),
		});
	}

	return controller;
}

export function createPiProviderRuntime(
	loadDefinition: PiProviderLoader,
	dependencies: Partial<PiProviderDependencies> = {},
): (pi: ExtensionAPI) => Promise<void> {
	const runtime = resolvePiProviderDependencies(dependencies);
	return async (pi) => {
		let latestBackgroundPricing: Record<string, OfficialModelMeta> | undefined;
		let installedDefinition: PiProviderDefinition | undefined;
		let installedController: PiProviderRuntimeController | undefined;
		let disposed = false;
		const onBackgroundRefresh = (snapshot: Record<string, OfficialModelMeta>): void => {
			latestBackgroundPricing = snapshot;
			if (disposed) return;
			installedController?.updateOfficialPricing?.(snapshot);
			if (installedDefinition === undefined) return;
			refreshProviderRegistrations(pi, installedDefinition.providers, runtime, snapshot);
		};
		const officialPricingPromise = runtime.enableOfficialPricingFallback
			? fetchOfficialPricing(
					runtime.fetch,
					runtime.officialPricingUrl,
					runtime.officialPricingTimeoutMs,
					runtime.officialPricingCacheTtlMs,
					runtime.officialPricingMaxStaleMs,
					runtime.now,
					{
						cachePath:
							runtime.officialPricingUrl === OPENROUTER_MODELS_URL
								? runtime.openRouterMetadataCachePath
								: undefined,
						background: runtime.officialPricingUrl === OPENROUTER_MODELS_URL,
						onBackgroundRefresh: onBackgroundRefresh,
					},
				)
			: Promise.resolve({});
		const definitionPromise = loadDefinition(runtime);
		const [officialPricing, definition] = await Promise.all([officialPricingPromise, definitionPromise]);
		validatePiProviderDefinition(definition);
		installedController = installPiProviderRuntime(pi, runtime, definition, officialPricing);
		installedDefinition = definition;
		if (latestBackgroundPricing !== undefined) onBackgroundRefresh(latestBackgroundPricing);
		pi.on("session_shutdown", () => {
			disposed = true;
		});
	};
}
