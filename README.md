# @hyav/pi-provider

[简体中文](README.zh-CN.md)

A provider extension toolkit for [Pi](https://pi.dev). It registers LLM providers, discovers model catalogs, tunes requests, and reports cached or explicitly refreshed account status while preserving Pi's native footer.

[Adapter contract](https://github.com/hyav/pi-provider/blob/main/docs/adapter-extensions.md) · [Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## Highlights

- One Provider Kit Host for registration, status, preflight checks, live checks, and request tuners
- Manifest-discovered provider, status, preflight, and tuner adapters reloaded with `/reload`
- Resilient model catalogs with cached fallback, bounded background refresh, and failure retention
- Provider-first pricing metadata with optional OpenRouter completion and quality indicators
- Explicit diagnostics: cached `/status`, free `/status refresh`, and potentially billable `/status check`
- Built-in integrations for Charm Hyper, DeepSeek, Google Gemini, OpenAI Codex, OpenCode Zen, and OpenCode Go

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
| `PI_CODING_AGENT_DIR` | No | `~/.pi/agent` | Changes the base directory for public OpenRouter metadata cache |

Programmatic integrations can configure pricing fallback, pricing policies, request timeouts, metadata URLs, and cache paths through `createProviderKitRuntime()` or `createProviderKitHost()`. The source definition [`ProviderKitDependencies`](core/runtime-config.ts) is authoritative.

Trusted packages can add adapters through manifest entries under `providers/`, `status/`, `preflight/`, and `tuners/`. See the [adapter extension contract](https://github.com/hyav/pi-provider/blob/main/docs/adapter-extensions.md) for helpers, validation, conflicts, reload behavior, and lifecycle boundaries. The root [`index.ts`](index.ts) defines the public TypeScript exports.

## Before you use it

`/status` is offline, `/status refresh` performs free remote checks, and `/status check` sends a live model request that may consume quota. Configured credentials are sent only to the corresponding provider endpoints and are omitted from status output.

## License

[MIT](LICENSE)
