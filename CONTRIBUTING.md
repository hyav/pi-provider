# Contributing

Thank you for helping improve `@hyav/pi-provider`. The canonical user contract is in [README.md](README.md); adapter extension contracts are in [`docs/adapter-extensions.md`](docs/adapter-extensions.md).

## Before you start

- Search existing [GitHub issues](https://github.com/hyav/pi-provider/issues) before opening a new one.
- For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of using a public issue.
- Keep changes focused. Do not include credentials, personal data, private fixtures, generated local state, or ignored private overlays.

## Development setup

Use Node.js `22.19.0` or later with npm. The tested Pi host baseline is `0.84.1`:

```sh
npm ci --ignore-scripts
```

Pi loads the published TypeScript source through its extension loader. Do not add a compiled `dist/` tree unless the package contract is deliberately changed and documented.

## Required checks

Run the same deterministic gate used by CI:

```sh
npm run audit:runtime
npm run audit:all
npm run check
npm test
npm run artifact:check
```

- `npm run audit:runtime` checks the published dependency boundary for high-severity advisories.
- `npm run audit:all` also checks the development and tested-host dependency tree.
- `npm run check` runs Biome and TypeScript type checking.
- `npm test` runs Node test runner suites under `test/` against local servers, isolated caches, and deterministic fixtures.
- `npm run artifact:check` builds a real npm tarball, rejects repository-only files, installs it in a temporary consumer, and loads the published Pi entry points.

The ordinary gate must not make real model requests or require billable credentials.

## Changes and review

- Public behavior changes must include behavior-focused tests and documentation updates.
- Keep `README.md` canonical and update `README.zh-CN.md` when user-visible behavior changes.
- Update [CHANGELOG.md](CHANGELOG.md) for release-relevant behavior, compatibility, security, or migration changes.
- Preserve the source-package boundary in `package.json.files`; tests, fixtures, scripts, and local caches must not enter the npm artifact.
- Treat model IDs, pricing metadata, and provider status as security-sensitive input. Keep validation, deadlines, and footer boundaries intact.

## Reporting defects

Use a public [GitHub issue](https://github.com/hyav/pi-provider/issues) for reproducible defects and include, when safe:

- package version or commit;
- Node.js, Pi, and Provider versions;
- Provider and model IDs, without API keys or OAuth tokens;
- expected and actual behavior;
- a minimal reproduction and redacted logs.

Do not disclose vulnerability details or credentials publicly; follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is provided under the repository's [MIT License](LICENSE).
