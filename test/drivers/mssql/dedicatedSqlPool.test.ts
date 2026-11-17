import { afterEach, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { databaseBatch } from "../../../src/drivers/mssql/connection";
import { serverQueries } from "../../../src/drivers/mssql/objectExplorerQueries";
import type { DriverConnection, ObjectNode } from "../../../src/drivers/types";
import {
    FakeTdsServer,
    type FakeResultSet,
    type FakeServerError,
} from "../../support/fakeTdsServer";

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
    // A table value constructor as a derived table: the parse error reported in issue #43. The
    // number is the one forum reports give for Synapse's "Parse error at line: ..., column: ...";
    // Microsoft does not document it.
    const constructor = /(?:\bFROM|\bJOIN|\bAPPLY|,)\s*\(\s*VALUES\b/i.exec(sql);
    if (constructor) {
        const before = sql.slice(0, constructor.index + constructor[0].indexOf("("));
        const line = before.split("\n").length;
        const column = before.length - before.lastIndexOf("\n");
        return error(
            103010,
            `Parse error at line: ${line}, column: ${column}: Incorrect syntax near '('.`,
        );
    }
    return undefined;
}

/** Rows for the columns query: relation 0 has id and name, relation 2 has id; 1 and 3 have none. */
function columnRows(sql: string): FakeResultSet | undefined {
    if (!sql.includes("sys.all_columns")) return undefined;
    const row = (idx: number, columnId: number, name: string, typeName: string, maxLength = 4) => [
        idx,
        columnId,
        name,
        idx === 2 ? 0 : 1,
        typeName,
        null,
        0,
        maxLength,
        0,
        0,
    ];
    return {
        columns: [
            "idx:int",
            "columnId:int",
            "name",
            "isNullable:int",
            "typeName",
            "baseTypeName",
            "isAliasType:int",
            "maxLength:int",
            "precision:int",
            "scale:int",
        ],
        // Out of order on purpose: a pool query has no ORDER BY.
        rows: [row(2, 1, "id", "int"), row(0, 2, "name", "nvarchar", 200), row(0, 1, "id", "int")],
    };
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

    it("reads the columns of relations without a table value constructor, and maps the rows to the relations asked", async () => {
        const server = await startServer(6);
        const connection = await connect(server);

        server.answer = (sql) => poolRejection(sql) ?? columnRows(sql);

        // Index 1 has no row (unknown relation); index 2 asks index 0's relation again.
        const columns = await connection.listCompletionColumns(
            POOL,
            [
                { schema: "dbo", name: "fact_sales" },
                { schema: "dbo", name: "nope" },
                { schema: "dbo", name: "fact_sales" },
                { schema: "we]ird", name: "it's.here" },
            ],
            new AbortController().signal,
        );

        expect(columns).toEqual([
            [
                { name: "id", dataType: "int", nullable: true },
                { name: "name", dataType: "nvarchar(100)", nullable: true },
            ],
            [],
            [{ name: "id", dataType: "int", nullable: false }],
            [],
        ]);
        const sent = server.logins
            .filter((login) => login.database === POOL)
            .flatMap((login) => login.requests)
            .filter((sql) => sql.includes("sys.all_columns"));
        expect(sent).toHaveLength(1);
        const [query] = sent;
        // Sent on the pool's own connection, one batch: one SELECT per relation joined by UNION ALL.
        expect(query).toMatch(/^SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n/);
        expect(query).not.toContain("sp_executesql");
        expect(query.match(/\bUNION ALL\b/g)).toHaveLength(3);
        expect(query).toContain("SELECT 0 AS idx, c.column_id AS columnId");
        expect(query).toContain("SELECT 3 AS idx, c.column_id AS columnId");
        expect(query).toContain("WHERE s.name = N'dbo' AND o.name = N'nope'");
        expect(query).toContain("WHERE s.name = N'we]ird' AND o.name = N'it''s.here'");
        // Catalog views joined on columns, no derived table: nothing that a pool is known to reject.
        for (const unsupported of [
            /VALUES/i,
            /\bAPPLY\b/i,
            /synonyms/i,
            /OBJECT_ID\(/i,
            /ORDER BY/i,
            /\(\s*SELECT/i,
        ]) {
            expect(query).not.toMatch(unsupported);
        }
    });

    it("refuses a table value constructor as a derived table, like a real pool", () => {
        expect(poolRejection("SELECT 1\nFROM (VALUES (0, N'a')) AS r(idx, n)")).toEqual({
            number: 103010,
            error: "Parse error at line: 2, column: 6: Incorrect syntax near '('.",
        });
        expect(poolRejection("SELECT 1 FROM (SELECT 0 AS idx UNION ALL SELECT 1) AS r")).toBe(
            undefined,
        );
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

    it("Azure SQL Database (EngineEdition 5): columns keep the query that follows synonyms", async () => {
        const server = await startServer(5);
        const connection = await connect(server);
        server.answer = columnRows;

        await connection.listCompletionColumns(
            POOL,
            [
                { schema: "dbo", name: "fact_sales" },
                { schema: "dbo", name: "nope" },
                { schema: "dbo", name: "fact_sales" },
            ],
            new AbortController().signal,
        );

        const query = server.logins
            .filter((login) => login.database === POOL)
            .flatMap((login) => login.requests)
            .find((sql) => sql.includes("sys.all_columns"));
        expect(query).toContain(
            "FROM (VALUES (0, N'[dbo].[fact_sales]'), (1, N'[dbo].[nope]'), (2, N'[dbo].[fact_sales]')) AS r(idx, objectName)",
        );
        expect(query).toContain("FROM sys.synonyms s");
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
