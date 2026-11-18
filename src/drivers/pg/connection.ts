import type { Client } from "pg";
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
import { listDatabases, loadTypeNames } from "./catalog";
import {
    ClientFactory,
    isAzureHost,
    resolveOptions,
    serverAddress,
    type ResolvedOptions,
} from "./clients";
import { listCompletionColumns, listCompletionObjects, listDefaultSchemas } from "./completion";
import { executeScript } from "./execute";
import { executeScriptForPlan, majorVersion } from "./executionPlan";
import { describePgObject } from "./objectInfo";
import { scriptDatabase } from "./scriptDatabase";
import { scriptObject } from "./scripting";
import { createServerNode, PgObjectExplorer } from "./tree";

/**
 * One PostgreSQL connection as the extension sees it:
 *  - a dedicated session Client for queries (keeps BEGIN, SET, temp tables alive),
 *  - lazily opened Clients for the Object Explorer, one per database,
 *    because a PostgreSQL connection is bound to a single database.
 */
export class PgConnection implements DriverConnection {
    private readonly typeNames = new Map<number, string>();
    private readonly explorerClients = new Map<string, Promise<Client>>();
    private readonly explorer: PgObjectExplorer;
    private readonly rootNode: ObjectNode;
    private closed = false;

    private constructor(
        private readonly options: ResolvedOptions,
        private readonly factory: ClientFactory,
        private session: Client,
        private currentDatabase: string,
        readonly serverInfo: ServerInfo,
    ) {
        const address = serverAddress(options);
        this.rootNode = createServerNode({
            address,
            label: `${address} (${serverInfo.productName} ${serverInfo.serverVersion} - ${serverInfo.userName})`,
        });
        this.explorer = new PgObjectExplorer(
            (database) => this.getExplorerClient(database),
            currentDatabase,
        );
    }

    static async open(params: ConnectParams): Promise<PgConnection> {
        const options = resolveOptions(params);
        const factory = new ClientFactory(options);
        const session = await openSession(factory, options, options.database);
        try {
            const serverInfo = await readServerInfo(session, options);
            const connection = new PgConnection(
                options,
                factory,
                session,
                options.database,
                serverInfo,
            );
            await connection.refreshTypeNames();
            return connection;
        } catch (error) {
            await session.end().catch(() => undefined);
            throw error;
        }
    }

    async getCurrentDatabase(): Promise<string> {
        return this.currentDatabase;
    }

    /** A PostgreSQL connection cannot switch database, so the session is replaced by a new one. */
    async changeDatabase(database: string): Promise<void> {
        if (database === this.currentDatabase) return;
        const next = await openSession(this.factory, this.options, database);
        const previous = this.session;
        this.session = next;
        this.currentDatabase = database;
        await previous.end().catch(() => undefined);
        await this.refreshTypeNames();
    }

    listDatabases(): Promise<string[]> {
        return listDatabases(this.session);
    }

    getRootNode(): ObjectNode {
        return this.rootNode;
    }

    expandNode(node: ObjectNode): Promise<ObjectNode[]> {
        return this.explorer.expand(node);
    }

    scriptObject(node: ObjectNode, operation: ScriptOperation): Promise<string> {
        return scriptObject(
            node,
            operation,
            (database) => this.getExplorerClient(database),
            (database) => this.factory.open(database, false),
        );
    }

    scriptDatabase(
        database: string,
        options: ScriptDatabaseOptions,
        write: (text: string) => void | Promise<void>,
        signal: AbortSignal,
        onProgress?: (message: string) => void,
    ): Promise<void> {
        return scriptDatabase(
            // Parsed values for the catalog; the cursor of the data asks for raw text itself.
            () => this.factory.open(database, false),
            options,
            write,
            signal,
            onProgress,
        );
    }

    execute(batch: Batch, onEvent: ExecuteEventHandler, signal: AbortSignal): Promise<void> {
        const session = this.session;
        return executeScript(
            {
                client: session,
                typeNames: this.typeNames,
                cancel: () => this.cancelBackend(session),
            },
            batch,
            onEvent,
            signal,
        );
    }

