# Changelog

This file is the authoritative user-facing release history for `@hyav/pi-provider`.

## Unreleased

- Add Status and Preflight Adapters for Pi native providers: Anthropic (subscription extra usage), OpenRouter (key credits and free tier), Groq (rate-limit headers), xAI (rate-limit headers), and GitHub Copilot (Individual plan quotas).
- Expose the stored credential type (`oauth` vs `api_key`) to Status Adapters through `getCredentialType()`.

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
