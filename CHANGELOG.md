# Changelog

This file is the authoritative user-facing release history for `@hyav/pi-provider`.

## Unreleased

- Make Pi catalog model matching identity-conservative: exact IDs match first; only then are known manufacturer/transport prefixes (`z-ai/`, `x-ai/`, `mistralai/`, OpenRouter `~` mirror variants, `openapi/`, `models/`) and tier suffixes (`:free`, `-free`, `:batch`, `-batch`) stripped for a unique normalized match. Capability variants (`-pro`, `-flash`, …) are never folded into base models, and a bare ID never resolves to a dated entry; a date-pinned version (`deepseek-v4-flash-0731`) falls back to the bare base model's data only when no pinned entry exists, never to another pinned date. Ambiguous multi-candidate matches are rejected instead of guessed. Custom providers that are absent from the catalog now fall back to the global candidate pool during normalization instead of silently matching nothing. Provider-declared pricing (including explicit free tiers) remains authoritative with no free-tier special-casing.

## 0.2.0 - 2026-09-06

- Add Pi catalog fallback based on `@earendil-works/pi-ai` built-in models, scoped to original manufacturer providers (`anthropic`, `openai`, `google`, `deepseek`, `mistral`, `xai`, `minimax`, `minimax-cn`, `moonshotai`, `moonshotai-cn`, `kimi-coding`, `zai`, `zai-coding-cn`, `xiaomi`, and `ant-ling`), strictly excluding OpenRouter, third-party proxies, aggregators, and token plans.
- Supplement registered provider models with missing fields (`cost`, `contextWindow`, `maxTokens`, `input` modalities, `reasoning`, `thinkingLevelMap`, and `compat`) using deterministic matching and field-level provenance (`provider`, `pi`, `mixed`, `default`, `normalized`); support disabling fallback per adapter via `usePiModelMetaFallback: false`.
- Establish dynamic provider adapter persistence contract: dynamic adapters must persist raw model drafts instead of normalized default models to prevent defaulted capabilities from suppressing manufacturer metadata in the Pi catalog fallback; detect and invalidate legacy normalized snapshots.
- Add a copyable Ant Digital MaaS Provider and Preflight example with authenticated dynamic discovery, bounded catalog parsing, raw-draft cache migration, timeout handling, and model matching.
- Prevent the OpenRouter Preflight adapter from reporting a successful authentication check when no usable credential is resolved.
- Refactor `/status` reporting: compress `Catalog:`, `Health:`, and `Account:` to compact single lines, merge `Reasoning:` and `Thinking levels:` into a single line, and display field-level provenance.
- Remove OpenRouter generic model metadata, pricing completion, and cache mechanisms (`openrouter-model-metadata.json`, `fetchOfficialModelMetadata()`, `fetchOfficialPricing()`, `applyOfficialModelMetadata()`, `applyOfficialModelCosts()`, `parseOpenRouterModels()`, `parseOpenRouterPricing()`, `findOfficialMeta()`, `findOfficialCost()`, `getDefaultOpenRouterMetadataCachePath()`, and `OPENROUTER_MODELS_URL`); OpenRouter as a native Pi provider with its own status/preflight adapters remains fully supported.
- Remove benchmark quality runtime, adapters, caching, and diagnostics (`QualityManager`, Artificial Analysis, LiveBench, Agent Arena, `/status quality`, `ARTIFICIAL_ANALYSIS_API_KEY`, and quality cache directories).

## 0.1.8 - 2026-09-01

- Make Charm Hyper model catalogs online-only: use the last successful online snapshot when refresh is unavailable and an empty catalog when no snapshot exists; remove package-maintained static model, pricing, and model-specific capability fallbacks.
- Skip malformed individual Charm Hyper models while retaining valid entries, and use Provider metadata before OpenRouter metadata when filling model fields.
- Add a public model-catalog lifecycle helper for cached snapshot restoration, TTL checks, generation-guarded publication, persistence fallback, complete live replacement, and failure retention; migrate Charm Hyper to it.
- Share one model-catalog discovery request across concurrent callers with different cancellation signals, while keeping caller cancellation and generation-guarded publication independent.
- Separate successful-catalog TTL from exponential failure backoff, expose attempt, success, failure-count, and retry diagnostics, and show retry timing in `/status`.
- Report bounded invalid and duplicate model counts for accepted online catalogs without retaining remote model IDs or payload content.
- Add accurately named OpenRouter metadata APIs (`fetchOfficialModelMetadata()` and `applyOfficialModelMetadata()`), migrate internal callers, and retain the pricing-named APIs as deprecated compatibility wrappers.
- Extend field-level provenance to normalized cost and thinking-level maps while keeping `pricing.source` authoritative for known and effective pricing.
- Normalize partial model costs before applying pricing adjustments so registered model costs and pricing sidecars remain consistent; report fields rewritten at the registration boundary as `normalized`.

## 0.1.7 - 2026-08-24

