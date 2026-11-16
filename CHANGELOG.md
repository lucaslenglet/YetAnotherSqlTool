# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- "Import Connections from SQL Server Extension" (command, and a link in the Connections view while it is empty): copies the connections and connection groups saved by Microsoft's SQL Server extension into YetAnotherSqlTool. You choose the connections to import; the ones already present are unchecked. The group tree is kept, running the import again creates no duplicate, and nothing is written to the SQL Server extension's settings. What could not be carried over (options YetAnotherSqlTool does not support, authentication types it does not handle, passwords) is listed per connection in the "YetAnotherSqlTool" output channel.
- A password typed at the first connection is now saved to `SecretStorage` once the connection has succeeded, for a connection that has "Save Password" checked.

## [0.1.2] - 2026-11-15

### Added

- Database filter of a connection ("Database filter" in the connection dialog, `databaseFilter` in `yast.connections`): the connection only shows the databases whose name matches patterns such as `*-dev-*`, in the Object Explorer and in the list of databases of an editor. Several connections to the same server can each show their own set of databases.
- Color of a connection ("Color" in the connection dialog, `color` in `yast.connections`): shown in the status bar and as a bar in the gutter of the SQL editors that use the connection. The bar needs the editor's glyph margin (`editor.glyphMargin`, on by default).

## [0.1.1] - 2026-11-14

### Changed

- SQL Server driver libraries updated: `tedious` 20.3.9 and `mssql` 12.7.14. `tedious` now also refuses by itself to log in to a server that does not encrypt the connection when encryption is required (Encrypt: Mandatory); YetAnotherSqlTool keeps its own check and its explanatory message.
- Interface libraries updated (Fluent UI, React, react-resizable 4).

## [0.1.0] - 2026-11-14

Initial release.

### Added

- SQL Server and PostgreSQL drivers, written in TypeScript (no external service process).
- Object Explorer with connection groups, context menus and "New Query".
- "Select Top 1000" on tables and views (`TOP` for SQL Server, `LIMIT` for PostgreSQL), and the `yast.query.preventAutoExecuteScript` setting.
- Connection dialog generated for each engine, saved and recent connections, connection strings, passwords stored in `SecretStorage`.
- One connection per SQL editor, with status bar entry and CodeLens.
- Query execution with multiple batches and result sets, streamed rows, Messages tab, text view and cancellation.
- "Execute Selection or Current Statement" (`Ctrl+F5`), `Ctrl+R` to show or hide the query results as in SSMS, `Alt+Pause` to cancel a query.
- Autocompletion in connected SQL editors (objects and columns of the database, functions, data types, keywords) and the "Refresh IntelliSense Cache" command.
- "Script as Create / Drop / Alter / Execute" for Object Explorer objects and "Generate Scripts..." for a whole database (schema, data or both).
- Syntax highlighting that follows the engine of the editor's connection (PostgreSQL or T-SQL keywords, types, functions and syntax).
- "Show Object Information" (`Alt+F1`), like SSMS: `sp_help` on SQL Server, equivalent catalog queries on PostgreSQL.
- Results grid with selection summary and copy.
- Large results are kept on disk beyond a memory budget: queries returning millions of rows no longer exhaust memory, the grid pages anywhere in them and "Save as" streams to the file.
- Copy as CSV, JSON, `IN (...)` and `INSERT INTO`; save as CSV, JSON, Excel and INSERT statements.
- Windows Authentication for SQL Server through NTLM (`DOMAIN\user` and password), also from Linux and macOS.
- Microsoft Entra ID authentication (VS Code Microsoft account, Default, Service Principal) for Azure SQL and Azure Database for PostgreSQL.
- Security: connections from untrusted workspaces are ignored, Entra ID tokens are only sent to Azure servers or those listed in `yast.entraId.allowedServers`, content security policy for webviews.
- No telemetry.
