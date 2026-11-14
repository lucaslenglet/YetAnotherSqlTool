# YetAnotherSqlTool

A multi-database SQL client for Visual Studio Code, with a user experience inspired by Microsoft's SQL Server extension (`vscode-mssql`). It supports **SQL Server** and **PostgreSQL** today; **SQLite** and **MySQL / MariaDB** are planned.

> Not affiliated with or endorsed by Microsoft.

![YetAnotherSqlTool: Object Explorer with a SQL Server and a PostgreSQL connection, a SQL editor and its results grid](media/screenshots/overview.png)

## Features

- **Object Explorer**: browse servers, databases and their objects in a tree, with connection groups, context menus, a "New Query" action on any connection and "Select Top 1000" on tables and views.
- **Connection dialog**: a form generated for each database engine, saved and recent connections, connection groups, and connection strings. Passwords are kept in VS Code's `SecretStorage`.

  ![The Connect to Database dialog with the list of database types open](media/screenshots/connection-dialog.png)
- **One connection per editor**: every SQL editor owns its own connection, shown in the status bar and as a CodeLens at the top of the script. Connect, disconnect, change connection and change database from the editor.
- **Query execution**: several batches and result sets per script, rows streamed into the results grid as they arrive, a Messages tab with a link to the line in error, a plain-text view, and cancellation of a running query. Run the whole script, the selection, or just the statement under the cursor.

  ![The Messages tab showing a SQL Server error with a link to its line](media/screenshots/messages.png)
