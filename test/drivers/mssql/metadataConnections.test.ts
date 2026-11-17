import { afterEach, describe, expect, it, vi } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import type { DriverConnection, ObjectNode } from "../../../src/drivers/types";
import { FakeTdsServer, type FakeResultSet, type FakeTdsLogin } from "../../support/fakeTdsServer";

// The metadata connections of the SQL Server driver (Object Explorer, autocompletion), against
// test/support/fakeTdsServer.ts, which records every physical login and what it receives.
//
// mssql's ConnectionPool.connect() logs in once to test the server and closes that connection;
// the pool's first query logs in again. So a pool shows as two logins: the second one is the
// connection that carries the queries.

const HOST = "127.0.0.1";
const servers: FakeTdsServer[] = [];
const connections: DriverConnection[] = [];

/** What tedious sends on every new connection, before any query. */
const isSessionSetup = (sql: string) => sql.startsWith("set ansi_nulls on");
/** mssql's validation query, sent before every query taken from a pool. */
const isValidation = (sql: string) => sql === "SELECT 1;";
const isServerInfo = (sql: string) => sql.includes("SERVERPROPERTY('EngineEdition')");

/** The queries a login received, without the driver's own (setup, validation, server information). */
function queries(login: FakeTdsLogin): string[] {
    return login.requests.filter(
        (sql) => !isSessionSetup(sql) && !isValidation(sql) && !isServerInfo(sql),
    );
}

/** The logins that ran a catalog query or the warm-up, i.e. the metadata connections in use. */
function metadataLogins(server: FakeTdsServer): FakeTdsLogin[] {
    return server.logins.filter(
        (login) => queries(login).length > 0 && !login.requests.some(isServerInfo),
    );
}

/** The login that received a query matching `test`. */
function loginOf(server: FakeTdsServer, test: (sql: string) => boolean): FakeTdsLogin {
    const login = server.logins.find((l) => l.requests.some(test));
    if (!login) throw new Error("No login received that query");
    return login;
}

const databaseList = (sql: string) => sql.includes("database_id AS databaseId");
const tableListOf = (database: string) => (sql: string) => sql.includes(`[${database}].sys.tables`);

async function startServer(
    engineEdition: 3 | 5 | 6,
    databases: string[] = ["master", "pool"],
): Promise<FakeTdsServer> {
    const server = await new FakeTdsServer({
        identity: { version: "12.0.2000.8", edition: "SQL Azure", engineEdition },
    }).start();
    server.sqlLogins.set("pooluser", "pw");
    server.answer = (sql) =>
        sql.includes("SELECT SCHEMA_NAME()")
            ? { columns: ["name"], rows: [["dbo"]] }
            : sql.includes("FROM sys.databases")
              ? {
                    columns: ["name", "databaseId:int"],
                    // database_id 1 to 4 are system databases.
                    rows: databases.map((name, i) => [name, name === "master" ? 1 : i + 5]),
                }
              : undefined;
    servers.push(server);
    return server;
}

/** Answers the server information query with `databaseName` as DB_NAME(), as a server spells it. */
function spellDatabase(server: FakeTdsServer, databaseName: string): void {
    const answer = server.answer;
    server.answer = (sql, login) => {
        if (!isServerInfo(sql)) return answer(sql, login);
        const info = server.defaultAnswer(sql, login) as FakeResultSet;
        return { ...info, rows: [[...info.rows[0].slice(0, -1), databaseName]] };
    };
}

async function connect(server: FakeTdsServer, database?: string): Promise<DriverConnection> {
    const connection = await mssqlDriver.connect({
        options: {
            server: `${HOST},${server.port}`,
            authenticationType: "SqlLogin",
            user: "pooluser",
            password: "pw",
            database,
            trustServerCertificate: true,
            connectTimeout: 5,
        },
    });
    connections.push(connection);
    return connection;
}

/** Expands the nodes of a path, from the root; returns the children of its last node. */
async function expandPath(
    connection: DriverConnection,
    ...labels: string[]
): Promise<ObjectNode[]> {
    let children = await connection.expandNode(connection.getRootNode());
    for (const label of labels) {
        const child = children.find((c) => c.label === label);
        if (!child) throw new Error(`No "${label}": ${children.map((c) => c.label).join(", ")}`);
        children = await connection.expandNode(child);
    }
    return children;
}

/** Waits until the warm-up query of a metadata connection has been received. */
async function warmedUp(server: FakeTdsServer): Promise<FakeTdsLogin> {
    return vi.waitFor(() => {
        const login = server.logins.find((l) => l.requests.includes("SELECT 1"));
        if (!login) throw new Error("No warm-up yet");
        return login;
    });
}

afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()));
    await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("one metadata connection per database on cloud engines", () => {
    it("dedicated SQL pool: Databases and the pool's Tables are read on one connection, logged in to the pool", async () => {
        const server = await startServer(6, ["pool"]);
        const connection = await connect(server, "pool");
        const sessionLogins = server.logins.length;

        await expandPath(connection, "Databases", "pool", "Tables");

        // One metadata pool: its test login, then the connection that runs the queries.
        expect(server.logins.length - sessionLogins).toBe(2);
        expect(server.logins.every((login) => login.database === "pool")).toBe(true);
        expect(metadataLogins(server)).toHaveLength(1);
        expect(loginOf(server, databaseList)).toBe(loginOf(server, tableListOf("pool")));
    });

    it("Azure SQL Database: the profile's database shares the server-level connection, another database gets its own", async () => {
        const server = await startServer(5);
        const connection = await connect(server, "pool");

        await expandPath(connection, "Databases", "pool", "Tables");
        await expandPath(connection, "Databases", "System Databases", "master", "Tables");

        const serverLevel = loginOf(server, databaseList);
        expect(serverLevel.database).toBe("pool");
        expect(loginOf(server, tableListOf("pool"))).toBe(serverLevel);
        expect(loginOf(server, tableListOf("master")).database).toBe("master");
        expect(metadataLogins(server)).toHaveLength(2);
    });

    it("Azure SQL Database, profile with no database: server-level reads use the login's default database", async () => {
        const server = await startServer(5);
        const connection = await connect(server);

        await expandPath(connection, "Databases", "System Databases", "master", "Tables");

        const serverLevel = loginOf(server, databaseList);
        // DB_NAME() of the session, logged in to the default database, is master.
        expect(serverLevel.database).toBe("master");
        expect(loginOf(server, tableListOf("master"))).toBe(serverLevel);
        expect(metadataLogins(server)).toHaveLength(1);
    });

    it("Azure SQL Database, database typed in another letter case: the catalog's spelling is used", async () => {
        const server = await startServer(5);
        spellDatabase(server, "pool");
        const connection = await connect(server, "POOL");

        await expandPath(connection, "Databases", "pool", "Tables");
        await connection.listDefaultSchemas("pool", new AbortController().signal);

        const serverLevel = loginOf(server, databaseList);
        expect(serverLevel.database).toBe("pool");
        expect(loginOf(server, tableListOf("pool"))).toBe(serverLevel);
        expect(metadataLogins(server)).toHaveLength(1);
        // Logged in to the database: autocompletion sends its text as is.
        expect(serverLevel.requests.some((sql) => sql.includes("sp_executesql"))).toBe(false);
    });

    it("SQL Server on premises: one metadata connection for every database, switching with sp_executesql", async () => {
        const server = await startServer(3, ["master", "pool", "sales"]);
        const connection = await connect(server, "pool");

        await expandPath(connection, "Databases", "sales", "Tables");
        await connection.listDefaultSchemas("sales", new AbortController().signal);

        const metadata = metadataLogins(server);
        expect(metadata).toHaveLength(1);
        // The profile's database, as before: on premises the pool is not keyed on a database.
        expect(metadata[0].database).toBe("pool");
        expect(metadata[0].requests).toContain("EXEC [sales].sys.sp_executesql @yast_statement");
    });
});

describe("prepareMetadata", () => {
    it("logs in and runs a first query without any expand; the first expand then logs in no more", async () => {
        const server = await startServer(6, ["pool"]);
        const connection = await connect(server, "pool");

        connection.prepareMetadata?.();
        const warm = await warmedUp(server);
        const logins = server.logins.length;

        await expandPath(connection, "Databases", "pool", "Tables");

        expect(server.logins).toHaveLength(logins);
        expect(loginOf(server, databaseList)).toBe(warm);
        expect(loginOf(server, tableListOf("pool"))).toBe(warm);
    });

    it("prepares a given database's connection, and nothing for a database already prepared", async () => {
        const server = await startServer(5, ["master", "pool", "sales"]);
        const connection = await connect(server, "pool");

        connection.prepareMetadata?.("sales");
        const warm = await warmedUp(server);
        expect(warm.database).toBe("sales");
        const logins = server.logins.length;
        connection.prepareMetadata?.("sales");
        await expandPath(connection, "Databases", "sales", "Tables");

        // Databases opens the connection of the pool database (two logins); sales reuses its own.
        expect(server.logins).toHaveLength(logins + 2);
        expect(loginOf(server, databaseList).database).toBe("pool");
        expect(loginOf(server, tableListOf("sales"))).toBe(warm);
    });

    it("drops a failed warm-up silently; the next expand logs in again and succeeds", async () => {
        const server = await startServer(6, ["pool"]);
        const connection = await connect(server, "pool");
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
            server.refuseLogin = () => "Login failed for user 'pooluser'.";
            connection.prepareMetadata?.();
            await vi.waitFor(() => {
                if (!server.logins.at(-1) || server.logins.at(-1)!.accepted)
                    throw new Error("No refused login yet");
            });
            server.refuseLogin = () => undefined;
            const databasesFolder = (await connection.expandNode(connection.getRootNode()))[0];

            // An expand made before the refusal reaches the driver shares the failing open; the
            // first one after it opens the pool again.
            const databases = await vi.waitFor(() => connection.expandNode(databasesFolder));

            expect(databases.map((node) => node.label)).toEqual(["System Databases", "pool"]);
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off("unhandledRejection", unhandled);
        }
    });

    it("close() during a warm-up closes its connection too, and a later hint opens nothing", async () => {
        const server = await startServer(6, ["pool"]);
        const connection = await connect(server, "pool");

        connection.prepareMetadata?.();
        await connection.close();
        const loginsAtClose = server.logins.length;
        connection.prepareMetadata?.();
        await expect(
            connection.listDefaultSchemas("pool", new AbortController().signal),
        ).rejects.toThrow("The connection is closed.");
        await new Promise((resolve) => setTimeout(resolve, 200));

        await vi.waitFor(() => expect(server.openConnections).toBe(0));
        // The session's two logins, then the warm-up's: at least its test login, at most two.
        expect(loginsAtClose).toBeGreaterThanOrEqual(3);
        expect(server.logins.length).toBeLessThanOrEqual(4);
        // Nothing logs in after close(): neither the hint nor a catalog read.
        expect(server.logins).toHaveLength(loginsAtClose);
    });

    it("close() while the warm-up's query connection logs in leaves no connection open", async () => {
        const server = await startServer(6, ["pool"]);
        const connection = await connect(server, "pool");

        connection.prepareMetadata?.();
        await vi.waitFor(() => {
            if (server.logins.length < 4) throw new Error("The warm-up has not logged in yet");
        });
        await connection.close();
        await new Promise((resolve) => setTimeout(resolve, 200));

        await vi.waitFor(() => expect(server.openConnections).toBe(0));
        expect(server.logins).toHaveLength(4);
    });
});

