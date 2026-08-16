# Changelog

This file is the authoritative user-facing release history for `@hyav/pi-provider`.

## Unreleased

- Expose one Pi package entrypoint while preserving file-level Adapter discovery when `/reload` runs.
- Isolate invalid Adapter modules behind capability-relative diagnostics and declare `jiti` as the runtime loader.

## 0.1.1 - 2026-08-16

- Hardened zero-coupling contract tests and isolated temporary directories for manifest drop-in validation.
- Stabilized asynchronous pricing and metadata background refresh timing under high-load runners.

## 0.1.0 - 2026-08-16

- Initial public release of `@hyav/pi-provider`.
- Provider Kit host for dynamic providers, status, preflight, live checks, and request tuners.
- Manifest-discovered adapter extensions with deterministic ordering, reload isolation, validation, and conflict handling.
- Cached model catalogs, bounded background refresh, pricing metadata, and explicit free-versus-billable diagnostics.
- Built-in Charm Hyper, DeepSeek, Google Gemini, OpenAI Codex, OpenCode Zen, and OpenCode Go integrations.
