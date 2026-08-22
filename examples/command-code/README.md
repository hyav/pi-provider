# Command Code adapter reference

This directory contains a reference implementation of Provider, Status, and Preflight adapters for Command Code.

It is intentionally outside the package-level `providers/`, `status/`, and `preflight/` directories, so the package does not load or enable Command Code by default.

To use it as a user adapter, copy the contents into:

```text
<agent-dir>/extensions/pi-provider/
  providers/command-code.ts
  providers/command-code/catalog.ts
  providers/command-code/auth.ts
  status/command-code.ts
  preflight/command-code.ts
```

The implementation reads `COMMAND_CODE_API_KEY` and supported aliases, and may also read Command Code credential files from the current user's home directory. Do not commit credentials or local metadata caches.

The optional `openrouter-model-metadata.json` file used by the original local installation is not part of this reference directory; the catalog falls back to its built-in metadata when it is absent.
