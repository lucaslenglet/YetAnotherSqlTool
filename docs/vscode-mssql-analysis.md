# Analysis of vscode-mssql: what we take from it

Reference studied: `github.com/microsoft/vscode-mssql` (https://github.com/microsoft/vscode-mssql),
commit `fa3aee0` (9 October 2026), from a local clone of vscode-mssql kept outside the
project (read-only). This is the upstream reference commit: use it to port Microsoft's
later fixes.
MIT license: reuse is allowed as long as the Microsoft copyright notice is kept.
The "mssql" name, the Microsoft name and their logos are not covered by the license.

All paths below are relative to `extensions/mssql/src/`.

## Overview

The repository is a monorepo (`extensions/mssql`, `extensions/sql-database-projects`, ...).
The mssql extension is about 300,000 lines of TypeScript, but the three targeted screens
account for a small part of it.

Microsoft's architecture:

```
React pages (webviews)  ⇄  Extension (TypeScript)  ⇄  sqltoolsservice (.NET, SQL Server only)
   JSON-RPC via postMessage        JSON-RPC via stdin/stdout (vscode-languageclient)
```

Target architecture for YetAnotherSqlTool:

```
Reused React pages  ⇄  Extension (TypeScript)  ⇄  TypeScript drivers (mssql, pg, ...)
   same protocol as theirs        direct function calls, no external program
```

The central idea: we keep the protocol between the pages and the extension, and replace
everything the extension asked of `sqltoolsservice` with calls to our drivers.

## The pages ⇄ extension protocol

Files: `webviews/common/rpc.ts`, `sharedInterfaces/webview.ts`,
`controllers/webviewBaseController.ts` (680 lines), `webviews/common/vscodeWebviewProvider.tsx`.

- Transport: `vscode-jsonrpc/browser` on top of `postMessage`.
- Redux-like model:
  - The **state** of each screen belongs to the extension, which pushes it to the page on every change.
  - The page triggers **actions** ("reducers"): `rpc.action("connect", {...})`.
  - To read data on demand, the page sends ordinary **requests**
    (for example `getRows` for the grid).
- Each screen has a typed contract in `sharedInterfaces/<screen>.ts`: state, list of
  actions, requests.

Consequence: this foundation (about 1,000 lines) is to be taken over as is, first.
It is generic and knows nothing about SQL Server.

## Screen 1: connection configuration

| | |
|---|---|
| React page | `webviews/pages/ConnectionDialog/` |
| Code pulled in (dependencies included) | 62 files, about 16,000 lines |
| Extension side | `connectionconfig/` (6,200 lines), including `connectionDialogWebviewController.ts` |
| Contract | `sharedInterfaces/connectionDialog.ts`, `sharedInterfaces/form.ts` |
| Libraries | React, Fluent UI v9 (`@fluentui/react-components`, `react-icons`), `react-resizable` |

**Good news for multi-database support:** the form is generated from a description of the
fields. `connectionconfig/formComponentHelpers.ts` sends a `capabilities` request to
`sqltoolsservice`, receives the list of connection options (name, type, label, category,
default value...) and turns it into form fields (`FormItemSpec`). Each driver will only
have to provide its own list of options. The PostgreSQL form will then be displayed with
the same layout as the SQL Server one.

**To keep:**
- Main page: form, list of saved and recent connections, Connect button.
- Advanced options drawer (`advancedOptionsDrawer`).
- Import from a connection string (`connectionStringDialog`).
- Connection groups (`webviews/pages/ConnectionGroup`).
- "Trust server certificate" dialog (useful for SQL Server).

- Azure browsing: subscriptions, then servers, then databases (`azureBrowsePage`). **Not taken** (decision of 2026-10-10).
- Entra ID sign-in (`entraSignInEmpty`), account and tenant selection.
- Adding an Azure firewall rule (`AddFirewallRule`) when the connection is refused
  by the server's firewall. **Not taken** (decision of 2026-10-10).

**To remove:**
- Fabric browsing (`fabricBrowsePage`, `components/fabric/`). Can be added later.
- Expired password change.
- Azure Data Studio migration, telemetry, performance measurements.

**To add:**
- A database type selector (SQL Server / PostgreSQL) at the top of the form, which
  reloads the list of fields of the chosen driver.
- Password storage in `SecretStorage` (Microsoft already does it through its
  `credentialstore`: to be used as a model).

## Azure and Entra ID

Files: `azure/` (accounts, tenants, MSAL), `connectionconfig/azureHelpers.ts`,
`azure/azureResourceController.ts`.

Microsoft has two mechanisms:
- **Old:** its own MSAL authentication (`azure/msal/`, `@azure/msal-node`), with
  encrypted token storage.
- **Recent:** VS Code's built-in Microsoft account provider
  (`vscode.authentication`), through the `@microsoft/vscode-azext-azureauth` library
  (`VSCodeAzureSubscriptionProvider`). It is used to list accounts, tenants and
  subscriptions.

**Our choice: only VS Code's built-in provider.**
- No MSAL code to maintain and no tokens to store ourselves.
- The user signs in with the Microsoft account already known to VS Code (MFA included).
- Tokens obtained with `vscode.authentication.getSession("microsoft", scopes)`:
  - **Azure SQL:** scope `https://database.windows.net/.default`, then the token is passed to the
    `mssql`/`tedious` driver (`azure-active-directory-access-token` authentication).
  - **Azure Database for PostgreSQL:** scope
    `https://ossrdbms-aad.database.windows.net/.default`, then the token is used as the
    password by the `pg` driver. Tokens expire: a new one must be requested on each
    new pool connection.

## Screen 2: Object Explorer

| | |
|---|---|
| Extension side | `objectExplorer/` (3,400 lines): `objectExplorerProvider.ts`, `objectExplorerService.ts`, `nodes/` |
| React page | none: it is VS Code's native tree (`TreeDataProvider`) |
| Icons | `media/objectTypes/`: 130 SVG icons, one per object type |

How it works at Microsoft: the extension opens a "session" on `sqltoolsservice`
(`CreateSessionRequest`), then asks for the children of a node (`ExpandRequest`). Each
node received is a `NodeInfo` (`models/contracts/objectExplorer/nodeInfo.ts`):

```ts
nodePath, nodeType, label, nodeSubType, nodeStatus, isLeaf, errorMessage,
metadata: { metadataType, metadataTypeName, schema, name, parentName? }
```

The `nodeType` (`Database`, `Table`, `Column`, `Folder`, ...) chooses the icon.

**For us:** this is the simplest screen to reproduce. Each driver implements an
`expand(node) → NodeInfo[]` function from its database's system views
(`sys.*` / `INFORMATION_SCHEMA` for SQL Server, `pg_catalog` / `information_schema`
for PostgreSQL). The rest (tree, connection groups, icons, context menus)
is taken over almost identically. PostgreSQL needs a "Schemas" level that
SQL Server displays differently: to be planned in the folder structure.

**To remove:** advanced filters (at first), drag and drop, Azure nodes.

## Screen 3: results display

| | |
|---|---|
| React page | `webviews/pages/QueryResult/` |
| Code pulled in (dependencies included) | 107 files, about 31,000 lines, including 23 execution plan files |
| Extension side | `queryResult/` (2,400 lines), `controllers/queryRunner.ts` (1,800 lines) |
| Contract | `sharedInterfaces/queryResult.ts` |
| Libraries | React, Fluent UI, a grid derived from SlickGrid (`QueryResult/table/`), jQuery, lodash, Monaco (text view) |

How it works at Microsoft:
1. `queryRunner.ts` sends the query to `sqltoolsservice` (`QueryExecuteStringRequest`).
2. The service returns notifications: batch start, result set complete
   (`ResultSetSummary`: columns and row count), messages, query end.
3. The page displays the grid and requests rows by pages, as the user scrolls
   (`getRows`: `rowStart`, `numberOfRows` → `ResultSetSubset`).

**For us:** the extension keeps the rows received from the driver in memory (or on disk
beyond a certain volume) and answers `getRows` itself. Both the `mssql` and `pg` drivers
can read rows as a continuous stream, which makes it possible to display the first
results before the query ends, as at Microsoft.

**To keep:**
- Grid with selection, copy, sort, filters, column resizing.
- Messages tab (rows affected, errors with a link to the faulty line).
- Multiple result sets, text view, selection summary (sum, average...).
- Copy as CSV, JSON, `IN (...)`, `INSERT INTO`, and saving to a file.

**Export: to be rewritten by ourselves.** At Microsoft, saving to a file is done
on the .NET side, by `sqltoolsservice` (`models/resultsSerializer.ts` only chooses the
file and sends `SaveResultsAs*Request`). Formats offered:
- **Save as:** CSV, JSON, Excel (.xlsx), `INSERT` script.
- **Copy:** with or without headers, CSV, JSON, `IN (...)`, `INSERT INTO`.

For us, everything goes through a TypeScript export module, fed by the rows stored
on the extension side:
- CSV, JSON and `INSERT` without a library;
- Excel with `exceljs` (streaming write, for large volumes);
- options taken from Microsoft: separator, quotes, headers, encoding.

The `INSERT` script depends on the engine: `[...]` quoting for SQL Server, `"..."` for
PostgreSQL, and literals according to the type of each column. Each driver therefore
provides the quoting.

**To remove:**
- Execution plan (`webviews/pages/ExecutionPlan`, `@xyflow/react`): closely tied to SQL
  Server. A PostgreSQL version based on `EXPLAIN` can be made later. Since planned again:
  see `execution-plan-analysis.md`.
- Live statistics, Copilot, telemetry.

## What we write ourselves

1. **The driver interface** (`Driver`):
   - `getConnectionOptions()`: the list of fields for screen 1;
   - `connect()`, `disconnect()`, `testConnection()`;
   - `expand(node)`: the children of a node for screen 2;
   - `execute(sql, cancellation)`: stream of result sets and messages for screen 3;
   - `cancel()`.
2. **The drivers** for SQL Server (`mssql`/`tedious`) and PostgreSQL (`pg`, `pg-query-stream`).
3. **Batch splitting**:
   - SQL Server splits a script on `GO` lines;
   - PostgreSQL has no `GO`: we will send the script in one block and collect the
     different result sets.
4. **The connection manager**: simplified from `controllers/connectionManager.ts`
   (2,600 lines, mostly Azure).
5. **Highlighting and autocompletion**: later. Microsoft gets them from
   `sqltoolsservice`, so there is nothing to take over directly.

## Estimate of the porting effort

| Block | Microsoft code involved | After cleanup (order of magnitude) | Difficulty |
|---|---|---|---|
| RPC foundation and state | ~1,000 lines | ~800 | Low: generic |
| Connection screen | ~16,000 + 6,000 | ~8,000 | Medium: we keep Azure, we remove Fabric |
| Azure and Entra ID | `azure/` + `vscode-azext-azureauth` | ~2,000 | Medium: tokens per engine, PostgreSQL to add |
| Object Explorer | ~3,400 | ~1,500 + queries per driver | Low |
| Results | ~31,000 + 4,200 | ~15,000 | High: complex grid, many dependencies |
| Export (CSV, JSON, Excel, INSERT) | done in .NET on their side | ~800, written by us | Low to medium |
| SQL Server + PostgreSQL drivers | – | ~1,500 | Medium: written by us |

## Proposed plan

1. **Skeleton:**
   - TypeScript extension;
   - build with esbuild, like Microsoft (one bundle for the extension, one per React page);
   - debug launch with F5;
   - take over the RPC foundation.
2. **Drivers:**
   - `Driver` interface;
   - SQL Server and PostgreSQL drivers;
   - tests on the project's Docker databases.
3. **Object Explorer:** hard-coded connections at first, but with the real icons.
4. **Connection screen:** take over, clean up, form generation per driver.
5. **Results:**
   - first the grid alone and the Messages tab;
   - then copy, filters and export.
6. **Entra ID:** token-based connection.

Each step delivers something usable and testable before moving on to the next.

## Division of work between models

To limit cost, the large, verifiable work is entrusted to subagents running on a cheaper
model (Sonnet). Design and review stay on the main model.

| Task | Who | Why |
|---|---|---|
| Skeleton, `Driver` interface, RPC foundation | Main model | Foundations: a mistake here is costly later |
| Object Explorer queries per driver | Sonnet | Well-known SQL, testable on the Docker databases |
| List of connection fields per driver | Sonnet | Mechanical |
| Extraction and cleanup of a Microsoft screen | Sonnet, one screen per agent | Large volume, the compiler checks the result |
| Export module | Sonnet | Clear specification, easy tests |
| Grid / streaming execution / cancellation wiring | Main model | Concurrency and shared state: delicate |
| Entra ID tokens per engine | Main model | Security |
| Review of each delivery | Main model | Quality control before presenting |

Rules:
- each agent receives a self-contained brief (files concerned, success criterion:
  compilation and test on the Docker databases);
- independent agents work in parallel, each in its own git working
  copy;
- small tasks are not delegated: writing the brief would cost more than
  doing the work.
