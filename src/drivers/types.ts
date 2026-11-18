/**
 * Driver contract: everything the extension needs from a database engine.
 *
 * The extension never talks to a database directly. It goes through a `Driver`
 * (one per engine: SQL Server, PostgreSQL, ...). The shapes below deliberately
 * mirror what Microsoft's sqltoolsservice returns, so the screens copied from
 * vscode-mssql can consume driver output with no translation layer:
 *   - connection options  -> `ConnectionProviderOptions` (capabilities/list)
 *   - Object Explorer     -> `ObjectNode` ~ `NodeInfo` (objectexplorer/expand)
 *   - query results       -> `ColumnInfo` ~ `IDbColumn`, `CellValue` = `DbCellValue`
 *
 * Reference captures from sqltoolsservice live in docs/reference/.
 */

import type { CategoryValue, ConnectionProviderOptions, ObjectMetadata } from "vscode-mssql";
import type { ExecutionPlanGraph } from "../sharedInterfaces/executionPlan";
import type { SqlToken } from "../sql/lexer";

export type DriverId = "mssql" | "pg";

// ---------------------------------------------------------------------------
// Connection options (drives the connection dialog form)
// ---------------------------------------------------------------------------

export type { CategoryValue, ConnectionProviderOptions };
export type { SqlToken, SqlTokenType } from "../sql/lexer";

/**
 * A connection profile is a flat bag of option values keyed by option `name`
 * (as declared in `getConnectionOptions()`), e.g. { server, database, user, ... }.
 * The password is never stored in the profile on disk; it is injected at connect time.
 */
export type ConnectionOptionValues = Record<string, string | number | boolean | undefined>;

/** Authentication types understood by the extension. Drivers may support a subset. */
export const AuthenticationType = {
    /** User name and password. */
    SqlLogin: "SqlLogin",
    /**
     * Windows Authentication through NTLM: `user` holds `DOMAIN\user` (or a user principal name),
     * `password` its password. Microsoft's name and label; unlike Microsoft's, it needs credentials.
     */
    Integrated: "Integrated",
    /** Microsoft Entra ID through the VS Code Microsoft account (interactive, MFA). */
    AzureMFA: "AzureMFA",
    /**
     * Microsoft Entra ID through the identities found on the machine (environment variables,
     * managed identity, Azure CLI...). `user` optionally holds a managed identity's client ID.
     */
    ActiveDirectoryDefault: "ActiveDirectoryDefault",
    /** Microsoft Entra ID as an application: `user` is its client ID, `password` its secret. */
    ActiveDirectoryServicePrincipal: "ActiveDirectoryServicePrincipal",
} as const;

/**
 * Returns a Microsoft Entra ID access token for the given scope
 * (e.g. "https://database.windows.net/.default"). Provided by the extension,
 * which owns the VS Code authentication session. Called on every new physical
 * connection, because tokens expire.
 */
export type AccessTokenProvider = (scope: string) => Promise<string>;

export interface ConnectParams {
    options: ConnectionOptionValues;
    /** Only set when options.authenticationType is AzureMFA. */
    getAccessToken?: AccessTokenProvider;
    /**
     * Server names, besides Azure's, that may receive a Microsoft Entra ID token
     * (user setting `yast.entraId.allowedServers`). Drivers refuse any other server.
     */
    entraAllowedServers?: readonly string[];
}

export interface ServerInfo {
    /** e.g. "16.0.4295.3" or "17.2". */
    serverVersion: string;
    /** Human readable product name, e.g. "SQL Server" or "PostgreSQL". */
    productName: string;
    /** e.g. "Developer Edition (64-bit)"; empty when unknown. */
    edition: string;
    /** True for Azure-hosted servers (Azure SQL Database, Azure Database for PostgreSQL...). */
    isCloud: boolean;
    /** Login actually used, shown in the server node label: "server (SQL Server 16.0 - sa)". */
    userName: string;
}

// ---------------------------------------------------------------------------
// Object Explorer
// ---------------------------------------------------------------------------

/**
 * One node of the Object Explorer tree. Field names and values follow
 * sqltoolsservice's NodeInfo (see docs/reference/mssql-object-explorer-tree.json):
 *   - `nodeType` selects the icon: it must be a file name (without .svg) from
 *     vscode-mssql's media/objectTypes, e.g. "Server", "Folder", "Database",
 *     "Table", "View", "Column", "Key", "Index", "Schema", "StoredProcedure"...
 *   - `nodeSubType` refines it, e.g. Key + "PrimaryKey" -> Key_PrimaryKey icon.
 *   - `label` is the exact display text, e.g. "id (PK, int, not null)".
 */
