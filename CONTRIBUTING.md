# Contributing to YetAnotherSqlTool

Thanks for your interest! Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Prerequisites

- Node.js, version in [`.nvmrc`](.nvmrc) (`nvm use`)
- Docker, for the integration tests and the local development databases
- VS Code

## Setup

```bash
git clone https://github.com/lucaslenglet/YetAnotherSqlTool.git
cd YetAnotherSqlTool
npm ci
```

## Development workflow

```bash
npm run dev:db        # start local dev databases on 127.0.0.1
npm run watch         # rebuild on change
```

Press F5 in VS Code: it builds the extension and opens `dev-workspace/`, whose settings
pre-define connections to the dev databases (ports and the dev-only password are in
`scripts/dev-db.mjs`).

## Tests, lint and format

```bash
npm run typecheck
npm test                    # unit tests, no Docker needed
npm run test:integration    # starts SQL Server and PostgreSQL with Testcontainers (Docker)
npm run test:vscode         # end-to-end test of the packaged extension in a real VS Code (Docker + a display)
npm run screenshots         # regenerate media/screenshots/*.png for the README (Docker + a display)
npm run lint
npm run format              # npm run format:check to only verify
```

`npm run test:vscode` packages the extension, installs the `.vsix` into a blank VS Code profile
under `.vscode-test/` (your own VS Code is never touched), starts SQL Server and PostgreSQL with
Testcontainers, and uses the extension as a user would: Object Explorer, connect, run a query,
read the results webview, copy, connection dialog. A VS Code window opens for about ten seconds;
on a machine without a display, run it under `xvfb-run -a`. Options: `-- --version minimum`
(oldest VS Code allowed by `engines.vscode`) or an exact version, `-- --vsix <file>` to test an
existing package. When a test fails, the DOM of the window and of the webviews is saved in
`.vscode-test/run/artifacts/`. It rebuilds `dist/` as a production build.

`npm run screenshots` regenerates the images of `media/screenshots/` used by the README the same
way (packaged extension, Docker databases with demo data, a real VS Code window for about a minute);
re-run it when the UI changes visibly and commit the PNG files.

CI runs all of these on every pull request. Please add or update tests with your change.

## Project layout

See the "Architecture" section of [CLAUDE.md](CLAUDE.md). In short: React webviews copied from
vscode-mssql talk to controllers in `src/controllers/`; connections, Object Explorer and query
execution go through the `Driver` interface in `src/drivers/` (one folder per engine).
Adding an engine means a new `DriverId` plus a driver folder.

## Code copied from vscode-mssql

UX fidelity to vscode-mssql is the top priority. Files copied from it keep their
`Copyright (c) Microsoft Corporation` header (an MIT license condition) and must stay as close
to upstream as possible. Read `docs/vscode-mssql-analysis.md` before porting anything.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR
  titles: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, `perf:`, `build:`, `ci:`.
  CI checks the PR title.
- Keep PRs focused, and fill in the pull request template.
- Code, comments and documentation are in English.

## Versioning and releases

- [Semantic Versioning](https://semver.org/); changes are recorded in `CHANGELOG.md` following
  [Keep a Changelog](https://keepachangelog.com/).
- Marketplace convention: an odd minor version (0.1.x, 0.3.x) is a pre-release, an even minor
  (0.2.x, 0.4.x) is stable.
- To cut a release: update the version in `package.json` and `CHANGELOG.md`, merge to `main`,
  then push a tag `vX.Y.Z` matching the version. The publish workflow verifies the tag,
  packages the extension, publishes to the VS Code Marketplace and Open VSX, and creates the
  GitHub release.
