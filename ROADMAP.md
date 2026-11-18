# YetAnotherSqlTool: progress and remaining work

VS Code extension that reproduces the UX of Microsoft's SQL Server extension
(`vscode-mssql`) and makes it work with several database engines.

Related document: `docs/vscode-mssql-analysis.md`, what is taken from Microsoft's code and why.

## Done

| Step | Content |
|---|---|
| 0 | Docker test databases (SQL Server, MySQL, PostgreSQL) and SQLite file |
| 1 | Extension skeleton, esbuild build, F5, RPC foundation taken from Microsoft (telemetry disabled) |
| 2a | Driver interface (`src/drivers/types.ts`), references captured from sqltoolsservice (`docs/reference/`) |
| 2b | PostgreSQL driver: connection, object tree, streaming execution, cancellation (47 tests) |
| 2c | SQL Server driver: tree and value display identical to Microsoft's (63 tests) |
| 3 | Object Explorer: tree, Microsoft icons, connection groups, context menus, wired to the drivers; F5 opens `dev-workspace/` (Docker databases) |
| 4 | Connection screen and groups dialog taken from Microsoft: form generated per driver, SQL Server / PostgreSQL choice, database list, saved and recent connections, connection strings, passwords in `SecretStorage`; "Browse Azure" and Azure firewall removed |
| 5 | Execution and results grid taken from Microsoft (new grid, the one shown by default): per-editor connection and status bar, multiple batches and result sets, rows received as a stream, Messages tab with a link to the failing line, text view, cancellation, simple copy and selection summary, "New Query" from the explorer |
| 5b | Connection shown at the top of the script (Microsoft's CodeLens); saved profile password reused when a recent connection is chosen |
| 6 | Export and copy: copy as CSV, JSON, `IN (...)`, `INSERT INTO`; save as CSV, JSON, Excel, INSERT; Microsoft's `saveAsCsv` / `saveAsExcel` settings; SQL syntax specific to each engine |
| 7 | Entra ID with VS Code's Microsoft accounts (Microsoft's default mode, no MSAL), tested on Azure SQL and Azure PostgreSQL: account and tenant selection, token requested again on every physical connection, PostgreSQL user derived from the token |
| 7b | Entra ID "Default" (machine identities: Azure CLI, managed identity...) and "Service Principal" for SQL Server and PostgreSQL, tested on Azure; identities and tokens kept in memory; results panel renamed to coexist with Microsoft's extension |
| 8 | Security: connections from an untrusted folder ignored, Entra token sent only to Azure servers (or to those in `yast.entraId.allowedServers`), webview CSP |
| 9 | Publication preparation: Testcontainers for the tests, end-to-end test of the packaged extension in a real VS Code, licenses and notices, README with screenshots, CI and publish workflows, ESLint and Prettier, `package.nls.json`, leftovers of vscode-mssql removed, minimum VS Code 1.101 |
| 10 | Keyboard shortcuts: "Execute Selection or Current Statement" (`Ctrl+F5`: the selection, else the statement at the cursor, found by the driver; SQL Server statements need no semicolon), `Ctrl+R` shows or hides the results as in SSMS, `Alt+Pause` cancels the query; SQL lexer shared by the engines (`src/sql/lexer.ts`) |
| 11 | "Select Top 1000" in the Object Explorer menu of tables and views: script in a new connected editor, then run (`TOP` for SQL Server, same text as sqltoolsservice; `LIMIT` for PostgreSQL); `scriptObject` in the driver contract; `yast.query.preventAutoExecuteScript`; scripts of sqltoolsservice captured in `docs/reference/mssql-scripts.json` |
| 12 | Object information as in SSMS (`Alt+F1`, `yast.showObjectInformation`): the selected name, or the objects of the database when nothing is selected. SQL Server runs the real `sp_help`; PostgreSQL resolves the name like the server and returns the equivalent grids from the catalog (general information, columns, identity, indexes, constraints, foreign keys and views referencing the table; parameters of routines; details of types and sequences). `QueryRunner` can run a driver call that is not text of the editor |
| 13 | Syntax highlighting per engine: semantic tokens over VS Code's T-SQL grammar follow the editor's connection (PostgreSQL keywords, types, functions, `$$` bodies, quoted identifiers; T-SQL with `GO` only alone on its line); vocabulary of each engine in its driver (`SqlLanguage`), generated from the real servers and Microsoft's grammar by `tools/gen-sql-language.mjs`; `yast.syntaxHighlighting.engineSpecific` |
| 14 | Script generator: "Script as Create / Drop / Alter / Execute" on Object Explorer nodes (Microsoft's menus, "Generate Script" submenu on tables), and "Generate Scripts..." on a database (schema, data or both, in dependency order, into a connected editor or streamed to a file). SQL Server scripts reproduce sqltoolsservice (SMO) byte for byte on 60 captured objects; PostgreSQL scripts follow `pg_dump` and use the server's deparsers; database scripts were checked by running them into an empty database on both engines |
| 15 | Autocompletion in connected SQL editors: schemas, tables, views, columns with their type, aliases, CTEs, variables, procedures, user and built-in functions, data types and keywords, offered according to the position in the statement; metadata read by the drivers on a connection other than the query session, cached per editor, reloaded after DDL or with "Refresh IntelliSense Cache"; `yast.intelliSense.*` settings; sqltoolsservice's completions captured in `docs/reference/mssql-completions.json` |
| 16 | Windows Authentication for SQL Server through NTLM: authentication type `Integrated` with the account typed as `DOMAIN\user` (or `user@domain`) and its password, saved and asked like a SQL login; works from Linux and macOS. Handshake checked against a fake TDS server (NTLMv2 response recomputed independently) and against the refusal of the SQL Server Linux container |
| 17 | Large results: a result set stays in memory up to 16 MiB (128 MiB for a window), beyond that its rows go to an append-only file under the extension's storage, with a sparse index and a small read cache; both drivers stop reading from the server while the store is behind; paging, copy (cancellable, refused beyond 50 million characters), selection summary (on click above the threshold, as vscode-mssql) and Save as CSV / JSON / Excel / INSERT read the store in chunks and stream to the file |
| 18 | Filtered connections: a profile's `databaseFilter` (patterns with `*` and `?`, several separated by `;`, `!` to exclude) limits the databases its connection shows in the Object Explorer (system databases included, folders marked "(filtered)" as in SSMS) and in the "change database" list of an editor; "Database filter" field in the connection dialog. Two profiles on the same server can show two sets of databases |
| 19 | Connection color, in the spirit of SSMS: a profile's `color` (`#RRGGBB`, "Color" field of the connection dialog: palette of the connection groups or any color) is the text color of the connection and database items of the status bar and a bar in the gutter of every SQL editor using the connection; a color changed in the settings applies to connected editors without reconnecting. No inheritance from the group color |
| 20 | Environment variables in connections: `${env:NAME}` in any text field of a profile sent to the driver, resolved from the extension host's environment in `openConnection` only (the values live in the driver's options; errors of the connection have them replaced by the typed text); `$${env:NAME}` escape; unset variable fails before any network attempt; a password holding a reference is kept as typed in settings, never in `SecretStorage`, and never prompted. References of profiles that are not in the user's settings (workspace settings, recent entries, dialog forms loaded from them) need a modal confirmation, remembered per engine, server, port, authentication, encryption options and references (`src/connections/environmentConsent.ts`) |
| 21 | Import of the connections and groups of Microsoft's SQL Server extension (`yast.importMssqlConnections`, also an item of the empty Connections view): reads `mssql.connections` and `mssql.connectionGroups` of the user settings (read only), checked multi-select of the profiles (those already in YAST unchecked), group tree kept (groups recognized by id, then by name under the same parent, so a second run creates nothing), options and authentication types YAST does not handle left out or refused and listed per profile in the output channel. The logic is a pure function (`src/connections/mssqlImport.ts`). Passwords cannot be imported: a typed password is now saved to `SecretStorage` after a successful connection when "Save Password" is on |
| 23 | Server dashboard (issue #46, step 1): "Dashboard" in the Object Explorer menu of a connected server whose driver has `openDashboard` (and in the palette, with a connection pick), one panel per connection on its own "YAST dashboard" connection opened by the connector (password, Entra ID, `${env:NAME}` with redacted errors), closed with the panel. Engine-neutral sampling in `src/dashboard/dashboardSampler.ts` (pure, unit-tested): counters become rates from two readings, the first and every manual refresh take two readings a second apart, points at their real time in a 600-point ring buffer, auto refresh (1 s to 1 min, off by default, last interval remembered, `yast.dashboard.refreshInterval`) paused while hidden, ticks skipped while a reading runs, gaps after a pause, a failure or a reconnection. Page with uPlot charts (theme colors, legend, hover readout, last values as text), notices of partial data, error state with Reconnect |

## Features required before publication

All done (steps 10 to 17 above).

- [x] **Keyboard shortcuts**: cancel the running query (`Alt+Pause`); `Ctrl+R` as in SSMS to
      show or hide the results panel; "Execute Selection or Current Statement" (`Ctrl+F5`).
- [x] **"Select Top 1000"** from the context menu of a table or view, with the syntax of
      each engine (`TOP` / `LIMIT`).
- [x] **Object information** SSMS-style (`Alt+F1`): select a name and get its columns, keys,
      indexes, constraints and references, or the objects of the whole database.
- [x] **Engine-specific syntax highlighting**: keywords and syntax of PostgreSQL
      (`ILIKE`, `RETURNING`, `$$ ... $$`, `::type`) and SQL Server (`TOP`, `[name]`, `GO`).
- [x] **Script generator**: CREATE / DROP / ALTER / EXECUTE script of an object, and script
      of a whole database (schema, and optionally data).
- [x] **Autocompletion** while writing queries (tables, columns, schemas, keywords), built
      from the drivers.
- [x] **Windows authentication** for on-premises SQL Server: NTLM with a domain, user and
      password entered by the user (`tedious` cannot reuse the Windows session).
- [x] **Large results**: rows beyond a memory budget are stored on disk, so that a query
      returning millions of rows stays usable.

## Planned features (after publication)

- [ ] **Execution plan**: estimated and actual plans in Microsoft's graphical view, SQL Server
      first, then PostgreSQL through `EXPLAIN`. Pre-analysis in
      `docs/execution-plan-analysis.md`.
- [ ] **Table structure editor** like the Table Designer of Microsoft's extension.
- [ ] **Jailer-style data extraction**: extract a consistent subset of
      data by following foreign keys.

## Known Object Explorer limitations

- no filters on folders (a connection can filter its databases, see step 18), no drag and drop;
- no object subtype on folders (sqltoolsservice's `objectType`): the "New Table" /
  "New Database" menus that depend on it will come with those features;
- password neither saved nor in the profile: asked once then kept in memory
  until VS Code is closed (like Microsoft's extension);
- Entra ID: a user created in a single database (contained user) does not see the list of
  databases and must type its name (as with Microsoft).

## Known execution limitations

- large results are written to disk unencrypted (see the README's Privacy section); what
  stays in memory whatever the size: messages, a single gigantic cell, and the distinct
  values of a selection summary;
- a copy to the clipboard is refused beyond 50 million characters (our limit: use Save as);
- Excel files are limited to 4 GiB per sheet and per file (no ZIP64);
- the text view of the results loads every row into the webview;
- `INSERT` export to a table named `TableName` (like Microsoft), to be renamed by hand;
- Excel: dates with a time zone (`datetimeoffset`, `timestamptz`) are written as text;
- "Create Connection Profile" in the connection list does not connect the editor afterwards;
- "Execute Selection or Current Statement" on SQL Server finds the statement with a
  heuristic, not a T-SQL parser; when unsure it runs the larger statement. Known wrong cases:
  a line starting with `(` or with a bare procedure name after a statement without `;`
  (merged into that statement); Service Broker `RECEIVE` / `GET` / `MOVE CONVERSATION`;
  `IF <condition> (SELECT ...)` with a parenthesised body; a `BEGIN` or `CASE` still being
  typed takes the rest of the batch. On PostgreSQL statements must end with `;`;
- `Ctrl+R` in the results view also applies when another extension's webview view has the
  focus while our results are visible (VS Code has no context key for a focused webview
  view); it does nothing in a results tab opened in the editor area.

## Known autocompletion limitations

- nothing is offered in an editor without a connection (the engine is unknown);
- compared with Microsoft's IntelliSense: no tables, schemas or databases in expression
  positions, built-in `sys` table functions only after `sys.`, no scalar functions after
  `EXEC dbo.`, no error checking and no quick info on hover; names are bracketed only when
  required (Microsoft also brackets non-reserved keywords such as `[status]`);
- no objects of other databases (`otherdb.dbo.`), no parameter help in routine calls, no
  `ON CONFLICT` column lists;
- PostgreSQL: a `SET search_path` run in the editor is not seen (objects of the new path are
  offered schema-qualified);
- SQL Server: inside a `CREATE PROCEDURE` / `FUNCTION` body, relations of every statement of
  the body are in scope;
- the metadata cache is per editor, not shared between editors of the same database.

## Known scripting limitations

- "Script as" on SQL Server follows SMO's defaults: no `COLLATE`, no `DATA_COMPRESSION`, and
  the Create script of a temporal table is SMO's own, which fails when run as is (the
  database script uses a working order). Not captured from sqltoolsservice, written in SSMS's
  style: users `FOR LOGIN` and Entra users, disabled database triggers, tables on a partition
  scheme, the order of items in a table type. Not written: `HISTORY_RETENTION_PERIOD`,
  `DATA_CONSISTENCY_CHECK`, `NOT FOR REPLICATION` on foreign keys, `OPTIMIZE_FOR_SEQUENTIAL_KEY`
  before SQL Server 2019. XML, spatial, columnstore and hash indexes and encrypted modules are
  refused with an error. SQL Server 2016 or later;
- "Generate Scripts..." leaves out, on both engines, permissions and owners. SQL Server:
  `CREATE DATABASE` and `USE` (the script runs in the database you choose), extended
  properties, full-text, partition functions and schemes, filegroups, XML schema collections,
  CLR objects, statistics, keys and certificates, security policies, current values of
  sequences, non-default column collations; `real` at its maximum value overflows when
  inserted; rows of a table without a key or index may come out in another order.
  PostgreSQL: extensions, row-level security policies, event triggers, rules, legacy
  inheritance, foreign tables, tablespaces, aggregates, operators, casts, publications,
  large objects, storage and statistics settings of columns;
- a database script opened in an editor is limited to 50 MB (save to a file beyond that);
- no "Script as" for aggregates, partition functions, sequences, synonyms and user-defined
  types from the menus (the database script covers them).

## Known syntax highlighting limitations

- an editor without a connection keeps VS Code's generic (T-SQL) colors: the engine is unknown;
- names are reset to the plain text color through the `meta.embedded` scope: exact in the
  Dark+ / Light+ / Visual Studio / High Contrast themes, slightly off in the "Modern" ones, and
  not applied by third-party themes that do not style that scope (there, `TOP` in a
  PostgreSQL editor still looks like a keyword);
- PL/pgSQL-only words (`RAISE`, `PERFORM`, `ELSIF`, `LOOP`...) are not colored, and function
  bodies written as single-quoted strings stay strings;
- a non-reserved keyword used as a column name (`name`, `value`) is colored as a keyword unless
  it is next to a dot or in a column list (Microsoft's grammar does the same for T-SQL);
- the whole document is classified again after each edit: about 150 ms for 10,000 lines, a
  second for 50,000.

## Known object information limitations (`Alt+F1`)

- PostgreSQL: version 12 or later is assumed; no creation date, and none of sp_help's
  length / precision / scale columns (the type is shown formatted); DEFAULTs are in the columns
  grid, not in the constraints grid; an argument list in the selection (`my_func(int)`) is
  ignored and every overload is shown; the database-wide list leaves system objects out
  (SQL Server's lists them, as in SSMS).

## Known connection screen limitations

- Entra tenants: the full list comes from Azure Resource Manager (read-only) once
  "Sign in" is clicked; before that, only the account's home tenant is offered;
- expired password change not supported;
- PostgreSQL: an Entra ID connection cannot be expressed as a libpq string.

## Drivers

- [x] SQL Server
- [x] PostgreSQL
- [ ] SQLite (priority)
- [ ] MySQL / MariaDB (priority)
- [ ] Others later

## Known dashboard limitations

- Step 1 of issue #46 only: no Activity tab (sessions, waits, blocking, kill), no locks,
  replication or configuration tabs, no Azure SQL Database resource charts
  (`sys.dm_db_resource_stats`), no dashboard per database.
- The history lives in the extension's memory: it is lost when the panel closes, and keeps the
  last 600 points of each chart (10 minutes at one reading a second, longer at larger intervals).
- The x axis uses the server's clock; a reading the server dates before the previous one (clock
  set back) updates the tiles but adds no point.
- The header shows the server's version only when the dashboard is opened from a connected
  Object Explorer node (the dashboard's own connection does not report it).
- The charts are canvases: their hover readout needs a mouse. The last values are text in the
  tiles and each chart has an accessible name with them, but older points cannot be read with
  the keyboard.
- Azure Synapse dedicated and serverless SQL pools and Fabric have no dashboard (the item is
  shown on their server node; opening it reports that the pool has none).
- Not tested: Azure SQL Database, Azure SQL Managed Instance, SQL Server before 2022, PostgreSQL
  other than 17, Azure Database for PostgreSQL, Entra ID authentication on the dashboard's
  connection.

## Known driver limitations

- **PostgreSQL:**
  - `BEGIN ATOMIC ... END` functions are split incorrectly;
  - `COPY ... FROM STDIN` not supported;
  - no Statistics folder;
  - SSL with certificate verification written but not tested;
  - Entra ID: empty user = account sign-in name (token); for an Entra group,
    enter the group name; for a service principal, the role is required and the application
    ID has its own field.
- **SQL Server:**
  - Windows Authentication is NTLMv2 with a typed account only: no sign-in with the current
    Windows session (SSPI), no Kerberos-only servers, no channel binding (extended
    protection). Not tested against a real Active Directory;
  - Service Principal: the tenant must be entered (Microsoft's driver reads it from the
    server response, `tedious` cannot do that);
  - no Parameters folders under procedures and functions;
  - rare folders omitted (Service Broker, Storage, Always Encrypted, Server Objects...);
  - geography/geometry shown as "[object Object]" in the results grid (and written wrong by
    the INSERT export; "Generate Scripts..." reads them as binary and is not affected);
  - `tedious` pinned to an exact version, because of an internal adaptation
    (`src/drivers/mssql/tediousRawValues.ts`).
