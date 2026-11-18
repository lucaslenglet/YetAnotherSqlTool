import * as sql from "mssql";
import { AuthenticationType } from "../types";
import type {
    Batch,
    CompletionColumn,
    CompletionObject,
    ConnectParams,
    DriverConnection,
    ExecuteEventHandler,
    ExecutionPlanKind,
    ObjectNode,
    ScriptDatabaseOptions,
    ScriptOperation,
    ServerInfo,
} from "../types";
import {
    buildSqlConfig,
    explainEncryptionRefusal,
    parseServer,
    type ServerAddress,
} from "./connectionConfig";
import { assertSupportedAuthenticationType } from "./connectionOptions";
import {
    listCompletionColumns,
    listCompletionObjects,
    listDefaultSchemas,
    type DatabaseQueryRunner,
} from "./completion";
import { executeBatch, executeBatchForPlan } from "./execute";
import { DEDICATED_SQL_POOL_ENGINE_EDITION, ObjectExplorer, type Row } from "./objectExplorer";
import { serverQueries } from "./objectExplorerQueries";
import { ScriptCatalog } from "./scriptCatalog";
import { scriptDatabase } from "./scriptDatabase";
import { scriptObject } from "./scripting";
import { quoteIdentifier, spHelpBatch } from "./sqlText";
import { WINDOWS_AUTHENTICATION_HINT } from "./windowsAuthentication";
import { installRawValueReaders } from "./tediousRawValues";

// EngineEdition values of Azure-hosted SQL Server flavors: SQL Database, Synapse, Managed Instance, Synapse serverless, Fabric.
const CLOUD_ENGINE_EDITIONS = [5, 6, 8, 11, 12];

export const DEDICATED_POOL_NO_PLAN_MESSAGE =
    "Execution plans are not available on an Azure Synapse Analytics dedicated SQL pool: it supports neither SET SHOWPLAN_XML nor SET STATISTICS XML. EXPLAIN, in the query, shows the plan of a statement.";

/**
 * Connections of a metadata pool. A dedicated SQL pool gets one: a new connection there costs
 * seconds (two logins, see `prepareMetadata`) and takes one of the few queries the pool runs at
 * a time, so a second catalog read waits behind the first one rather than for a login.
 */
function metadataPoolMax(engineEdition: number): number {
    return engineEdition === DEDICATED_SQL_POOL_ENGINE_EDITION ? 1 : 2;
}

export class MssqlConnection implements DriverConnection {
    readonly serverInfo: ServerInfo;
    private readonly engineEdition: number;
    /** DB_NAME() when the session opened, in the catalog's spelling; "" when the server gave none. */
    private readonly loginDatabase: string;
    private readonly explorer: ObjectExplorer;
    private readonly metadataPools = new Map<string, Promise<sql.ConnectionPool>>();
    private closed = false;
    /**
     * The running executeForPlan, if any. Its SET ... ON, batch and SET ... OFF are three requests
     * on the session: anything else sent on the session waits until it is over, so that it neither
     * runs with a plan option on nor gets a plan instead of its result.
     */
    private planRun: Promise<void> = Promise.resolve();

    private constructor(
        private readonly params: ConnectParams,
        address: ServerAddress,
        /** The query session: ONE physical connection, so USE, SET options and #temp tables persist between batches. */
        private sessionPool: sql.ConnectionPool,
        info: Row,
    ) {
        this.engineEdition = info.engineEdition;
        this.loginDatabase = info.databaseName ?? "";
        this.serverInfo = {
            serverVersion: info.version,
            productName: "SQL Server",
            edition: info.edition ?? "",
            isCloud: CLOUD_ENGINE_EDITIONS.includes(info.engineEdition),
            userName: info.loginName,
        };
        this.explorer = new ObjectExplorer(
            {
                serverDisplayName: address.displayName,
                serverName: info.serverName,
                version: this.serverInfo.serverVersion,
                userName: this.serverInfo.userName,
                engineEdition: this.engineEdition,
            },
            (database, text, parameters) => this.runMetadataQuery(database, text, parameters),
        );
    }

