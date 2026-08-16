import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AdapterRegistrationEnvelope,
	isAdapterRegistrationEnvelope,
	isHostClaimRequest,
	PROVIDER_KIT_ADAPTER_EVENT,
	PROVIDER_KIT_HOST_CLAIM_EVENT,
	PROVIDER_KIT_STARTUP_BRIDGE_EVENT,
	type StartupBridge,
	type StartupBridgeRequest,
} from "./adapter-protocol.ts";
import { validateAdapter, validateAdapterIdentity, validateProviderAdapter } from "./adapter-validation.ts";
import { type ProviderKitDefinition, validateProviderKitDefinition } from "./definition.ts";
import {
	getStatusModeCompletions,
	installProviderKitRuntime,
	type ProviderKitRuntimeController,
	prepareProviderRegistration,
} from "./extension.ts";
import { fetchOfficialPricing, type OfficialModelMeta, OPENROUTER_MODELS_URL } from "./official-pricing.ts";
import type { PreflightAdapter } from "./preflight-manager.ts";
import { refreshProviderRegistrations } from "./provider-registration.ts";
import { scheduleModelCatalogRefresh } from "./runtime.ts";
import type { ProviderKitDependencies } from "./runtime-config.ts";
import { resolveProviderKitDependencies } from "./runtime-config.ts";
import type { ProviderAdapter, ProviderModelDraft, StatusAdapter, TunerAdapter } from "./types.ts";

