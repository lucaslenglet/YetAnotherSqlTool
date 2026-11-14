# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

YetAnotherSqlTool (YAST) is a VS Code extension that reproduces the UX of Microsoft's SQL Server
extension (`vscode-mssql`) for several database engines (SQL Server and PostgreSQL today, SQLite
and MySQL planned). UX fidelity to vscode-mssql is the top priority.

Project documents (everything in the repository is written in English):
- `ROADMAP.md`: progress and next steps. When a step is done, add a row to "Done".
- `docs/vscode-mssql-analysis.md`: what is taken from vscode-mssql and why; read it before porting
  anything from Microsoft. It names the upstream commit used as reference.

## Commands

```bash
npm run build               # esbuild: dist/extension.js + dist/views/* (webviews); wipes dist/ first
npm run watch
npm run build:prod          # production build (minified, no source maps); run by vscode:prepublish
npm run typecheck           # extension and webviews have separate tsconfigs
npm test                    # unit tests (test/**/*.test.ts except *.integration.test.ts), no Docker
npm run test:integration    # test/**/*.integration.test.ts against SQL Server and PostgreSQL (Testcontainers, needs Docker)
npx vitest run test/drivers/pg.integration.test.ts -t "<test name>"   # single file / single test
npm run test:vscode         # packaged .vsix in a real, blank VS Code + Docker databases (scripts/test-vscode.mjs, mocha suites in test/vscode/*.e2e.ts)
npm run lint                # ESLint; npm run format / format:check for Prettier (settings of vscode-mssql)
npm run screenshots         # regenerate media/screenshots/*.png for the README (real VS Code + Docker)
npm run dev:db              # databases for F5, on 127.0.0.1 only, until Ctrl+C
npm run notices             # regenerate ThirdPartyNotices.txt from what esbuild really bundles
npx vsce package --no-dependencies   # build the .vsix (.vscodeignore is a whitelist: check with `npx vsce ls --no-dependencies`)
node tools/gen-mssql-connection-options.js  # regenerate src/drivers/mssql/connectionOptions.generated.ts
node tools/gen-sql-language.mjs             # regenerate src/drivers/*/language.generated.ts (Docker + the vscode-mssql clone)
```

F5 builds and opens `dev-workspace/`, whose settings pre-define connections to the databases
started by `npm run dev:db` (fixed ports 11433 and 15432, dev-only password in `scripts/dev-db.mjs`).
Integration tests start their own containers (`test/support/`): random port and generated
password, read through `test/support/databases.ts`, never hard-coded. A test that needs a
database goes in a `*.integration.test.ts` file. The schema comes from `test/fixtures/`.

## Architecture

```
React webviews (from MS)  ⇄  extension (TypeScript)  ⇄  TypeScript drivers (mssql/tedious, pg)
  JSON-RPC over postMessage      direct function calls
```

vscode-mssql delegates connections, Object Explorer and query execution to `sqltoolsservice`
(a .NET process). YAST keeps Microsoft's webviews and extension-side controllers and replaces
every sqltoolsservice call with a call to a driver. Where possible, our code produces the same
shapes sqltoolsservice returns (`NodeInfo`, `ResultSetSummary`, `IMessage`…) so that the code
copied from Microsoft stays close to upstream.

- **Webview protocol** (copied as is): the extension owns each screen's state and pushes it to
  the page; the page sends actions (reducers) and requests (e.g. `getRows`). Each screen's typed
  contract is in `src/sharedInterfaces/<screen>.ts`; controllers in `src/controllers/`, pages in
  `src/webviews/pages/`.
- **Drivers**: the `Driver` / `DriverConnection` interface in `src/drivers/types.ts` covers
  connection-form options, connect, Object Explorer expansion, scripting of a node
  (`scriptObject`), batch splitting, tokens and the statement at a position (`src/sql/lexer.ts`),
  streaming `execute` with `AbortSignal`, connection strings, identifier quoting and SQL literals.
  Registry in `src/drivers/index.ts`; a profile without `provider` is SQL Server. A new engine =
  a new `DriverId` plus one driver folder; the connection form is generated from the driver's
  options.