export interface ObjectNode {
    /** Unique, stable path. Children are requested by path. */
    nodePath: string;
    parentNodePath: string;
    nodeType: string;
    nodeSubType?: string;
    label: string;
    isLeaf: boolean;
    metadata?: ObjectMetadata;
    /** Database this node belongs to (undefined for server-level nodes). */
    database?: string;
    /** Opaque, driver-private data needed to expand this node. Must be JSON-serializable. */
    context?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

/** Coarse value family, used by exports (JSON numbers/booleans, INSERT literals, Excel cell types). */
export type ValueKind =
    "number" | "boolean" | "string" | "datetime" | "binary" | "json" | "xml" | "other";

/** Subset of vscode-mssql's IDbColumn that the grid and exports actually use. */
export interface ColumnInfo {
    columnName: string;
    /** Engine type name as shown to the user, e.g. "int", "nvarchar", "timestamptz". */
    dataTypeName: string;
    kind: ValueKind;
    allowDBNull?: boolean;
    baseSchemaName?: string;
    baseTableName?: string;
    isIdentity?: boolean;
    isXml?: boolean;
    isJson?: boolean;
    isBytes?: boolean;
}

/**
 * Same shape as vscode-mssql's DbCellValue. `displayValue` is the text the grid
 * shows (and CSV exports), formatted the way the engine's reference tool does
 * (SSMS/sqltoolsservice for SQL Server, psql for PostgreSQL). For NULL:
 * isNull = true and displayValue = "NULL".
 */
export interface CellValue {
    displayValue: string;
    isNull: boolean;
}

/** Position of a message inside the executed text, 0-based, relative to the batch. */
export interface TextPosition {
    line: number;
    column: number;
}

/** Range of text in a script, 0-based; `end` is exclusive. */
export interface TextRange {
    start: TextPosition;
    end: TextPosition;
}

/**
 * Events emitted while a batch runs, in order. A batch can produce any number of
 * result sets and messages, interleaved.
 */
export type ExecuteEvent =
    | { type: "resultSetStart"; columns: ColumnInfo[] }
    /** Rows of the current result set, in chunks (drivers should stream, not buffer everything). */
    | { type: "rows"; rows: CellValue[][] }
    | { type: "resultSetEnd"; rowCount: number }
    /**
     * Informational or error message. Examples: "(3 rows affected)", PRINT output,
     * RAISERROR / RAISE NOTICE, "UPDATE 3", server errors.
     */
    | {
          type: "message";
          text: string;
          isError: boolean;
          rowsAffected?: number;
          position?: TextPosition;
      }
    /**
     * A plan document, reported by `executeForPlan` only: one event per document (SQL Server: one
     * showplan XML per statement or batch; PostgreSQL: one EXPLAIN JSON per statement). `content`
     * is the text `Driver.executionPlan.parse` reads. When the driver also shows the document as a
     * result set (the grid of Microsoft's extension shows the showplan XML), the event comes right
     * after that result set's `resultSetEnd`.
     */
    | { type: "executionPlan"; content: string };

/**
 * Receives the events of `execute` / `describeObject`. A promise returned for a `rows` event asks
 * the driver to stop reading rows from the server until it settles (the extension stores rows
 * slower than a fast server sends them); it never rejects. Other events may return one too; the
 * driver may ignore it.
 */
export type ExecuteEventHandler = (event: ExecuteEvent) => void | Promise<void>;

/** Text of the message drivers report when a statement was canceled through its AbortSignal. */
export const QUERY_CANCELED_MESSAGE = "Query was canceled by user.";

export interface Batch {
    text: string;
    /** 0-based line of the batch's first line in the original script. */
    startLine: number;
}

// ---------------------------------------------------------------------------
// Execution plans
// ---------------------------------------------------------------------------

/**
 * "estimated": the statements are compiled, not run (SQL Server `SET SHOWPLAN_XML ON`,
 * PostgreSQL `EXPLAIN`). "actual": the statements run, with their effects, and the plan carries
 * run-time counters (`SET STATISTICS XML ON`, `EXPLAIN ANALYZE`).
 */
export type ExecutionPlanKind = "estimated" | "actual";

/**
 * Execution plans of an engine. A driver that has it also implements
 * `DriverConnection.executeForPlan`.
 */
export interface ExecutionPlanSupport {
    /** Extension of a saved plan document, without the dot: "sqlplan" (showplan XML), "json". */
    readonly fileExtension: string;
    /** VS Code language id of a plan document opened in an editor: "xml", "json". */
    readonly documentLanguage: string;
    /**
     * Converts a plan document (the `content` of an `executionPlan` event, or a saved file) into
     * the graphs Microsoft's execution plan page displays, one per statement: same shape as the
     * `graphs` of sqltoolsservice's `queryExecutionPlan/getExecutionPlan`. For an actual plan, the
     * operators also carry the run-time counters vscode-mssql adds to those graphs
     * (`liveQueryStatistics`: actual and estimated rows, elapsed time), which the page shows under
     * each operator; the statement root is a node of its own with no cost (the page adds the
     * root's cost to its subtree cost). Pure and synchronous: no connection is involved. Throws a
     * readable Error when the document is not a plan.
     */
    parse(content: string): ExecutionPlanGraph[];
}

/** Scripts an Object Explorer node can be turned into (vscode-mssql's ScriptOperation). */
export type ScriptOperation = "select" | "create" | "alter" | "delete" | "execute";

export interface ScriptDatabaseOptions {
    /** CREATE statements of every object of the database. */
    schema: boolean;
    /** INSERT statements for the rows of every table. */
    data: boolean;
}

// ---------------------------------------------------------------------------
// Autocompletion metadata
// ---------------------------------------------------------------------------

export type CompletionObjectKind =
    | "database"
    | "schema"
    | "table"
    | "view"
    | "function"
    | "procedure"
    | "type"
    | "sequence"
    | "synonym";

/** A database object autocompletion can offer. */
export interface CompletionObject {
    kind: CompletionObjectKind;
    /** Schema of the object; undefined for schemas and databases. */
    schema?: string;
    name: string;
    /** Short text shown next to the name: a routine's signature, a view vs. materialized view... */
    detail?: string;
    /** A function that returns rows (usable in FROM). */
    returnsTable?: boolean;
    /** Built into the engine (sys, INFORMATION_SCHEMA, pg_catalog...): offered only after its schema name. */
    system?: boolean;
}

export interface CompletionColumn {
    name: string;
    /** Type as displayed, e.g. "nvarchar(50)", "timestamptz". */
    dataType: string;
    nullable: boolean;
}

export interface DriverConnection {
    readonly serverInfo: ServerInfo;