    executeForPlan(
        batch: Batch,
        kind: ExecutionPlanKind,
        onEvent: ExecuteEventHandler,
        signal: AbortSignal,
    ): Promise<void> {
        const session = this.session;
        return executeScriptForPlan(
            {
                client: session,
                typeNames: this.typeNames,
                cancel: () => this.cancelBackend(session),
            },
            batch,
            kind,
            majorVersion(this.serverInfo.serverVersion),
            onEvent,
            signal,
        );
    }

    describeObject(
        objectName: string | undefined,
        onEvent: ExecuteEventHandler,
        signal: AbortSignal,
    ): Promise<void> {
        const session = this.session;
        return describePgObject(
            {
                client: session,
                typeNames: this.typeNames,
                cancel: () => this.cancelBackend(session),
            },
            this.currentDatabase,
            objectName,
            onEvent,
            signal,
        );
    }

    listCompletionObjects(database: string, signal: AbortSignal): Promise<CompletionObject[]> {
        return this.readCatalog(database, signal, (client) => listCompletionObjects(client));
    }

    listCompletionColumns(
        database: string,
        relations: { schema: string; name: string }[],
        signal: AbortSignal,
    ): Promise<CompletionColumn[][]> {
        return this.readCatalog(database, signal, (client) =>
            listCompletionColumns(client, relations),
        );
    }

    listDefaultSchemas(database: string, signal: AbortSignal): Promise<string[]> {
        return this.readCatalog(database, signal, (client) =>
            listDefaultSchemas(client, this.options.searchPath),
        );
    }

    async close(): Promise<void> {
        this.closed = true;
        const explorerClients = await Promise.allSettled([...this.explorerClients.values()]);
        this.explorerClients.clear();
        const clients = [this.session];
        for (const result of explorerClients) {
            if (result.status === "fulfilled") clients.push(result.value);
        }
        await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    }

    // -- internals ----------------------------------------------------------

    /**
     * Runs catalog reads on the Object Explorer client of `database`. The client is shared, so an
     * abort does not cancel the query: the caller simply stops waiting for it.
     */
    private readCatalog<T>(
        database: string,
        signal: AbortSignal,
        read: (client: Client) => Promise<T>,
    ): Promise<T> {
        signal.throwIfAborted();
        return new Promise<T>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            this.getExplorerClient(database)
                .then(read)
                .then(resolve, reject)
                .finally(() => signal.removeEventListener("abort", abort));
        });
    }

    private getExplorerClient(database: string): Promise<Client> {
        if (this.closed) return Promise.reject(new Error("The connection is closed."));
        let client = this.explorerClients.get(database);
        if (!client) {
            client = this.factory.open(database, false);
            this.explorerClients.set(database, client);
            // A failed or dropped connection must not stay in the cache.
            const forget = () => {
                if (this.explorerClients.get(database) === client)
                    this.explorerClients.delete(database);
            };
            client.then((c) => c.on("error", forget), forget);
        }
        return client;
    }

    /** Asks the server to cancel the running statement, from a short-lived second connection. */
    private async cancelBackend(session: Client): Promise<void> {
        const pid = (session as any).processID as number;
        const canceller = await this.factory.open(this.currentDatabase, false);
        try {
            await canceller.query("SELECT pg_cancel_backend($1)", [pid]);
        } finally {
            await canceller.end().catch(() => undefined);
        }
    }

    private async refreshTypeNames(): Promise<void> {
        const names = await loadTypeNames(this.session);
        this.typeNames.clear();
        names.forEach((name, oid) => this.typeNames.set(oid, name));
    }
}

/** Opens a query session and applies the session-level options. */
async function openSession(
    factory: ClientFactory,
    options: ResolvedOptions,
    database: string,
): Promise<Client> {
    const client = await factory.open(database, true);
    if (options.searchPath) {
        try {
            await client.query("SELECT set_config('search_path', $1, false)", [options.searchPath]);
        } catch (error) {
            await client.end().catch(() => undefined);
            throw error;
        }
    }
    return client;
}

async function readServerInfo(session: Client, options: ResolvedOptions): Promise<ServerInfo> {
    const version = await session.query("SHOW server_version");
    const user = await session.query("SELECT current_user AS name");
    return {
        // "17.2 (Debian 17.2-1.pgdg120+1)" -> "17.2"
        serverVersion: String(version.rows[0].server_version).split(" ")[0],
        productName: "PostgreSQL",
        edition: "",
        isCloud: isAzureHost(options.host),
        userName: user.rows[0].name,
    };
}
