# Adapter Extension Design

This document defines the public contract for dynamically discovered Pi Provider adapter extensions. It outlines extension usage, lifecycle states, and fault boundaries.

## Goals

Users and packages can share Pi Provider capabilities without modifying Pi Provider's `index.ts`:

1. Add or remove TypeScript files in a capability directory — either inside the Host package (built-in Adapters) or under Pi's resolved agent directory `<agent-dir>/extensions/pi-provider/` (user Adapters);
2. Install another local, npm, or Git Pi package;
3. Execute `/reload`.

Discovered Providers, Statuses, Preflights, and Tuners are incorporated into a single unified Pi Provider Host after reload. Hot swapping within an active session without a reload is intentionally not supported.

## Package Layout

Both the Pi Provider Host package and standalone Adapter packages follow standard capability directory conventions:

```text
package-root/
  index.ts                 # Pi Provider Host (one per runtime)
  providers/*.ts           # Provider Adapter Extensions
  status/*.ts              # Status Adapter Extensions
  preflight/*.ts           # Preflight Adapter Extensions
  tuners/*.ts              # Tuner Adapter Extensions
```

The Host also discovers user Adapters under Pi's resolved agent directory, without touching any package:

```text
<agent-dir>/extensions/pi-provider/
  providers/*.ts           # user Provider Adapter Extensions
  status/*.ts              # user Status Adapter Extensions
  preflight/*.ts           # user Preflight Adapter Extensions
  tuners/*.ts              # user Tuner Adapter Extensions
```

Built-in capability directories are scanned first and the user directory second, so a user file with the same Adapter ID overrides the built-in one. `createPiProviderExtension({ adapterRoot })` replaces the default user directory with a custom root; built-ins are always scanned.

The Host package declares only its root Pi entrypoint. The root scans its capability directories at startup and on `/reload`, so Pi displays the Host package as one extension while file-level additions and removals remain discoverable:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

As a result, `pi config` enables or disables the Host package as a whole rather than selecting individual capability files. Put Adapters that require independent enablement in a standalone Adapter package.

Standalone Adapter packages declare only their own capability entry points. Pi isolates module roots across packages, preventing an installed package from directly resolving another package's `node_modules`. An npm Adapter package importing helpers from `@hyav/pi-provider` must list it under both `dependencies` and `bundledDependencies`:

```json
{
  "name": "example-provider-adapters",
  "dependencies": {
    "@hyav/pi-provider": "^0.1.0"
  },
  "bundledDependencies": ["@hyav/pi-provider"],
  "pi": {
    "extensions": [
      "./providers/*.ts",
      "./status/*.ts",
      "./preflight/*.ts",
      "./tuners/*.ts"
    ]
  }
}
```

Only core host packages provided by Pi should use `peerDependencies` with `"*"`. Files in the Host capability directories and files matched by standalone package glob patterns must default-export a Pi extension factory. Standalone Adapter packages must not re-declare or re-execute the Host's `index.ts`.

## File Contract

Each capability file contributes exactly one adapter using its designated helper. The built-in Adapters under `providers/`, `status/`, and `preflight/` follow this exact shape and are the reference templates: copy one into `<agent-dir>/extensions/pi-provider/` and customize it. Only the Charm Hyper files (and `preflight/openai-codex.ts`) additionally import package-private helper files, so prefer `preflight/deepseek.ts`, `status/deepseek.ts`, or `providers/` peers as the base for new Adapters.

```ts
// providers/example.ts
import { defineProviderExtension } from "@hyav/pi-provider";

export default defineProviderExtension({
  id: "example",
  create: ({ fetch, now, modelDiscoveryTimeoutMs }) => {
    // Return the last online snapshot or an explicit static fallback synchronously.
    // Use an empty catalog when neither exists; never block startup on network access.
    return createExampleProvider(fetch, modelDiscoveryTimeoutMs, now);
  },
});
```

Dynamic Provider adapters may use the public `createModelCatalogLifecycle()` helper for snapshot restoration, TTL checks, generation-guarded publication, persistence fallback, complete live replacement, and retention of the last successful catalog after errors. The adapter remains responsible for endpoint authentication, response parsing and validation, stored-model conversion, error-code mapping, and assigning `onUpdate` models to its Provider definition. `initialModels` represents an explicit static fallback; omit it to start with `source: "empty"`. A restored snapshot is reported as `"cached"`, while a successful network publication is `"live"`. All concurrent callers share at most one Provider-level discovery request even when they have different signals. Cancelling one caller stops only that caller's wait; it does not cancel the bounded shared request or other callers. Generation-guarded publication attempts are serialized so a newer valid caller can publish when an older caller is rejected. Successful-catalog TTL and failure retry timing are independent: failures use exponential backoff from 30 seconds up to 15 minutes by default, configurable with `failureBackoffMs` and `maxFailureBackoffMs`, while `force` bypasses both TTL and retry backoff. Catalog diagnostics expose the last successful refresh, last attempt, consecutive failure count, and next retry time. A discovery function may return either a model array or `{ models, diagnostics }`; diagnostics support only non-negative safe-integer `rejectedCount` and `duplicateCount` values. These counts are published only with an accepted catalog and never contain rejected IDs, payload fragments, or response bodies.

