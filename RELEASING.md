# Releasing `@hyav/pi-provider`

This repository publishes from a reviewed jj revision. A `v*` tag triggers `.github/workflows/publish.yml`, which verifies the tag, publishes the npm package with npm Trusted Publishing/OIDC, and creates the matching GitHub Release.

`RELEASING.md` is a maintainer runbook and is intentionally excluded from the npm artifact.

## Current release state

`0.2.0` is the current release candidate. Its package metadata, lockfile, and changelog are prepared in the candidate revision, but no `v0.2.0` tag or GitHub Release exists yet. The current npm `latest` dist-tag remains `0.1.8`. After review and merge of the candidate revision into `main`, create `v0.2.0` on that exact commit and let the publish workflow run. The temporary `0.1.0-oidc-bootstrap.0` registry record is an unsupported historical version and must remain deprecated; it has no Git tag and must not be reused or unpublished.

Trusted Publishing is configured for the `hyav/pi-provider` GitHub Actions workflow. Future releases must use a reviewed `v<version>` tag; no local npm token or bootstrap publication is needed.

## Release process

1. Update `package.json` and `CHANGELOG.md` together.
2. Run the repository quality gate and inspect the real npm artifact.
3. Record the final jj revision and create `v<version>` on that exact revision.
4. Push the reviewed commit and tag through the configured GitHub remote.
5. Confirm the `publish` job receives `id-token: write` and publishes without `NPM_TOKEN`.
6. Verify the npm provenance record, the version-specific GitHub Release notes, and the GitHub Release assets.

Do not reuse a published version or move a published tag. If npm publication succeeds but GitHub Release creation fails, rerun the failed `release` job after checking the uploaded assets; do not publish the same npm version again.

## Registry and repository controls

Keep npm two-factor authentication enabled and use Trusted Publishing/OIDC for releases. The `main` branch and `v*` release tags are protected in GitHub. Do not reuse a published version or move a published tag.

References: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), and [staged publishing](https://docs.npmjs.com/staged-publishing/).