    /** Opens the query session and reads the server's identity. Rejects with a readable Error. */
    static async open(params: ConnectParams): Promise<MssqlConnection> {
        assertSupportedAuthenticationType(params.options.authenticationType);
        installRawValueReaders();
        const address = parseServer(
            String(params.options.server ?? ""),
            Number(params.options.port) || undefined,
        );
        const pool = await openPool(params, undefined);
        try {
            const result = await pool.request().query(serverQueries.serverInfo);
            return new MssqlConnection(params, address, pool, result.recordset[0]);
        } catch (error) {
            await pool.close().catch(() => undefined);
            throw new Error(
                describeConnectionError(error, address, params.options.authenticationType),
            );
        }
    }

    async getCurrentDatabase(): Promise<string> {
        await this.planRun;
        const result = await this.sessionPool.request().query("SELECT DB_NAME() AS name");
        return result.recordset[0].name;
    }

    async listDatabases(): Promise<string[]> {
        await this.planRun;
        const result = await this.sessionPool
            .request()
            .query(
                this.engineEdition === DEDICATED_SQL_POOL_ENGINE_EDITION
                    ? `${serverQueries.dedicatedPoolDatabases} ORDER BY name`
                    : "SELECT name FROM sys.databases ORDER BY name",
            );
        return result.recordset.map((row) => row.name);
    }

    async changeDatabase(database: string): Promise<void> {
        await this.planRun;
        if (this.engineEdition === DEDICATED_SQL_POOL_ENGINE_EDITION) {
            // Dedicated SQL pools do not support USE: the session logs in to the database instead.
            const previous = this.sessionPool;
            this.sessionPool = await openPool(this.params, database);
            // Waits for a query still running on the previous session, as USE would.
            await previous.close().catch(() => undefined);
            return;
        }
        // USE on the session connection: it stays in effect for the following batches.
        await this.sessionPool.request().batch(`USE ${quoteIdentifier(database)}`);
    }

    getRootNode(): ObjectNode {
        return this.explorer.getRootNode();
    }

    expandNode(node: ObjectNode): Promise<ObjectNode[]> {
        return this.explorer.expandNode(node);
    }

    scriptObject(node: ObjectNode, operation: ScriptOperation): Promise<string> {
        return scriptObject(
            node,
            operation,
            (database, text, parameters) => this.runMetadataQuery(database, text, parameters),
            serverMajorVersion(this.serverInfo.serverVersion),
        );
    }

    scriptDatabase(
        database: string,
        options: ScriptDatabaseOptions,
        write: (text: string) => void | Promise<void>,
        signal: AbortSignal,
        onProgress?: (message: string) => void,
    ): Promise<void> {
        const catalog = new ScriptCatalog(
            database,
            (db, text, parameters) => this.runMetadataQuery(db, text, parameters),
            serverMajorVersion(this.serverInfo.serverVersion),
        );
        // The rows are read on a connection of their own, so the session is left as it is.
        const openDataPool = () => openPool(this.params, database);
        return scriptDatabase({ catalog, openDataPool }, options, write, signal, onProgress);
    }

    async execute(batch: Batch, onEvent: ExecuteEventHandler, signal: AbortSignal): Promise<void> {
        await this.planRun;
        return executeBatch(this.sessionPool, batch, onEvent, signal);
    }

    async executeForPlan(
        batch: Batch,
        kind: ExecutionPlanKind,
        onEvent: ExecuteEventHandler,
        signal: AbortSignal,
    ): Promise<void> {
        if (this.engineEdition === DEDICATED_SQL_POOL_ENGINE_EDITION) {
            // Dedicated SQL pools reject SET SHOWPLAN_XML and SET STATISTICS XML (sqltoolsservice
            // then runs the batch without a plan). An estimated plan must not run the batch: nothing
            // is sent. An actual plan runs it, as sqltoolsservice does, without a plan.
            if (kind === "estimated") {
                onEvent({ type: "message", text: DEDICATED_POOL_NO_PLAN_MESSAGE, isError: true });
                return;
            }
            onEvent({ type: "message", text: DEDICATED_POOL_NO_PLAN_MESSAGE, isError: false });
            return this.execute(batch, onEvent, signal);
        }
        const run = this.planRun.then(() =>
            executeBatchForPlan(this.sessionPool, batch, kind, onEvent, signal),
        );
        this.planRun = run.catch(() => undefined);
        return run;
    }

