import * as sql from "mssql";
import { AuthenticationType } from "../types";
import type {
    Batch,
    CompletionColumn,
    CompletionObject,
    ConnectParams,
    DriverConnection,
    ExecuteEventHandler,
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
import { executeBatch } from "./execute";
import { ObjectExplorer, type Row } from "./objectExplorer";
import { serverQueries } from "./objectExplorerQueries";
import { ScriptCatalog } from "./scriptCatalog";
import { scriptDatabase } from "./scriptDatabase";
import { scriptObject } from "./scripting";
import { quoteIdentifier, spHelpBatch } from "./sqlText";
import { WINDOWS_AUTHENTICATION_HINT } from "./windowsAuthentication";
import { installRawValueReaders } from "./tediousRawValues";

// EngineEdition values of Azure-hosted SQL Server flavors: SQL Database, Synapse, Managed Instance, Synapse serverless, Fabric.
const CLOUD_ENGINE_EDITIONS = [5, 6, 8, 11, 12];

/** Metadata pools are small and may close idle connections. */
const METADATA_POOL_MAX = 2;

export class MssqlConnection implements DriverConnection {
    readonly serverInfo: ServerInfo;
    private readonly explorer: ObjectExplorer;
    private readonly metadataPools = new Map<string, Promise<sql.ConnectionPool>>();

    private constructor(
        private readonly params: ConnectParams,
        address: ServerAddress,
        /** The query session: ONE physical connection, so USE, SET options and #temp tables persist between batches. */
        private readonly sessionPool: sql.ConnectionPool,
        info: Row,
    ) {
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
        const result = await this.sessionPool.request().query("SELECT DB_NAME() AS name");
        return result.recordset[0].name;
    }

    async listDatabases(): Promise<string[]> {
        const result = await this.sessionPool
            .request()
            .query("SELECT name FROM sys.databases ORDER BY name");
        return result.recordset.map((row) => row.name);
    }

    async changeDatabase(database: string): Promise<void> {
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

    execute(batch: Batch, onEvent: ExecuteEventHandler, signal: AbortSignal): Promise<void> {
        return executeBatch(this.sessionPool, batch, onEvent, signal);
    }

    describeObject(
        objectName: string | undefined,
        onEvent: ExecuteEventHandler,
        signal: AbortSignal,
    ): Promise<void> {
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
        return listCompletionColumns(this.runInDatabase, database, relations, signal);
    }

    listDefaultSchemas(database: string, signal: AbortSignal): Promise<string[]> {
        return listDefaultSchemas(this.runInDatabase, database, signal);
    }

    async close(): Promise<void> {
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
     * Runs a batch in the context of `database` (sp_executesql of that database switches to it for the
     * call only) on a metadata connection; aborting `signal` cancels it on the server.
     */
    private readonly runInDatabase: DatabaseQueryRunner = async (database, text, signal) => {
        signal.throwIfAborted();
        const pool = await this.getMetadataPool(database);
        signal.throwIfAborted();
        const request = pool.request();
        // Dirty reads: an editor's open transaction holding locks on new objects must not block
        // autocompletion. The setting ends with sp_executesql, so the pooled connection keeps its own.
        request.input(
            "statement",
            sql.NVarChar(sql.MAX),
            `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n${text}`,
        );
        const cancel = () => request.cancel();
        signal.addEventListener("abort", cancel, { once: true });
        try {
            const result = await request.query(
                `EXEC ${quoteIdentifier(database)}.sys.sp_executesql @statement`,
            );
            signal.throwIfAborted();
            return result.recordsets as unknown as Row[][];
        } finally {
            signal.removeEventListener("abort", cancel);
        }
    };

    /**
     * Normally one pool serves every database (queries use three-part names). Azure SQL Database cannot
     * query another database from a connection, so there each database gets its own pool.
     */
    private getMetadataPool(database: string | undefined): Promise<sql.ConnectionPool> {
        const key = this.serverInfo.isCloud && database ? database : "";
        let pool = this.metadataPools.get(key);
        if (!pool) {
            pool = openPool(this.params, key || undefined, METADATA_POOL_MAX);
            // If opening fails, forget it so the next expand retries.
            pool.catch(() => this.metadataPools.delete(key));
            this.metadataPools.set(key, pool);
        }
        return pool;
    }
}

/** 16 for "16.0.4295.3". */
function serverMajorVersion(version: string): number {
    return Number.parseInt(version, 10) || 0;
}

async function openPool(
    params: ConnectParams,
    database: string | undefined,
    maxConnections = 1,
): Promise<sql.ConnectionPool> {
    const config = buildSqlConfig(
        params.options,
        params.getAccessToken,
        params.entraAllowedServers,
    );
    if (database) config.database = database;
    if (maxConnections > 1) config.pool = { ...config.pool, min: 0, max: maxConnections };

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