function compareAdapterIds(left: { id: string }, right: { id: string }): number {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function adapterKindLabel(kind: AdapterRegistrationEnvelope["kind"]): string {
	return `${kind} adapter`;
}

function warnAdapterIssue(message: string): void {
	console.warn(`[provider-kit] ${message}`);
}

/**
 * Create the single Provider Kit Host used by the published Pi entrypoint.
 *
 * The Host deliberately does not assemble adapters during extension factory
 * loading. Adapter factories can run before or after this factory, so the
 * event-bus envelopes are collected and assembled at the first session-level
 * operation after Pi's session_start registration barrier.
 */
export function createProviderKitHost(dependencies: Partial<ProviderKitDependencies> = {}): (pi: ExtensionAPI) => void {
	const runtime = resolveProviderKitDependencies(dependencies);
	return (pi) => {
		const hostToken = {};
		const hostClaim = { token: hostToken, occupied: false };
		const unsubscribeHostClaim = pi.events.on(PROVIDER_KIT_HOST_CLAIM_EVENT, (value) => {
			if (!isHostClaimRequest(value) || value.token === hostToken) return;
			value.occupied = true;
		});
		pi.events.emit(PROVIDER_KIT_HOST_CLAIM_EVENT, hostClaim);
		if (hostClaim.occupied) {
			unsubscribeHostClaim();
			warnAdapterIssue("ignored a second Provider Kit Host; only one Host is supported per Pi runtime");
			return;
		}

		const registrations = new Map<object, AdapterRegistrationEnvelope>();
		let active: ProviderKitRuntimeController | undefined;
		let readyPromise: Promise<ProviderKitRuntimeController | undefined> | undefined;
		let disposed = false;
		let lifecycleGeneration = 0;
		let latestBackgroundPricing: Record<string, OfficialModelMeta> | undefined;
		let installedDefinition:
			| {
					generation: number;
					definition: ProviderKitDefinition;
					providerDrafts: Map<ProviderAdapter, ProviderModelDraft[]>;
			  }
			| undefined;

		const onBackgroundRefresh = (snapshot: Record<string, OfficialModelMeta>): void => {
			latestBackgroundPricing = snapshot;
			if (disposed || installedDefinition === undefined || installedDefinition.generation !== lifecycleGeneration)
				return;
			active?.updateOfficialPricing?.(snapshot);
			// Re-register from the adapter's current registration state. A dynamic
			// refreshModels() may have replaced the startup drafts since assembly.
			refreshProviderRegistrations(pi, installedDefinition.definition.providers, runtime, snapshot);
		};
		const officialPricing = runtime.enableOfficialPricingFallback
			? fetchOfficialPricingForHost(runtime, onBackgroundRefresh)
			: Promise.resolve({});
		const bridge: StartupBridge = { dependencies: runtime, officialPricing };

		const invalidateRuntime = (): void => {
			lifecycleGeneration++;
			installedDefinition = undefined;
			active?.shutdown();
			active = undefined;
			readyPromise = undefined;
		};

		const unsubscribeBridge = pi.events.on(PROVIDER_KIT_STARTUP_BRIDGE_EVENT, (value) => {
			if (value === null || typeof value !== "object") return;
			const request = value as StartupBridgeRequest;
			request.bridge ??= bridge;
		});

		const receiveRegistration = (value: unknown): void => {
			if (!isAdapterRegistrationEnvelope(value)) {
				warnAdapterIssue("ignored a malformed registration envelope");
				return;
			}
			try {
				if (value.kind === "provider") {
					validateAdapter("provider", value.adapter);
					validateAdapterIdentity("provider", value.id, value.adapter);
				} else if (value.kind === "status") {
					validateAdapter("status", value.adapter);
					validateAdapterIdentity("status", value.id, value.providerId, value.adapter);
				} else if (value.kind === "preflight") {
					validateAdapter("preflight", value.adapter);
					validateAdapterIdentity("preflight", value.id, value.providerId, value.adapter);
				} else {
					validateAdapter("tuner", value.adapter);
					validateAdapterIdentity("tuner", value.id, value.adapter);
				}
			} catch (error) {
				warnAdapterIssue(
					`ignored invalid ${adapterKindLabel(value.kind)} ${JSON.stringify(value.id)}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				return;
			}

			const previous = registrations.get(value.token);
			registrations.set(value.token, value);
			if (previous === undefined) invalidateRuntime();
		};

		const unsubscribeRegistrations = pi.events.on(PROVIDER_KIT_ADAPTER_EVENT, receiveRegistration);

		const groupedWithoutConflicts = <T>(items: T[], key: (item: T) => string, label: string): T[] => {
			const groups = new Map<string, T[]>();
			for (const item of items) {
				const group = groups.get(key(item));
				if (group) group.push(item);
				else groups.set(key(item), [item]);
			}
			const result: T[] = [];
			for (const [id, group] of groups) {
				if (group.length > 1) {
					warnAdapterIssue(`excluded ${group.length} colliding ${label} entries for ${JSON.stringify(id)}`);
					continue;
				}
				result.push(group[0]!);
			}
			return result;
		};

		const nativeProviderExists = (ctx: ExtensionContext | undefined, providerId: string): boolean => {
			if (!ctx || typeof ctx.modelRegistry.getProvider !== "function") return false;
			try {
				return ctx.modelRegistry.getProvider(providerId) !== undefined;
			} catch {
				return false;
			}
		};

		const materializeAdapter = async (entry: AdapterRegistrationEnvelope): Promise<unknown> => {
			if (entry.startupDependencies === runtime) return entry.adapter;
			return entry.factory({ ...runtime, pi });
		};

		const buildDefinition = async (
			ctx?: ExtensionContext,
		): Promise<{
			definition: ProviderKitDefinition;
			providerDrafts: Map<ProviderAdapter, ProviderModelDraft[]>;
			pricing: Record<string, OfficialModelMeta>;
		}> => {
			const envelopes = [...registrations.values()];
			const providerEnvelopes = groupedWithoutConflicts(
				envelopes.filter(
					(entry): entry is Extract<AdapterRegistrationEnvelope, { kind: "provider" }> =>
						entry.kind === "provider",
				),
				(entry) => entry.id,
				"provider",
			);
			const pricingPromise = officialPricing.catch(() => ({}));
			const providerResultsPromise = Promise.all(
				providerEnvelopes.map(async (entry) => {
					try {
						const adapter = (await materializeAdapter(entry)) as ProviderAdapter;
						validateProviderAdapter(adapter);
						validateAdapterIdentity("provider", entry.id, adapter);
						return { entry, adapter };
					} catch (error) {
						return { entry, error };
					}
				}),
			);
			const [pricing, providerResults] = await Promise.all([pricingPromise, providerResultsPromise]);
			const providers: ProviderAdapter[] = [];
			const providerDrafts = new Map<ProviderAdapter, ProviderModelDraft[]>();
			for (const result of providerResults) {
				if (!("adapter" in result) || result.adapter === undefined) {
					warnAdapterIssue(
						`excluded provider ${JSON.stringify(result.entry.id)}: ${
							result.error instanceof Error ? result.error.message : String(result.error)
						}`,
					);
					continue;
				}
				const adapter = result.adapter;
				try {
					const modelDrafts =
						result.entry.adapter.registration?.modelDrafts ?? result.entry.modelDrafts ?? adapter.provider.models;
					prepareProviderRegistration(adapter, runtime, pricing, modelDrafts);
					providerDrafts.set(adapter, modelDrafts);
					providers.push(adapter);
				} catch (error) {
					warnAdapterIssue(
						`excluded provider ${JSON.stringify(result.entry.id)}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			providers.sort(compareAdapterIds);
			const providerIds = new Set(providers.map(({ id }) => id));
			const dynamicProviderIds = new Set(
				envelopes
					.filter(
						(entry): entry is Extract<AdapterRegistrationEnvelope, { kind: "provider" }> =>
							entry.kind === "provider",
					)
					.map(({ id }) => id),
			);
			const resolvesProvider = (providerId: string): boolean =>
				providerIds.has(providerId) ||
				(!dynamicProviderIds.has(providerId) && nativeProviderExists(ctx, providerId));

			const statusEntries = groupedWithoutConflicts(
				envelopes.filter(
					(entry): entry is Extract<AdapterRegistrationEnvelope, { kind: "status" }> => entry.kind === "status",
				),
				(entry) => entry.id,
				"status ID",
			);
			const preflightEntries = groupedWithoutConflicts(
				envelopes.filter(
					(entry): entry is Extract<AdapterRegistrationEnvelope, { kind: "preflight" }> =>
						entry.kind === "preflight",
				),
				(entry) => entry.id,
				"preflight ID",
			);
			const tunerEntries = groupedWithoutConflicts(
				envelopes.filter(
					(entry): entry is Extract<AdapterRegistrationEnvelope, { kind: "tuner" }> => entry.kind === "tuner",
				),
				(entry) => entry.id,
				"tuner",
			);
			const statusResultsPromise = Promise.all(
				statusEntries
					.filter((item) => resolvesProvider(item.providerId))
					.map(async (entry) => {
						try {
							const adapter = (await materializeAdapter(entry)) as StatusAdapter;
							validateAdapter("status", adapter);
							validateAdapterIdentity("status", entry.id, entry.providerId, adapter);
							return { entry, adapter };
						} catch (error) {
							return { entry, error };
						}
					}),
			);
			const preflightResultsPromise = Promise.all(
				preflightEntries
					.filter((item) => resolvesProvider(item.providerId))
					.map(async (entry) => {
						try {
							const adapter = (await materializeAdapter(entry)) as PreflightAdapter;
							validateAdapter("preflight", adapter);
							validateAdapterIdentity("preflight", entry.id, entry.providerId, adapter);
							return { entry, adapter };
						} catch (error) {
							return { entry, error };
						}
					}),
			);
			const tunerResultsPromise = Promise.all(
				tunerEntries.map(async (entry) => {
					try {
						const adapter = (await materializeAdapter(entry)) as TunerAdapter;
						validateAdapter("tuner", adapter);
						validateAdapterIdentity("tuner", entry.id, adapter);
						return { entry, adapter };
					} catch (error) {
						return { entry, error };
					}
				}),
			);
			const [statusResults, preflightResults, tunerResults] = await Promise.all([
				statusResultsPromise,
				preflightResultsPromise,
				tunerResultsPromise,
			]);

			const statuses: StatusAdapter[] = [];
			for (const result of statusResults) {
				if ("adapter" in result && result.adapter !== undefined) statuses.push(result.adapter);
				else {
					warnAdapterIssue(
						`excluded status ${JSON.stringify(result.entry.id)}: ${
							result.error instanceof Error ? result.error.message : String(result.error)
						}`,
					);
				}
			}
			const statusBindings = groupedWithoutConflicts(statuses, (entry) => entry.providerId, "status binding").sort(
				compareAdapterIds,
			);

			const preflights: PreflightAdapter[] = [];
			for (const result of preflightResults) {
				if ("adapter" in result && result.adapter !== undefined) preflights.push(result.adapter);
				else {
					warnAdapterIssue(
						`excluded preflight ${JSON.stringify(result.entry.id)}: ${
							result.error instanceof Error ? result.error.message : String(result.error)
						}`,
					);
				}
			}
			const preflightBindings = groupedWithoutConflicts(
				preflights,
				(entry) => entry.providerId,
				"preflight binding",
			).sort(compareAdapterIds);

			const tuners: TunerAdapter[] = [];
			for (const result of tunerResults) {
				if ("adapter" in result && result.adapter !== undefined) tuners.push(result.adapter);
				else {
					warnAdapterIssue(
						`excluded tuner ${JSON.stringify(result.entry.id)}: ${
							result.error instanceof Error ? result.error.message : String(result.error)
						}`,
					);
				}
			}

			const definition = {
				providers,
				statuses: statusBindings,
				preflights: preflightBindings,
				tuners: tuners.sort(compareAdapterIds),
			};
			validateProviderKitDefinition(definition);
			return { definition, providerDrafts, pricing };
		};

		const ensureReady = (ctx?: ExtensionContext): Promise<ProviderKitRuntimeController | undefined> => {
			if (active) return Promise.resolve(active);
			if (readyPromise) return readyPromise;
			const generation = lifecycleGeneration;
			const pending = (async (): Promise<ProviderKitRuntimeController | undefined> => {
				if (disposed || generation !== lifecycleGeneration) return undefined;
				const { definition, providerDrafts, pricing } = await buildDefinition(ctx);
				if (disposed || generation !== lifecycleGeneration) return undefined;
				const providerIds = new Set(
					[...registrations.values()]
						.filter(
							(entry): entry is Extract<AdapterRegistrationEnvelope, { kind: "provider" }> =>
								entry.kind === "provider",
						)
						.map((entry) => entry.id),
				);
				if (typeof pi.unregisterProvider === "function") {
					for (const providerId of providerIds) pi.unregisterProvider(providerId);
				}
				if (disposed || generation !== lifecycleGeneration) return undefined;
				const controller = installProviderKitRuntime(pi, runtime, definition, pricing, {
					registerHandlers: false,
					providerDrafts,
				});
				if (disposed || generation !== lifecycleGeneration) {
					controller.shutdown();
					return undefined;
				}
				active = controller;
				installedDefinition = { generation, definition, providerDrafts };
				if (latestBackgroundPricing !== undefined) onBackgroundRefresh(latestBackgroundPricing);
				return controller;
			})();
			readyPromise = pending.catch((error) => {
				if (generation !== lifecycleGeneration || disposed) return undefined;
				readyPromise = undefined;
				warnAdapterIssue(
					`failed to assemble the Host registry: ${error instanceof Error ? error.message : String(error)}`,
				);
				return undefined;
			});
			return readyPromise;
		};

		pi.on("input", (_event, ctx) => {
			active?.clearStatusPresentation(ctx);
		});
		pi.on("session_start", (event, ctx) => {
			invalidateRuntime();
			scheduleModelCatalogRefresh(ctx, event.reason);
		});
		pi.on("before_provider_request", async (event, ctx) => {
			const controller = await ensureReady(ctx);
			if (!controller || !ctx.model) return;
			return controller.applyTunerPayload(event.payload, ctx.model);
		});
		pi.on("model_select", (event, ctx) => {
			void ensureReady(ctx).then((controller) => {
				if (controller) controller.handleModelSelect(event.model, ctx);
			});
		});
		pi.on("session_shutdown", () => {
			disposed = true;
			invalidateRuntime();
			unsubscribeHostClaim();
			unsubscribeBridge();
			unsubscribeRegistrations();
		});
		pi.registerCommand("status", {
			description: "Show status and diagnostics for the active provider",
			getArgumentCompletions: getStatusModeCompletions,
			handler: async (args, ctx) => {
				const controller = await ensureReady(ctx);
				if (controller) await controller.handleStatusCommand(args, ctx);
			},
		});
	};
}

function fetchOfficialPricingForHost(
	runtime: ProviderKitDependencies,
	onBackgroundRefresh?: (snapshot: Record<string, OfficialModelMeta>) => void,
) {
	return fetchOfficialPricing(
		runtime.fetch,
		runtime.officialPricingUrl,
		runtime.officialPricingTimeoutMs,
		runtime.officialPricingCacheTtlMs,
		runtime.officialPricingMaxStaleMs,
		runtime.now,
		{
			cachePath:
				runtime.officialPricingUrl === OPENROUTER_MODELS_URL ? runtime.openRouterMetadataCachePath : undefined,
			background: runtime.officialPricingUrl === OPENROUTER_MODELS_URL,
			onBackgroundRefresh,
		},
	);
}
