import { afterEach, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { databaseBatch } from "../../../src/drivers/mssql/connection";
import { serverQueries } from "../../../src/drivers/mssql/objectExplorerQueries";
import type { DriverConnection, ObjectNode } from "../../../src/drivers/types";
import { FakeTdsServer, type FakeServerError } from "../../support/fakeTdsServer";

// Azure Synapse Analytics dedicated SQL pools (EngineEdition 6), with no pool at hand: the real
// driver (mssql + tedious) talks to test/support/fakeTdsServer.ts, which answers like a pool
// with the errors a real one returned for what it does not support, and records what it receives.
// The same server, presented as Azure SQL Database (EngineEdition 5), checks that nothing changes
// for other editions.

const HOST = "127.0.0.1";
const POOL = "pool";
const servers: FakeTdsServer[] = [];
const connections: DriverConnection[] = [];

const error = (number: number, message: string): FakeServerError => ({ error: message, number });

/** What a dedicated pool rejects, with the errors a real one returns. */
function poolRejection(sql: string): FakeServerError | undefined {
    if (sql.includes("@@SERVERNAME"))
        return error(137, 'Must declare the scalar variable "@@SERVERNAME".');
    for (const view of ["triggers", "table_types", "sequences"]) {
        if (sql.includes(`.sys.${view}`))
            return error(104385, `Catalog view '${view}' is not supported in this version.`);
    }
    if (/sp_executesql @statement\b/.test(sql))
        return error(
            104017,
            "104017;The variable name '@statement' has already been declared.Variable names must be unique within a query batch or stored procedure.",
        );
    if (/^\s*USE\s/i.test(sql)) return error(104455, "USE statement is not supported.");
    return undefined;
}

async function startServer(engineEdition: 3 | 5 | 6): Promise<FakeTdsServer> {
    const server = await new FakeTdsServer({
        identity:
            engineEdition === 6
                ? { version: "10.0.15685.0", edition: "SQL Azure", engineEdition }
                : engineEdition === 5
                  ? { version: "12.0.2000.8", edition: "SQL Azure", engineEdition }
                  : { version: "16.0.4295.3", edition: "Developer Edition", engineEdition },
    }).start();
    server.sqlLogins.set("pooluser", "pw");
    // On the pool, a user of the pool database only (contained user).
    server.refuseLogin = (login) =>
        login.database === "" || (engineEdition === 6 && login.database === "master")
            ? "Login failed for user 'pooluser'."
            : undefined;
    server.answer = (sql, login) => {
        const rejected = engineEdition === 6 ? poolRejection(sql) : undefined;
        if (rejected) return rejected;
        if (sql.includes("FROM sys.databases")) {
            const all: [string, number][] = [
                ["master", 1],
                [POOL, 5],
            ];
            // HAS_DBACCESS('master') is 0 for this user; DB_NAME() is the pool.
            const visible = sql.includes("HAS_DBACCESS")
                ? all.filter(([name]) => name === login.database)
                : all;
            return { columns: ["name", "databaseId:int"], rows: visible };
        }
        if (sql.includes(".sys.tables"))
            return {
                columns: ["schemaName", "name", "temporalType:int"],
                rows: [["dbo", "fact_sales", 0]],
            };
        if (sql.includes(".sys.views"))
            return { columns: ["schemaName", "name"], rows: [["dbo", "v_sales"]] };
        return undefined;
    };
    servers.push(server);
    return server;
}

async function connect(server: FakeTdsServer): Promise<DriverConnection> {
    const connection = await mssqlDriver.connect({
        options: {
            server: `${HOST},${server.port}`,
            authenticationType: "SqlLogin",
            user: "pooluser",
            password: "pw",
            database: POOL,
            trustServerCertificate: true,
            connectTimeout: 5,
        },
    });
    connections.push(connection);
    return connection;
}

/** Expands every node of the tree; returns the labels of the children of each expanded node, by path. */
async function walk(connection: DriverConnection): Promise<Map<string, string[]>> {
    const tree = new Map<string, string[]>();
    const visit = async (node: ObjectNode) => {
        const children = await connection.expandNode(node);
        tree.set(
            node.nodePath,
            children.map((child) => child.label),
        );
        for (const child of children) if (!child.isLeaf) await visit(child);
    };
    await visit(connection.getRootNode());
    return tree;
}

/** The children of the node at `path`, relative to the root ("" is the root). */
function childrenAt(tree: Map<string, string[]>, root: string, path: string): string[] {
    const children = tree.get(path ? `${root}/${path}` : root);
    if (!children) throw new Error(`"${path}" was not expanded`);
    return children;
}

afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()));
    await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("a dedicated SQL pool (EngineEdition 6)", () => {
    it("connects: the server's identity is read without @@SERVERNAME", async () => {
        const server = await startServer(6);
        const connection = await connect(server);

        expect(connection.serverInfo).toMatchObject({
            serverVersion: "10.0.15685.0",
            isCloud: true,
        });
        expect(connection.getRootNode().label).toBe(
            `${HOST},${server.port} (SQL Server 10.0.15685.0 - someone@contoso.com)`,
        );
    });

    it("shows the Object Explorer folders sqltoolsservice shows for a pool, and every one of them expands", async () => {
        const server = await startServer(6);
        const connection = await connect(server);
        const root = connection.getRootNode().nodePath;
        const tree = await walk(connection);
        const at = (path: string) => childrenAt(tree, root, path);

        expect(at("")).toEqual(["Databases", "Security"]);
        expect(at("Security")).toEqual(["Logins"]);
        // master is listed by sys.databases but cannot be opened by a user of the pool alone.
        expect(at("Databases")).toEqual(["System Databases", POOL]);
        expect(at("Databases/System Databases")).toEqual([]);

        const db = `Databases/${POOL}`;
        expect(at(db)).toEqual(["Tables", "Views", "Programmability", "Security"]);
        expect(at(`${db}/Tables/dbo.fact_sales`)).toEqual([
            "Columns",
            "Constraints",
            "Indexes",
            "Statistics",
        ]);
        expect(at(`${db}/Views/dbo.v_sales`)).toEqual(["Columns", "Indexes", "Statistics"]);
        expect(at(`${db}/Programmability`)).toEqual(["Stored Procedures", "Functions", "Types"]);
        expect(at(`${db}/Programmability/Functions`)).toEqual(["Scalar-valued Functions"]);
        expect(at(`${db}/Programmability/Types`)).toEqual([]);
        expect(at(`${db}/Security`)).toEqual(["Users", "Roles", "Schemas"]);
        expect(at(`${db}/Security/Roles`)).toEqual(["Database Roles"]);

        const databaseLists = server.logins
            .flatMap((login) => login.requests)
            .filter((sql) => sql.includes("database_id AS databaseId"));
        expect(databaseLists.length).toBeGreaterThan(0);
        expect(databaseLists.every((sql) => sql.includes("HAS_DBACCESS(name) = 1"))).toBe(true);
    });

    it("offers Change Database only the databases the user can open, the current one always", async () => {
        const server = await startServer(6);
        const connection = await connect(server);

        expect(await connection.listDatabases()).toEqual([POOL]);
        const sent = server.logins.flatMap((login) => login.requests);
        expect(sent).toContain(`${serverQueries.dedicatedPoolDatabases} ORDER BY name`);
        // The current database stays even when HAS_DBACCESS does not say 1 for it.
        expect(serverQueries.dedicatedPoolDatabases).toMatch(
            /WHERE name = DB_NAME\(\) OR HAS_DBACCESS\(name\) = 1/,
        );
    });

    it("reads autocompletion metadata on the pool's own connection, without sp_executesql of the database", async () => {
        const server = await startServer(6);
        const connection = await connect(server);
        const signal = new AbortController().signal;

        server.answer = (sql) =>
            poolRejection(sql) ??
            (sql.includes("SELECT SCHEMA_NAME()")
                ? { columns: ["name"], rows: [["analyst"]] }
                : undefined);
        await expect(connection.listDefaultSchemas(POOL, signal)).resolves.toEqual([
            "analyst",
            "dbo",
        ]);

        const sent = server.logins
            .filter((login) => login.database === POOL)
            .flatMap((login) => login.requests);
        expect(sent).toContain(
            "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\nSELECT SCHEMA_NAME() AS name",
        );
        expect(sent.some((sql) => sql.includes("sp_executesql"))).toBe(false);
    });

    it("changes the database of the session by logging in to it, since USE is not supported", async () => {
        const server = await startServer(6);
        const connection = await connect(server);

        await connection.changeDatabase("pool2");

        expect(await connection.getCurrentDatabase()).toBe("pool2");
        expect(server.logins.at(-1)).toMatchObject({ database: "pool2", accepted: true });
        const sent = server.logins.flatMap((login) => login.requests);
        expect(sent.some((sql) => /^\s*USE\s/i.test(sql))).toBe(false);
    });
});