### Public Façade API (`@hyav/pi-provider`)

Capability files imported through the Jiti loader resolve `@hyav/pi-provider` to `core/public-adapters.ts`. This entrypoint exposes all runtime functions and TypeScript types required by built-in and user adapters without exposing Host-only internal APIs (such as `createPiProviderHost` or `loadPiCatalog`):

- **Extension Factories**: `defineProviderExtension`, `defineStatusExtension`, `definePreflightExtension`, `defineTunerExtension`
- **Validation & Limits**: `MAX_PROVIDER_MODEL_COUNT`, `validateProviderModelDrafts`, `normalizeProviderModels`
- **Lifecycle Management**: `createModelCatalogLifecycle`
- **Preflight & Status Helpers**: `createCatalogPreflightAdapter`, `createOpenCodeCatalogPreflightAdapter`, `parseRetryAfter`
- **HTTP, Deadlines & Errors**: `withDeadline`, `appendBaseUrlPath`, `authDefinesHeader`, `getContextAuth`, `hasBaseUrlOrigin`, `mergeDiagnosticHeaders`, `isProviderDataError`, `ProviderDataError`
- **Legacy Snapshot Migration**: `isLegacyNormalizedModel`, `isLegacyNormalizedSnapshot`
- **Types**: `AdapterExtensionContext`, `ProviderExtensionDefinition`, `StatusExtensionDefinition`, `PreflightExtensionDefinition`, `TunerExtensionDefinition`, `ModelCatalogDiagnostics`, `ModelCatalogDiscoveryResult`, `ModelCatalogLifecycle`, `ModelCatalogLifecycleOptions`, `ModelCatalogSource`, `ModelCatalogStatus`, `PreflightAdapter`, `PreflightContextLike`, `PreflightModel`, `PreflightSnapshot`, `StatusContextLike`, `ActiveModel`, `ProviderAdapter`, `ProviderCost`, `ProviderModel`, `ProviderModelDraft`, `ProviderPricingAdjustment`, `ProviderPricingPolicy`, `ProviderPricingSource`, `ProviderRefreshContext`, `ProviderRequestAuth`, `StatusAdapter`, `StatusContext`, `StatusEntry`, `StatusSnapshot`, `StoredCredentialLike`, `ThinkingLevel`, `TunerAdapter`, `TunerContext`

### Capability and Metadata Precedence

Model metadata follows a strict three-tier precedence model:

1. **Provider Explicit Endpoints (Highest Precedence)**: Capabilities explicitly parsed from the Provider endpoint (such as `contextWindow`, `maxTokens`, `cost`, `input`, `reasoning`, `thinkingLevelMap`, and `compat`) take top priority. Explicit false values (`reasoning: false`), explicit zero pricing (`cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`), and explicit single-modality lists (`input: ["text"]`) are preserved verbatim and never overridden by subsequent tiers.
2. **Pi Catalog Fallback**: When a field is omitted or undefined in the raw `ProviderModelDraft`, the Pi catalog fallback matches against original manufacturer providers (Anthropic, OpenAI, Google, DeepSeek, Mistral, xAI, MiniMax, Moonshot/Kimi, ZAI, Xiaomi, and Ant-Ling) to populate missing pricing, context limits, reasoning flags, thinking maps, and input modalities. Ambiguous or multi-match candidates are rejected. The fallback only augments models already declared by the provider; it never fabricates new models.

   Model matching is identity-conservative. The full ID is matched exactly first; only when that fails are known transport/manufacturer prefixes (`z-ai/`, `x-ai/`, `mistralai/`, OpenRouter `~` mirror variants such as `~deepseek/`, `openapi/`, `models/`) and tier suffixes (`:free`, `-free`, `:batch`, `-batch`) stripped before a unique normalized match is accepted. Date-pinned versions (`deepseek-v4-flash-0731`) and capability variants (`-pro`, `-flash`, `-mini`, …) are never folded into a base model: a bare ID never resolves to a dated entry, a dated ID never resolves to the bare entry or another date, and multiple normalized candidates are rejected rather than guessed. Pricing is orthogonal to matching: provider-declared costs, including explicit free tiers, always win, and the catalog price is used only when the provider declares none (no free-tier special-casing).
3. **Default Normalization Fallback (Lowest Precedence)**: If a capability remains undefined after both the Provider endpoint response and Pi catalog fallback, final defaults are applied (`contextWindow: 128_000`, `maxTokens: 16_384`, `cost: 0`, `reasoning: false`, `input: ["text"]`).

### Raw Drafts and Cache Boundary