describe("size of the metadata pool", () => {
    /**
     * Two catalog reads at once after a warm-up, as autocompletion's first load does (its object
     * list needs result sets the fake server does not build, so two schema reads stand in).
     */
    async function loadCompletion(server: FakeTdsServer): Promise<FakeTdsLogin> {
        const connection = await connect(server, "pool");
        connection.prepareMetadata?.();
        const warm = await warmedUp(server);
        // Slow answers, so that the second read starts while the first one runs.
        server.answerDelayMs = 50;
        const signal = new AbortController().signal;
        await Promise.all([
            connection.listDefaultSchemas("pool", signal),
            connection.listDefaultSchemas("pool", signal),
        ]);
        return warm;
    }

    it("dedicated SQL pool: one connection; the second read waits for the first instead of logging in", async () => {
        const server = await startServer(6, ["pool"]);
        const warm = await loadCompletion(server);

        expect(server.logins).toHaveLength(4);
        expect(metadataLogins(server)).toEqual([warm]);
        expect(queries(warm).filter((sql) => sql.includes("SCHEMA_NAME()"))).toHaveLength(2);
    });

    it("Azure SQL Database: two connections, so the two reads run side by side", async () => {
        const server = await startServer(5);
        await loadCompletion(server);

        expect(server.logins).toHaveLength(5);
        expect(metadataLogins(server)).toHaveLength(2);
    });
});

describe("Constraints folder", () => {
    it("reads check and default constraints in one query; checks first, each kind sorted by name", async () => {
        const server = await startServer(3, ["master", "pool"]);
        const answer = server.answer;
        server.answer = (sql, login) =>
            sql.includes(".sys.tables")
                ? {
                      columns: ["schemaName", "name", "temporalType:int"],
                      rows: [["dbo", "orders", 0]],
                  }
                : sql.includes("sys.check_constraints")
                  ? {
                        columns: ["kind", "name", "columnName"],
                        rows: [
                            ["D", "DF_b", "total"],
                            ["C", "CK_b", null],
                            ["D", "DF_a", "created"],
                            ["C", "CK_a", null],
                        ],
                    }
                  : answer(sql, login);
        const connection = await connect(server, "pool");

        const constraints = await expandPath(
            connection,
            "Databases",
            "pool",
            "Tables",
            "dbo.orders",
            "Constraints",
        );

        expect(constraints.map((node) => node.label)).toEqual(["CK_a", "CK_b", "DF_a", "DF_b"]);
        expect(constraints.map((node) => node.metadata?.metadataTypeName)).toEqual([
            "Check",
            "Check",
            "Default",
            "Default",
        ]);
        expect(constraints[2].metadata?.urn).toMatch(
            /\/Column\[@Name='created'\]\/Default\[@Name='DF_a'\]$/,
        );
        const sent = server.logins.flatMap((login) => login.requests);
        const constraintQueries = sent.filter(
            (sql) => sql.includes("check_constraints") || sql.includes("default_constraints"),
        );
        expect(constraintQueries).toHaveLength(1);
        expect(constraintQueries[0]).toMatch(
            /check_constraints[\s\S]*UNION ALL[\s\S]*default_constraints/,
        );
    });
});