    /** Database the session is currently using. */
    getCurrentDatabase(): Promise<string>;

    /** Switches the session's current database (USE for SQL Server, reconnect for PostgreSQL). */
    changeDatabase(database: string): Promise<void>;

    /** Names of the databases the login can see, sorted by name (fills the connection dialog's Database list). */
    listDatabases(): Promise<string[]>;

    /** Root node of the tree for this connection (the server node). */
    getRootNode(): ObjectNode;

    /** Children of a node, in display order. */
    expandNode(node: ObjectNode): Promise<ObjectNode[]>;

    /**
     * Script of the object behind an Object Explorer node. Rejects with a readable Error when the
     * operation is not supported for that node.
     */
    scriptObject(node: ObjectNode, operation: ScriptOperation): Promise<string>;

    /**
     * Script that recreates a database's objects and, optionally, its data, written in dependency
     * order through `write` (awaited: it may be a file). `onProgress` names what is being scripted.
     * Honors `signal` (rejects or resolves early, without leaving the session in a transaction).
     */
    scriptDatabase(
        database: string,
        options: ScriptDatabaseOptions,
        write: (text: string) => void | Promise<void>,
        signal: AbortSignal,
        onProgress?: (message: string) => void,
    ): Promise<void>;

    /**
     * Runs one batch (see Driver.splitBatches) and reports progress through `onEvent`.
     * Resolves when the batch is finished. Server errors are reported as error
     * messages (isError: true) and do NOT reject; the promise rejects only when the
     * connection itself fails. When `signal` is aborted, the driver cancels the
     * running statement on the server and resolves soon after.
     */
    execute(batch: Batch, onEvent: ExecuteEventHandler, signal: AbortSignal): Promise<void>;

    /**
     * Runs one batch for its execution plans. Same events, errors and cancellation as `execute`,
     * plus one `executionPlan` event per plan document. Defined exactly when the driver has
     * `Driver.executionPlan`.
     *   - "estimated": nothing is run. A statement the engine cannot plan is reported with an
     *     informational message, not an error.
     *   - "actual": every statement runs. SQL Server returns the rows of each statement and its
     *     plan; PostgreSQL's `EXPLAIN ANALYZE` returns the plan only, so statements it applies to
     *     report no rows, and the other statements run as `execute` runs them.
     * The session is left as it was found (no plan option still on), also after an error or a
     * cancellation.
     */
    executeForPlan?(
        batch: Batch,
        kind: ExecutionPlanKind,
        onEvent: ExecuteEventHandler,
        signal: AbortSignal,
    ): Promise<void>;

    /**
     * Information about an object, as SSMS's Alt+F1 (sp_help): general info, columns, identity,
     * indexes, constraints, references. `objectName` is the text the user selected, as typed
     * (possibly schema-qualified and quoted); undefined lists the objects of the current database.
     * Reports result sets and messages through `onEvent` exactly like `execute` (an unknown object is
     * an error message, not a rejection) and honors `signal` the same way.
     */
    describeObject(
        objectName: string | undefined,
        onEvent: ExecuteEventHandler,
        signal: AbortSignal,
    ): Promise<void>;

