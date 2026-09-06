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

The static definitions in `providers/command-code/catalog.ts` are a representative subset used as an offline fallback and metadata scaffold. The live `/v1/models` endpoint is authoritative: models outside the subset are registered as raw drafts and completed by Pi's catalog fallback when a deterministic match exists.