Dynamic Provider adapters that persist or cache discovered models (such as in Pi's `models-store.json` or local snapshot files) **must persist raw model drafts** (such as `{ id, name, api, baseUrl, provider }`) rather than normalized models with defaulted capabilities (`contextWindow: 128000`, `maxTokens: 16384`, `cost: 0`, `reasoning: false`).

When an adapter injects normalized defaults before persisting, those defaults are treated upon reload or cache restoration as explicit provider-declared capabilities, permanently overriding and suppressing the Pi catalog fallback (such as 1M context windows, 384k output limits, official pricing, reasoning capabilities, and thinking levels).

Adapters migrating from earlier versions that serialized normalized models must detect and invalidate legacy normalized snapshots using `isLegacyNormalizedSnapshot()` so that fresh online discovery restores raw metadata and allows the Pi catalog fallback to enrich models with accurate manufacturer capabilities.

### Credential and Routing Security Boundaries

- **Credential Scoping**: Adapters declare credentials using environment variable references (`$NAME` or `${NAME}`) or OAuth configurations. Diagnostic routines, status snapshots, and logs must never expose or serialize raw API keys, bearer tokens, or secret headers.
- **Endpoint Route Isolation**: Network requests must remain strictly bounded to the provider's configured origin and baseUrl. Status and preflight checks must avoid sending credentials to unmapped or unexpected hosts.

Status diagnostics support:
- `/status`: offline inspection of cached diagnostics, compressed single lines (Catalog, Health, Account), merged Thinking levels, and field-level provenance;
- `/status refresh`: free network refresh of catalogs, health checks, and account status;
- `/status check`: live probe prompt to verify end-to-end model availability (may incur usage costs).

Other directories use `defineStatusExtension`, `definePreflightExtension`, and `defineTunerExtension`. Identity metadata must be statically provided:

- Provider: `id`
- Status: `id`, `providerId`
- Preflight: `id`, `providerId`
- Tuner: `id`

Helpers validate static identity descriptors before instantiation and verify that the resulting Adapter identity matches. Adapter IDs must be non-empty, non-whitespace stable identifiers. Named exports may be provided for programmatic invocation, but the default export is the shared contract for the Host's internal loader and Pi's standalone-package loader.

## Lifecycle

### Extension Factory Phase

Pi re-executes the Host root extension factory upon startup and `/reload`. The root creates the Host, scans the built-in capability directories and then the user directory (`<agent-dir>/extensions/pi-provider/` or the `adapterRoot` override) in deterministic path order, and loads every current `.ts` or `.js` file. All Adapters share one module cache per load, so a file imported by more than one Adapter executes exactly once. Pi continues to load standalone Adapter packages from their own manifests. The Adapter helper:

1. Validates the static descriptor;
2. Instantiates the Adapter;
3. Calls Pi's `registerProvider()` for Providers via the Pi Provider startup bridge;
4. Emits a versioned registration envelope (`version: 2`) across `pi.events`;
5. Registers a synchronous `session_start` replay handler.

Providers must complete Pi registration before the factory returns, ensuring that initial model selection and `pi --list-models` function immediately. Dynamic Provider factories must return synchronously usable initial snapshots and avoid blocking network calls. Status, Preflight, and Tuner extensions do not instantiate managers or trigger diagnostic network requests during this phase.

### `session_start` Phase

Upon receiving all Adapter replays, the Host constructs the per-session registry and initializes Status, Preflight, and Live Check managers along with deterministic Tuners. Independent Adapter factories instantiate concurrently while preserving registration dependencies.

Host ordering follows deterministic rules:
- Sorted by Adapter ID within each capability namespace;
- Tuners sorted by ascending `priority`, then by Adapter ID.

### `session_shutdown` and `/reload`

The previous Host aborts inflight requests, clears caches and diagnostics, and unregisters event listeners. Each Pi runtime supports exactly one active Host. `/reload` re-executes the root entrypoint, scans the current capability files, and constructs a fresh Host:

- Newly added files become active after reload;
- Modified files are re-read from disk, so edits to existing Adapters take effect after reload;
- Removed files are cleaned up after reload;
- Previous Status, Preflight, and Live Check states do not leak into the new runtime.

## Validation and Fault Isolation

- Empty IDs, whitespace IDs, mismatched identities, invalid timing options, and malformed adapter shapes invalidate the affected module.
- Duplicate Adapter IDs within the same capability or duplicate Status/Preflight bindings for the same Provider keep the latest registration (user adapters load after built-ins, so they override) and warn; earlier entries are dropped.
- Provider conflicts clean up dynamic overrides, restoring native built-ins when present.
- A missing default export, thrown factory exception, or corrupted envelope isolates only the failing file without impacting healthy adapters. Load failures use capability-relative paths instead of exposing absolute installation paths.
- Status and Preflight adapters can bind to providers managed by Pi Provider or to native Pi Providers. Unresolvable bindings isolate the individual adapter and report diagnostic warnings.