    /**
     * Objects of `database` (the session's current database) that autocompletion offers, plus the
     * names of the other databases where the engine can reference them. Like the two methods below,
     * it reads the catalog on a metadata connection, never on the query session (a query may be
     * running, a transaction may be open), and never changes the session's database.
     */
    listCompletionObjects(database: string, signal: AbortSignal): Promise<CompletionObject[]>;

    /**
     * Columns of relations (tables, views, table functions, synonyms of them) of `database`, in
     * table order, one list per relation; an unknown relation gives an empty list.
     */
    listCompletionColumns(
        database: string,
        relations: { schema: string; name: string }[],
        signal: AbortSignal,
    ): Promise<CompletionColumn[][]>;

    /**
     * Schemas searched, in order, for a name written without schema: the user's default schema for
     * SQL Server, the effective search_path for PostgreSQL.
     */
    listDefaultSchemas(database: string, signal: AbortSignal): Promise<string[]>;

    /**
     * Hint that catalog reads (Object Explorer, autocompletion) of `database` will follow; omitted,
     * the database the connection logged in to and the server-level reads. The driver may open its
     * metadata connection now, in the background. Returns at once, never throws and never rejects:
     * a failure is left for the next real read to report. Not called by short-lived connections
     * (connection dialog), which never read the catalog.
     */
    prepareMetadata?(database?: string): void;

    close(): Promise<void>;
}

/** Vocabulary of an engine's SQL dialect, for highlighting and autocompletion. Names are upper case. */
export interface SqlLanguage {
    /** Reserved and non-reserved keywords (SELECT, ILIKE, TOP...). */
    readonly keywords: ReadonlySet<string>;
    /** The subset of `keywords` that cannot be used as an identifier without quotes. */
    readonly reservedKeywords: ReadonlySet<string>;
    /** Built-in data type names (INT, NVARCHAR, TIMESTAMPTZ...); words of a name are separated by one space (DOUBLE PRECISION). */
    readonly dataTypes: ReadonlySet<string>;
    /** Built-in functions (GETDATE, COALESCE, NOW...), and globals written like variables (@@ROWCOUNT). */
    readonly functions: ReadonlySet<string>;
    /** Built-in constants and special values (NULL, TRUE, CURRENT_TIMESTAMP...); a subset of `keywords`. */
    readonly constants: ReadonlySet<string>;
    /** A line that only separates batches, such as SQL Server's "GO": its word is a keyword there only. */
    readonly batchSeparatorLine?: RegExp;
}

export interface Driver {
    readonly id: DriverId;
    /** e.g. "Microsoft SQL Server", "PostgreSQL". */
    readonly displayName: string;

    /** Option list for the connection dialog, same shape as sqltoolsservice's capabilities. */
    getConnectionOptions(): ConnectionProviderOptions;

    /** Opens a connection. Rejects with a readable Error on failure (bad password, unreachable...). */
    connect(params: ConnectParams): Promise<DriverConnection>;

    /**
     * Splits a script into batches. SQL Server: on "GO" lines (with optional repeat count).
     * PostgreSQL: the whole script is one batch; statements are handled inside `execute`.
     */
    splitBatches(script: string): Batch[];

    /** Splits a script into tokens with the engine's lexical rules (see src/sql/lexer.ts). */
    tokenize(script: string): SqlToken[];

    /** Keywords, data types and functions of the engine's SQL dialect. */
    readonly language: SqlLanguage;

    /** Execution plans; undefined for an engine without them (no plan command is offered). */
    readonly executionPlan?: ExecutionPlanSupport;

    /** Range of the statement at `position` (what "Execute Current Statement" runs); undefined when there is none. */
    getStatementAt(script: string, position: TextPosition): TextRange | undefined;

    /**
     * Parses a connection string into option values (names from getConnectionOptions()).
     * SQL Server: ADO.NET "Key=Value;..." syntax. PostgreSQL: libpq "key=value ..." or
     * "postgresql://" URI. Unknown keys are ignored. Throws a readable Error on bad syntax.
     */
    parseConnectionString(connectionString: string): ConnectionOptionValues;

    /** Builds a connection string from option values; the password is included only when asked. */
    buildConnectionString(options: ConnectionOptionValues, includePassword: boolean): string;

    /** Quotes an identifier: [name] for SQL Server, "name" for PostgreSQL. */
    quoteIdentifier(name: string): string;

    /**
     * The identifier as it should be written in a script: quoted only when the engine requires it
     * (reserved word, special characters, case for PostgreSQL).
     */
    formatIdentifier(name: string): string;

    /** Renders a value as a SQL literal for INSERT scripts and IN (...) clauses. */
    toSqlLiteral(value: CellValue, column: ColumnInfo): string;
}
