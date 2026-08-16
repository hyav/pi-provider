# Security Policy

`@hyav/pi-provider` is a Pi extension. Its TypeScript source runs with the user's system privileges, can access configured Provider endpoints and credentials, and may perform explicitly requested account or model checks. Review the source and package artifact before installing extensions from untrusted sources.

## Supported versions

| Version or branch | Support |
|---|---|
| Latest published release | Best-effort security fixes |
| Older published releases | Not supported |
| Unreleased `main` | No compatibility or response-time promise |

There is no long-term-support branch. Upgrade to the latest release before reporting whether a problem is still present.

## Reporting a vulnerability

Do **not** report suspected vulnerabilities in a public issue, pull request, chat, or forum.

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/hyav/pi-provider/security/advisories/new). Include:

- affected package version, commit, or published artifact;
- reproduction steps or a minimal proof of concept;
- impact, prerequisites, and affected trust boundary;
- logs or traces with credentials, tokens, private endpoints, and personal data removed;
- a safe way to contact you for follow-up.

## Response and disclosure

Reports are handled on a best-effort basis; no acknowledgement, remediation, or disclosure deadline is guaranteed. The maintainer will coordinate a fix and public disclosure when affected users have a reasonable mitigation or upgrade path. Please do not publish details before then.

## Scope and dependency boundary

This policy covers the source repository, the published `@hyav/pi-provider` npm artifact, its Pi manifest, built-in adapters, credential handling, remote response validation, deadlines, and the Pi Provider runtime. The published artifact has no bundled runtime dependencies; its Pi core imports are host-supplied peers. CI runs both `npm run audit:runtime` for the published boundary and `npm run audit:all` for development and tested-host dependencies. Scanner findings are triaged rather than force-fixed across an untested host version.

Vulnerabilities in Pi, a Provider service, npm, GitHub, or another dependency should also be reported to the relevant upstream maintainer. For ordinary defects and usage questions, use [SUPPORT.md](SUPPORT.md) and the [public issue tracker](https://github.com/hyav/pi-provider/issues).