- **Language features** (`src/languageFeatures/`): engine-neutral, built on `Driver.tokenize`
  and `Driver.language` (keywords, types, functions of the engine). Semantic tokens color a SQL
  editor with the syntax of its connection's engine; an unconnected editor gets none.
  Autocompletion (`completion/`) works out the position from tokens and reads objects and
  columns through the drivers (`listCompletionObjects`...), never on the query session.
- **Connections**: `src/connections/connectionStore.ts` keeps profiles in settings
  (`yast.connections`) and passwords in `SecretStorage`. `src/connections/connector.ts` connects
  and gets Entra ID tokens from VS Code's built-in Microsoft account provider
  (`vscode.authentication`); there is no MSAL code.
- **Queries**: every SQL editor owns its own connection/session (`src/queries/editorConnections.ts`).
  `src/queries/queryRunner.ts` plays sqltoolsservice's role: splits batches with the driver,
  streams rows into a `RowStore` (`src/queries/rowStore.ts`: memory while small, then a file
  under the extension's global storage, with backpressure on the driver) and serves `getRows`,
  copy, selection summaries and exports from it, asynchronously and in chunks, to the results
  webview (`src/queryResult/`). Never hold all the rows of a result set in memory. It also runs driver calls that are not text of the
  editor (`describeObject`, Alt+F1) with the same life cycle.
- **Build** (`scripts/build.mjs`): `extension-toolkit/*` is aliased to `src/vendor/` (Microsoft's
  internal package, vendored); `vscode-mssql` is types only (`typings/`) and the build fails if
  it is required at runtime. Vitest uses the same aliases and maps `vscode` to `test/vscodeMock.ts`.

## Rules and gotchas

- Files copied from vscode-mssql keep their `Copyright (c) Microsoft Corporation` header (MIT
  condition). When porting, stay as close to the upstream code as possible.
- Azure resource management (Browse Azure, firewall rules, Fabric) was deliberately removed;
  ask before reintroducing anything that manages Azure resources.
- `tedious` is pinned to an exact version: `src/drivers/mssql/tediousRawValues.ts` wraps its
  internal value parser to keep exact decimals and `datetimeoffset` offsets, and
  `test/drivers/mssql/cellFormats.integration.test.ts` guards it on upgrade.
- `docs/reference/*.json` are captures of sqltoolsservice output (`tools/sts-*probe.js`, needs
  the mssql extension installed locally). They are the source of truth for matching Microsoft's
  connection options, Object Explorer tree, cell formats and "Script as" texts.
- Integration test files run in parallel against the same servers, and one of them compares the
  whole tree of the `yast` SQL Server database with a capture: a test that creates objects there
  names them `yast_oe_*` or `yast_oi_*` (ignored by that comparison) or uses its own database.
- SQL Server "Script as" texts must stay byte-identical to `docs/reference/mssql-scripts.json`
  (60 objects created by `test/fixtures/scripting/mssql-objects.sql`). After changing the
  catalog queries of `src/drivers/mssql/scriptCatalog.ts`, record their rows again with
  `RECORD_SCRIPT_CATALOG=1 npm run test:integration` (`test/fixtures/scripting/mssql-catalog.json`,
  replayed by the unit tests).
- vitest tests mock `vscode`; only `npm run test:vscode` sees activation errors, commands missing
  from `package.json`, files left out of the package and webview load/CSP errors. Its suites read
  the UI through the DevTools protocol (`test/vscode/cdp.ts`); do not add test hooks to `src/`.
- Commit messages and PR titles follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`,
  `chore:`...); CI checks PR titles. An odd minor version (0.1.x) is a pre-release.
- `main` is protected: never commit to it directly. Work on a branch, push it and open a PR
  (squash merge once CI passes; the PR title becomes the commit). Releases follow
  `CONTRIBUTING.md` ("Versioning and releases"): a `chore(release): X.Y.Z` PR, then a `vX.Y.Z`
  tag, pushed only on the owner's go since it publishes to the Marketplace and Open VSX.
- User-visible strings of `package.json` live in `package.nls.json` (`%key%`);
  `test/manifest/packageNls.test.ts` fails on a missing or unused key.
- `ThirdPartyNotices.txt` is generated (`npm run notices`) and committed; never edit it by hand.
  When a new bundled dependency makes the script fail, review its license and extend the tables
  at the top of `scripts/notices.mjs`.
- `engines.vscode` and the `@types/vscode` devDependency must move together (vsce rejects newer
  types than the engine).
