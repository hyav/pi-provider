# Adapter Extension Design

This document defines the public contract for dynamically discovered Pi Provider adapter extensions. It outlines extension usage, lifecycle states, and fault boundaries.

## Goals

Users and packages can share Pi Provider capabilities without modifying Pi Provider's `index.ts`:

1. Add or remove TypeScript files in a capability directory — either inside the Host package (built-in Adapters) or under Pi's resolved agent directory `<agent-dir>/pi-provider/` (user Adapters);
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
<agent-dir>/pi-provider/
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

Each capability file contributes exactly one adapter using its designated helper. The built-in Adapters under `providers/`, `status/`, and `preflight/` follow this exact shape and are the reference templates: copy one into `<agent-dir>/pi-provider/` and customize it. Only the Charm Hyper files (and `preflight/openai-codex.ts`) additionally import package-private helper files, so prefer `preflight/deepseek.ts`, `status/deepseek.ts`, or `providers/` peers as the base for new Adapters.

```ts
// providers/example.ts
import { defineProviderExtension } from "@hyav/pi-provider";

export default defineProviderExtension({
  id: "example",
  create: ({ fetch, now, modelDiscoveryTimeoutMs }) => {
    // Return a synchronously usable fallback/cached catalog during factory execution.
    // Do not block extension startup on remote network calls.
    return createExampleProvider(fetch, modelDiscoveryTimeoutMs, now);
  },
});
```

Other directories use `defineStatusExtension`, `definePreflightExtension`, and `defineTunerExtension`. Identity metadata must be statically provided:

- Provider: `id`
- Status: `id`, `providerId`
- Preflight: `id`, `providerId`
- Tuner: `id`

Helpers validate static identity descriptors before instantiation and verify that the resulting Adapter identity matches. Adapter IDs must be non-empty, non-whitespace stable identifiers. Named exports may be provided for programmatic invocation, but the default export is the shared contract for the Host's internal loader and Pi's standalone-package loader.

## Lifecycle

### Extension Factory Phase

Pi re-executes the Host root extension factory upon startup and `/reload`. The root creates the Host, scans the built-in capability directories and then the user directory (`<agent-dir>/pi-provider/` or the `adapterRoot` override) in deterministic path order, and loads every current `.ts` or `.js` file. All Adapters share one module cache per load, so a file imported by more than one Adapter executes exactly once. Pi continues to load standalone Adapter packages from their own manifests. The Adapter helper:

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
- Removed files are cleaned up after reload;
- Previous Status, Preflight, and Live Check states do not leak into the new runtime.

## Validation and Fault Isolation

- Empty IDs, whitespace IDs, mismatched identities, invalid timing options, and malformed adapter shapes invalidate the affected module.
- Duplicate Adapter IDs within the same capability or duplicate Status/Preflight bindings for the same Provider keep the latest registration (user adapters load after built-ins, so they override) and warn; earlier entries are dropped.
- Provider conflicts clean up dynamic overrides, restoring native built-ins when present.
- A missing default export, thrown factory exception, or corrupted envelope isolates only the failing file without impacting healthy adapters. Load failures use capability-relative paths instead of exposing absolute installation paths.
- Status and Preflight adapters can bind to providers managed by Pi Provider or to native Pi Providers. Unresolvable bindings isolate the individual adapter and report diagnostic warnings.
