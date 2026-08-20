# pi-provider

[简体中文](README.zh-CN.md)

A provider extension toolkit for [Pi](https://pi.dev). It registers LLM providers, discovers model catalogs, tunes requests, and reports cached or explicitly refreshed account status while preserving Pi's native footer.

[Adapter contract](https://github.com/hyav/pi-provider/blob/main/docs/adapter-extensions.md) · [Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## Highlights

- One Pi Provider Host for registration, status, preflight checks, live checks, and request tuners
- Provider, status, preflight, and tuner Adapter files discovered by one Pi entrypoint on `/reload`
- Resilient model catalogs with cached fallback, bounded background refresh, and failure retention
- Provider-first pricing metadata with optional OpenRouter completion and quality indicators
- Explicit diagnostics: cached `/status`, free `/status refresh`, and potentially billable `/status check`
- Built-in integrations for Charm Hyper, DeepSeek, Google Gemini, OpenAI Codex, OpenCode Zen, and OpenCode Go
- Status/preflight adapters for the native Pi providers Anthropic, GitHub Copilot, OpenRouter, Groq, and xAI
- Status/preflight adapters for Moonshot (Kimi) international and China platforms, and Hugging Face plan/credits
- Catalog preflight adapters for the native Pi providers OpenAI, Anthropic, Mistral, NVIDIA NIM, and Cerebras

## Install

Requires Node.js 22.19.0 or newer, Pi, and credentials for the providers you use.

```sh
pi install npm:@hyav/pi-provider
```


## Quick start

1. Configure credentials in Pi. Charm Hyper accepts `HYPER_API_KEY` or Pi's `/login` OAuth flow.
2. Select a model, for example:

   ```text
   /model charm-hyper/deepseek-v4-pro
   ```

3. Inspect the cached report:

   ```text
   /status
   ```

Use `/status refresh` for free endpoint, authentication, catalog, and account checks. Use `/status check` only when you explicitly accept a real model request and possible usage charges.

## Common configuration

| Name | Required | Default | Effect |
|---|---:|---|---|
| `HYPER_API_KEY` | For Charm Hyper API-key auth | None | Supplies the built-in `charm-hyper` provider credential; OAuth users may use `/login` |
| `PI_CODING_AGENT_DIR` | No | `~/.pi/agent` | Changes Pi's agent directory; public OpenRouter metadata is cached under `<agent-dir>/extensions/pi-provider/` |

Programmatic integrations can configure pricing fallback, pricing policies, request timeouts, metadata URLs, and cache paths through `createPiProviderRuntime()` or `createPiProviderHost()`. Programmatic defaults resolve the agent directory from `PI_CODING_AGENT_DIR` (falling back to `~/.pi/agent`) and keep the OpenRouter metadata cache on disk under `<agent-dir>/extensions/pi-provider/`, matching the table above; the Pi entrypoint overrides it with Pi's own resolution. Host packages with a custom capability root can call `createPiProviderExtension({ adapterRoot, dependencies })`. The source definition [`PiProviderDependencies`](core/runtime-config.ts) is authoritative.

## Adapter discovery (file-level plug and play)

Built-in Adapters ship inside the package and are always discovered. User Adapters live under Pi's resolved agent directory and are discovered too:

```text
<agent-dir>/extensions/pi-provider/
  providers/   # provider Adapter files
  status/      # status Adapter files
  preflight/   # preflight Adapter files
  tuners/      # tuner Adapter files
```


Add, remove, or modify files there, then run `/reload` to rediscover them without touching the package; edits to existing files are re-read from disk. User Adapters load after built-ins, so a same-ID file overrides the built-in Adapter (the Host keeps the latest registration and warns). `createPiProviderExtension({ adapterRoot })` replaces the default user directory with a custom root; built-ins are always scanned. The built-in Adapters under the package's `providers/`, `status/`, and `preflight/` are reference templates with this exact shape — copy one and customize it (Charm Hyper and `preflight/openai-codex.ts` also use package-private helpers).

Adapter files import helpers and types from `@hyav/pi-provider` (aliased inside the loader):

```ts
import { defineProviderExtension } from "@hyav/pi-provider";
```

Adapter files must not runtime-import Pi's bundled packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`); type-only imports are fine. Runtime values such as the agent directory, stored credentials, and the ANSI text wrapper are injected by the Pi entrypoint. See the [adapter extension contract](https://github.com/hyav/pi-provider/blob/main/docs/adapter-extensions.md) for helpers, validation, conflicts, reload behavior, and lifecycle boundaries. The root [`index.ts`](index.ts) defines the public TypeScript exports.

## Before you use it

`/status` is offline, `/status refresh` performs free remote checks, and `/status check` sends a live model request that may consume quota. Configured credentials are sent only to the corresponding provider endpoints and are omitted from status output.

## License

[MIT](LICENSE)
