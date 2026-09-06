# MaaS adapter reference

This directory contains a copyable Provider and Preflight adapter pair for Ant Digital MaaS. It is outside the package-level `providers/` and `preflight/` directories, so installing `@hyav/pi-provider` does not enable MaaS automatically.

Copy both files into Pi's resolved agent directory:

```text
<agent-dir>/extensions/pi-provider/
  providers/maas.ts
  preflight/maas.ts
```

Set `MAAS_API_KEY`, run `/reload`, and select a model returned by the MaaS `/v1/models` endpoint. The Provider starts with an empty catalog, restores only validated raw model drafts, and refreshes the complete catalog without blocking Pi startup. Missing capability and pricing fields are completed from Pi's original-manufacturer catalog when a deterministic match exists.

The API key is sent only to `https://maas-api.antdigital.com/v1/models` for catalog discovery and Preflight. The example does not include a Status adapter because it does not assume an undocumented account or balance endpoint.