    async describeObject(
        objectName: string | undefined,
        onEvent: ExecuteEventHandler,
        signal: AbortSignal,
    ): Promise<void> {
        await this.planRun;
        // Same path as a typed query, so grids and messages are exactly sp_help's.
        return executeBatch(
            this.sessionPool,
            { text: spHelpBatch(objectName), startLine: 0 },
            onEvent,
            signal,
        );
    }

    listCompletionObjects(database: string, signal: AbortSignal): Promise<CompletionObject[]> {
        return listCompletionObjects(this.runInDatabase, database, signal);
    }

    listCompletionColumns(
        database: string,
        relations: { schema: string; name: string }[],
        signal: AbortSignal,
    ): Promise<CompletionColumn[][]> {
        return listCompletionColumns(
            this.runInDatabase,
            database,
            relations,
            signal,
            this.engineEdition === DEDICATED_SQL_POOL_ENGINE_EDITION,
        );
    }

    listDefaultSchemas(database: string, signal: AbortSignal): Promise<string[]> {
        return listDefaultSchemas(this.runInDatabase, database, signal);
    }

    /**
     * Opens the metadata pool of `database` (omitted: the database the connection logged in to)
     * and runs a first query on it, in the background. mssql's connect() logs in once to test the
     * server and drops that connection, so the first query logs in again: both happen here rather
     * than while the user waits for a node. A failure is dropped: the next catalog read opens the
     * pool again.
     */
    prepareMetadata(database?: string): void {
        if (this.closed || this.metadataPools.has(this.metadataPoolKey(database))) return;
        this.getMetadataPool(database)
            .then((pool) => pool.request().query("SELECT 1"))
            .catch(() => undefined);
    }

    async close(): Promise<void> {
        this.closed = true;
        const metadataPools = await Promise.all(
            [...this.metadataPools.values()].map((pool) => pool.catch(() => undefined)),
        );
        await Promise.all(
            [this.sessionPool, ...metadataPools].map((pool) =>
                pool?.close().catch(() => undefined),
            ),
        );
        this.metadataPools.clear();
    }

    // -----------------------------------------------------------------------
    // Object Explorer queries run on their own connections, so they neither wait for a long-running
    // query nor change the session's database.
    // -----------------------------------------------------------------------

    private async runMetadataQuery(
        database: string | undefined,
        text: string,
        parameters: Record<string, string> = {},
    ): Promise<Row[]> {
        const pool = await this.getMetadataPool(database);
        const request = pool.request();
        for (const [name, value] of Object.entries(parameters))
            request.input(name, sql.NVarChar, value);
        const result = await request.query(text);
        return result.recordset;
    }

    /**
     * Runs a batch in the context of `database` on a metadata connection; aborting `signal` cancels
     * it on the server.
     */
    private readonly runInDatabase: DatabaseQueryRunner = async (database, text, signal) => {
        signal.throwIfAborted();
        const pool = await this.getMetadataPool(database);
        signal.throwIfAborted();
        const request = pool.request();
        const batch = databaseBatch(database, this.metadataPoolKey(database), text);
        if (batch.statement !== undefined)
            request.input(STATEMENT_PARAMETER, sql.NVarChar(sql.MAX), batch.statement);
        const cancel = () => request.cancel();
        signal.addEventListener("abort", cancel, { once: true });
        try {
            const result = await request.query(batch.text);
            signal.throwIfAborted();
            return result.recordsets as unknown as Row[][];
        } finally {
            signal.removeEventListener("abort", cancel);
        }
    };

    /**
     * Normally one pool serves every database (queries use three-part names). Azure SQL Database cannot
     * query another database from a connection, so on cloud engines each database gets its own pool,
     * and server-level reads (no database) share the pool of the database the connection logged in to.
     */
    private getMetadataPool(database: string | undefined): Promise<sql.ConnectionPool> {
        // A pool opened after close() would never be closed.
        if (this.closed) return Promise.reject(new Error("The connection is closed."));
        const key = this.metadataPoolKey(database);
        let pool = this.metadataPools.get(key);
        if (!pool) {
            pool = openPool(this.params, key || undefined, metadataPoolMax(this.engineEdition));
            // If opening fails, forget it so the next expand retries.
            pool.catch(() => this.metadataPools.delete(key));
            this.metadataPools.set(key, pool);
        }
        return pool;
    }