- Refresh the active model catalog dynamically on `/status refresh` and `/status check` by delegating to Pi's model registry with forced network revalidation, keeping the displayed model catalog and model counts up to date without requiring `/reload`.

## 0.1.6 - 2026-08-24

- Prevent Charm Hyper model-refresh warnings when no credentials are configured by registering OAuth-capable Providers without unresolved optional environment API keys and clearing stale API-key configuration after `/reload`; configured environment and stored API keys remain supported.

## 0.1.5 - 2026-08-24

- Skip network model-catalog refreshes for Providers whose environment-backed API key is not configured and which have no resolved stored credential, retaining cached models without Pi refresh warnings.
- Apply bounded validation to initial, cached, and refreshed model catalogs, including model-count, field-length, and control-character checks.
- Route Status, Preflight, and Live Check requests through each model credential's effective headers and base URL, and skip account endpoints that cannot be mapped without risking credential disclosure.
- Defer official metadata network refreshes until session startup, cancel them during shutdown, and preserve refreshed dynamic catalogs when pricing updates race with model discovery.
- Derive metadata cache paths after resolving the agent directory and disable persistence when no agent directory is configured.
- Report the Vercel AI Gateway public catalog check without claiming it verifies authentication.
- Export diagnostic authentication helpers through the public Adapter API so installed user Adapters remain independently loadable.

## 0.1.4 - 2026-08-21

- Add Status and Preflight Adapters for the Vercel AI Gateway (auth, model catalog, and credits).
- Add Status and Preflight Adapters for Pi native providers Moonshot (Kimi) international and China platforms, and Hugging Face router (plan/credits via `whoami-v2`).
- Report Moonshot balance currency by platform: USD for the international platform and CNY for the China platform.
- Skip MiniMax Token Plan status: the documented `/coding_plan/remains` endpoint requires a web session cookie, not the API key, and its field semantics are known to be unreliable (see MiniMax-M2 issues #88 and #99).
- Add first-batch catalog Preflight Adapters for Pi native providers: OpenAI, Anthropic, Mistral, NVIDIA NIM, and Cerebras.
- Add a shared OpenAI-style catalog preflight helper (`createCatalogPreflightAdapter`).
- Add Status and Preflight Adapters for Pi native providers: Anthropic (subscription extra usage), OpenRouter (key credits and free tier), Groq (rate-limit headers), xAI (rate-limit headers), and GitHub Copilot (Individual plan quotas).
- Route Anthropic credentials by type: API keys (`sk-ant-api...`) use `x-api-key` for preflight catalog checks and default status without sending keys to subscription endpoints; OAuth tokens (`sk-ant-oat...`) query subscription usage and send `Authorization: Bearer`.
- Parse compound duration strings (`2m59.56s`, `7.66s`, `250ms`, `1d`, `1h30m`) and bare seconds in rate-limit reset headers for Groq and xAI status adapters.
- Expose the stored credential type (`oauth` vs `api_key`) to Status and Preflight Adapters through `getCredentialType()`.
- Align Charm Hyper status adapter cache TTL with standard status adapters (60s).

## 0.1.3 - 2026-08-17

- Discover user Adapter files under `<agent-dir>/extensions/pi-provider/` in addition to built-ins; user files load last and override same-ID built-ins.
- Run the provider runtime inside a single Jiti module graph behind a thin Pi entrypoint; inject the agent directory, stored credentials, and ANSI text wrapping.
- Export the Adapter API through a Jiti-safe public entrypoint aliased as `@hyav/pi-provider`, aligned with the built-in Adapters as reference templates.
- Resolve duplicate Adapter IDs and bindings to the latest registration with a warning instead of excluding all colliding entries.
- Re-read modified Adapter files on `/reload` by clearing the Adapter module cache.
- Restore the programmatic default OpenRouter metadata cache path under the resolved agent directory.

## 0.1.2 - 2026-08-17

- Expose one Pi package entrypoint while preserving file-level Adapter discovery when `/reload` runs.
- Isolate invalid Adapter modules behind capability-relative diagnostics and declare `jiti` as the runtime loader.
- Rename the public APIs to Pi Provider equivalents and remove legacy aliases; programmatic consumers must update those imported names.
- Store generated metadata under `<agent-dir>/pi-provider/`, following Pi's resolved agent directory.

## 0.1.1 - 2026-08-16

- Hardened zero-coupling contract tests and isolated temporary directories for manifest drop-in validation.
- Stabilized asynchronous pricing and metadata background refresh timing under high-load runners.

## 0.1.0 - 2026-08-16

- Initial public release of `@hyav/pi-provider`.
- Pi Provider host for dynamic providers, status, preflight, live checks, and request tuners.
- Manifest-discovered adapter extensions with deterministic ordering, reload isolation, validation, and conflict handling.
- Cached model catalogs, bounded background refresh, pricing metadata, and explicit free-versus-billable diagnostics.
- Built-in Charm Hyper, DeepSeek, Google Gemini, OpenAI Codex, OpenCode Zen, and OpenCode Go integrations.