- **Autocompletion**: suggestions from the catalog of the connected database (schemas, tables, views, columns with their type, aliases, procedures, functions, data types and keywords of the engine), according to where the cursor is in the statement. "Refresh IntelliSense Cache" reloads the catalog; `yast.intelliSense.*` settings turn it off.
- **Script generation**: right-click an object for **Script as Create / Drop / Alter / Execute** (SQL Server scripts are the ones SSMS and Microsoft's extension produce; PostgreSQL scripts follow `pg_dump`). Right-click a database for **Generate Scripts...**: its schema, its data as `INSERT` statements, or both, into a new editor or a `.sql` file.
- **Syntax highlighting of the connected engine**: a SQL editor is colored with the keywords, data types, functions and syntax of the database it is connected to (PostgreSQL `ILIKE`, `RETURNING`, `::type`, `$$ ... $$` bodies and `"quoted"` names; T-SQL `TOP`, `[name]`, `GO`). Turn it off with `yast.syntaxHighlighting.engineSpecific`.
- **Object information** as in SSMS: select an object name and press `Alt+F1` to get its general information, columns, identity, indexes, constraints and the foreign keys and views that reference it; with nothing selected, the objects of the current database. SQL Server runs `sp_help`; PostgreSQL gets the equivalent grids from its catalog, for tables, views, functions and procedures (parameters of every overload), types and sequences.
- **Large results**: a query returning millions of rows stays usable. Beyond a memory budget, rows are kept in a file instead of RAM; the grid pages anywhere in the result and "Save as" streams to the file.
- **Results grid**: selection summary, copy, sorting and filtering (up to a configurable row threshold), and many display settings.

  ![A PostgreSQL result grid with a column of cells selected and their count, average and sum in the footer](media/screenshots/results-grid.png)
- **Copy and save results**: copy as CSV, JSON, `IN (...)` clause or `INSERT INTO` statements; save as CSV, JSON, Excel or INSERT statements. SQL syntax is specific to each engine.
- **Microsoft Entra ID authentication** for Azure SQL and Azure Database for PostgreSQL: your VS Code Microsoft account, "Default" (machine identities such as Azure CLI or managed identity) and Service Principal.
- **Safer by default**: connections defined in an untrusted workspace are ignored, and Entra ID tokens are only sent to Azure servers (or servers you explicitly allow).

## Quick start

1. Open the **YetAnotherSqlTool** view in the Activity Bar and click **Add Connection**.
2. Choose the engine (SQL Server or PostgreSQL), fill in the form (or paste a connection string) and connect.
3. Right-click a connection in the Object Explorer and choose **New Query**, or open any `.sql` file and use **Connect**.
4. Run the query. Results appear in the **Query Results** panel.

Default keyboard shortcuts, active in SQL editors:

| Action | Windows / Linux | macOS |
|---|---|---|
| Execute Query (the selection, else the whole script) | `Ctrl+Shift+E` | `Cmd+Shift+E` |
| Execute Selection or Current Statement | `Ctrl+F5` | `Cmd+F5` |
| Cancel Query | `Alt+Pause` | `Alt+Pause` |
| Show Object Information (`sp_help`) | `Alt+F1` | `Alt+F1` |
| Show or hide the query results (also from the results view) | `Ctrl+R` | `Ctrl+R` |
| Connect | `Ctrl+Shift+C` | `Cmd+Shift+C` |
| Disconnect | `Ctrl+Shift+D` | `Cmd+Shift+D` |

Shortcuts inside the results views (switch tabs, copy, select, sort...) can be changed with the `yast.shortcuts` setting. Every command is also available from the Command Palette.

## Settings

All settings are under `yast.*`; search for "YetAnotherSqlTool" in the Settings editor. The most useful ones:

| Setting | Purpose |
|---|---|
| `yast.connections`, `yast.connectionGroups` | Connection profiles and groups (normally edited through the UI). |
| `yast.entraId.allowedServers` | Extra server names allowed to receive a Microsoft Entra ID token (see below). |
| `yast.defaultQueryResultsViewMode` | Show results as `Grid` (default) or `Text`. |
| `yast.openQueryResultsInTabByDefault` | Open results in an editor tab instead of the panel. |
| `yast.resultsGrid.*` | Column auto-sizing, grid lines, alternating rows, row padding, right-aligned numbers, in-memory sort/filter threshold. |
| `yast.resultsFontFamily`, `yast.resultsFontSize` | Font of the results grid. |
| `yast.saveAsCsv.*`, `yast.saveAsExcel.*` | Delimiter, headers, encoding and formatting of exported files. |
| `yast.copyIncludeHeaders`, `yast.copyRemoveNewLine` | Behaviour of copy in the results grid. |
| `yast.showBatchTime`, `yast.results.showBatchMessages` | Messages shown for each batch. |
| `yast.maxRecentConnections` | Number of recent connections remembered. |

## Authentication

- **SQL Server**: SQL login (user and password), Windows Authentication and Microsoft Entra ID.
- **Windows Authentication** (on-premises SQL Server) signs in with NTLM: choose "Windows Authentication" and enter the account as `DOMAIN\user` (or `user@domain`) with its password. It works from Linux and macOS too. Signing in with the current Windows session, and servers that only accept Kerberos, are not supported.
- **PostgreSQL**: user and password, and Microsoft Entra ID for Azure Database for PostgreSQL.
- **Microsoft Entra ID**:
  - *Microsoft account* mode uses the account you are signed in with in VS Code (the built-in Microsoft authentication provider). You pick the account and tenant, and a fresh token is requested for each physical connection.
  - *Default* mode uses the identities of the machine (environment, managed identity, Azure CLI...).
  - *Service Principal* mode uses a tenant, application (client) ID and secret.
- **Token audience protection**: a Microsoft Entra ID token is only sent to Azure servers (for example `*.database.windows.net` or `*.postgres.database.azure.com`). To use it with another name (a custom DNS name, or `localhost` through a tunnel), add it to `yast.entraId.allowedServers`; an entry starting with a dot, such as `.corp.example.com`, allows every name ending with it. A token sent to a server lets that server act as you on your Azure databases for about an hour, so only add servers you trust.
- **Workspace Trust**: connection profiles found in the settings of an untrusted workspace are ignored.

## Privacy

YetAnotherSqlTool collects **no telemetry**. The telemetry layer inherited from `vscode-mssql` is replaced by a stub that never sends anything, and the extension does not bundle any telemetry or analytics library. The extension only talks to:

- the database servers you connect to;
- Microsoft sign-in, through VS Code's built-in account provider or, for the "Default" and "Service Principal" Entra ID modes, the Azure Identity library. In "Default" mode that library looks for an identity on the machine: it may run your Azure CLI, Azure Developer CLI or Azure PowerShell and query the local managed-identity endpoint;
- when you use Entra ID with your VS Code Microsoft account, a read-only call to Azure Resource Manager (`management.azure.com`) that lists the tenants of your account, for the connection form and when a connection has no tenant saved.

VS Code's own telemetry setting is not involved. Passwords are stored in VS Code's `SecretStorage`.

**Query results on disk.** A result set larger than about 16 MB (or the results of a window beyond 128 MB in total) is written to disk, unencrypted, under the extension's storage folder in your VS Code user data (`globalStorage/<extension id>/results/`), readable by your user only. A file is deleted when its results are replaced, when its editor or results tab is closed, and when the window closes; files left behind by a crash are deleted the next time the extension starts. Smaller results never touch the disk.

## Known limitations

- Copying results to the clipboard is refused beyond 50 million characters: use "Save as" for larger selections. The text view of the results is not meant for millions of rows.
- The INSERT export uses the placeholder table name `TableName`.
- Excel export writes time-zone-aware dates (`datetimeoffset`, `timestamptz`) as text.
- "Execute Selection or Current Statement" finds the statement at the cursor without a full T-SQL parser: on SQL Server, unusual constructs can make it run a larger statement than expected (select the text to be exact); on PostgreSQL, statements must end with `;`.
- PostgreSQL: `BEGIN ATOMIC ... END` function bodies are split incorrectly and `COPY ... FROM STDIN` is not supported.
- Object Explorer: no folder filters or drag and drop; some rarely used SQL Server folders are omitted.

## Roadmap

Planned: SQLite and MySQL / MariaDB drivers, a table designer and Jailer-style data extraction.

## Contributing

Development setup and contribution guidelines are in [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome at <https://github.com/lucaslenglet/YetAnotherSqlTool>.

## Credits and license

Released under the MIT License.

This project reuses portions of [vscode-mssql](https://github.com/microsoft/vscode-mssql) (webviews and extension-side controllers), Copyright (c) Microsoft Corporation, also released under the MIT License. The original notice is kept in `THIRD_PARTY_LICENSE_vscode-mssql.txt`. "Microsoft", "SQL Server" and "PostgreSQL" are trademarks of their respective owners; this extension is inspired by Microsoft's SQL Server extension and is not a Microsoft product.