    /** The database the metadata pool serving `database` logs in to; "" for the profile's own. */
    private metadataPoolKey(database: string | undefined): string {
        return this.serverInfo.isCloud ? database || this.loginDatabase : "";
    }
}

/**
 * Not "statement": mssql sends every query through sp_executesql with its inputs declared, and
 * dedicated SQL pools reject a nested sp_executesql that declares the same name again.
 */
const STATEMENT_PARAMETER = "yast_statement";

/**
 * What `runInDatabase` sends: `text` itself when the connection is logged in to `database`,
 * otherwise `EXEC [database].sys.sp_executesql`, which switches to that database for the call
 * only, with `statement` as the value of @yast_statement.
 */
export function databaseBatch(
    database: string,
    connectedDatabase: string,
    text: string,
): { text: string; statement?: string } {
    // Dirty reads: an editor's open transaction holding locks on new objects must not block
    // autocompletion. mssql runs the text through sp_executesql and the setting ends with it, so
    // the pooled connection keeps its own.
    const statement = `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n${text}`;
    if (connectedDatabase === database) return { text: statement };
    return {
        text: `EXEC ${quoteIdentifier(database)}.sys.sp_executesql @${STATEMENT_PARAMETER}`,
        statement,
    };
}

/** 16 for "16.0.4295.3". */
function serverMajorVersion(version: string): number {
    return Number.parseInt(version, 10) || 0;
}

async function openPool(
    params: ConnectParams,
    database: string | undefined,
    /** For a metadata pool: its size; it then opens connections on demand only. */
    metadataMax?: number,
): Promise<sql.ConnectionPool> {
    const config = buildSqlConfig(
        params.options,
        params.getAccessToken,
        params.entraAllowedServers,
    );
    if (database) config.database = database;
    if (metadataMax !== undefined) config.pool = { ...config.pool, min: 0, max: metadataMax };

    const pool = new sql.ConnectionPool(config);
    // Errors of idle connections are reported on the pool; without a listener Node would crash.
    pool.on("error", () => undefined);
    try {
        await pool.connect();
    } catch (error) {
        let message = describeConnectionError(
            error,
            parseServer(
                String(params.options.server ?? ""),
                Number(params.options.port) || undefined,
            ),
            params.options.authenticationType,
        );
        if (
            params.options.authenticationType === AuthenticationType.Integrated &&
            isLoginFailure(error)
        ) {
            message += ` ${WINDOWS_AUTHENTICATION_HINT}`;
        }
        if (message.includes("<token-identified principal>") && !config.database) {
            // Entra users created in a database (contained users) can only log in to that database.
            message +=
                " If this account is a user of a single database, enter that database in the connection.";
        }
        throw new Error(message);
    }
    return pool;
}

/** A readable one-line reason, e.g. "Cannot connect to localhost,1433: Login failed for user 'sa'." */
function describeConnectionError(
    error: unknown,
    address: ServerAddress,
    authenticationType: unknown,
): string {
    const details =
        errorMessages(error)
            .map((message) => explainEncryptionRefusal(message, authenticationType))
            .join("; ") || "unknown error";
    if (details.startsWith("Cannot connect") || details.startsWith("Failed to connect"))
        return details;
    return `Cannot connect to ${address.displayName}: ${details}`;
}

/** True when the server answered and refused the login (tedious' ELOGIN), as opposed to a network failure. */
function isLoginFailure(error: unknown): boolean {
    const candidate = error as { code?: string; originalError?: unknown } | undefined;
    return (
        candidate?.code === "ELOGIN" ||
        (!!candidate?.originalError && isLoginFailure(candidate.originalError))
    );
}

/** Messages of an error and of the errors nested in it (AggregateError, mssql's originalError). */
function errorMessages(error: unknown): string[] {
    const candidate = error as
        { message?: string; errors?: unknown[]; originalError?: unknown } | undefined;
    if (!candidate) return [];
    const nested = [...(candidate.errors ?? []), candidate.originalError]
        .filter(Boolean)
        .flatMap(errorMessages);
    return candidate.message ? [candidate.message] : nested;
}