describe("other editions keep their behavior", () => {
    it("Azure SQL Database (EngineEdition 5): the whole tree, from the unfiltered database list", async () => {
        const server = await startServer(5);
        const connection = await connect(server);
        const root = connection.getRootNode().nodePath;
        const tree = await walk(connection);
        const at = (path: string) => childrenAt(tree, root, path);

        expect(at("Security")).toEqual(["Logins", "Server Roles"]);
        expect(at("Databases/System Databases")).toEqual(["master"]);
        expect(await connection.listDatabases()).toEqual(["master", POOL]);
        expect(server.logins.flatMap((login) => login.requests)).toContain(
            "SELECT name FROM sys.databases ORDER BY name",
        );
        const db = `Databases/${POOL}`;
        expect(at(db)).toEqual(["Tables", "Views", "Synonyms", "Programmability", "Security"]);
        expect(at(`${db}/Tables/dbo.fact_sales`)).toEqual([
            "Columns",
            "Keys",
            "Constraints",
            "Triggers",
            "Indexes",
            "Statistics",
        ]);
        expect(at(`${db}/Programmability`)).toEqual([
            "Stored Procedures",
            "Functions",
            "Database Triggers",
            "Types",
            "Sequences",
        ]);
        expect(at(`${db}/Programmability/Functions`)).toEqual([
            "Table-valued Functions",
            "Scalar-valued Functions",
            "Aggregate Functions",
        ]);
        expect(at(`${db}/Programmability/Types`)).toEqual([
            "User-Defined Data Types",
            "User-Defined Table Types",
        ]);
        expect(at(`${db}/Security/Roles`)).toEqual(["Database Roles", "Application Roles"]);

        const databaseLists = server.logins
            .flatMap((login) => login.requests)
            .filter((sql) => sql.includes("database_id AS databaseId"));
        expect(databaseLists.length).toBeGreaterThan(0);
        expect(databaseLists.every((sql) => sql === serverQueries.databases)).toBe(true);
    });

    it("SQL Server (EngineEdition 3): autocompletion switches database through sp_executesql with @yast_statement", async () => {
        const server = await startServer(3);
        const connection = await connect(server);

        server.answer = (sql) =>
            sql.includes("sp_executesql @yast_statement")
                ? { columns: ["name"], rows: [["analyst"]] }
                : undefined;
        await expect(
            connection.listDefaultSchemas(POOL, new AbortController().signal),
        ).resolves.toEqual(["analyst", "dbo"]);

        const sent = server.logins.flatMap((login) => login.requests);
        expect(sent).toContain("EXEC [pool].sys.sp_executesql @yast_statement");
    });

    it("SQL Server (EngineEdition 3): Change Database runs USE on the session", async () => {
        const server = await startServer(3);
        const connection = await connect(server);
        const loginsBefore = server.logins.length;

        await connection.changeDatabase("pool2");

        expect(server.logins).toHaveLength(loginsBefore);
        expect(server.logins.flatMap((login) => login.requests)).toContain("USE [pool2]");
    });
});

describe("databaseBatch", () => {
    it("sends the text itself on a connection logged in to the database", () => {
        expect(databaseBatch("sales", "sales", "SELECT 1")).toEqual({
            text: "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\nSELECT 1",
        });
    });

    it("otherwise switches database with that database's sp_executesql and an input named @yast_statement", () => {
        expect(databaseBatch("my]db", "", "SELECT 1")).toEqual({
            text: "EXEC [my]]db].sys.sp_executesql @yast_statement",
            statement: "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\nSELECT 1",
        });
    });
});
