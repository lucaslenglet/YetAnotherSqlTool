import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDriver } from "../../src/drivers/pg";
import type { DriverConnection, ObjectNode } from "../../src/drivers/types";
import { pgOptions, pgServer } from "../support/databases";

const S = `yast_sc_${randomBytes(4).toString("hex")}`;
const ODD_SCHEMA = `Odd "Schema" ${S}`;
/** Escaped for use inside "...". */
const ODD = ODD_SCHEMA.replace(/"/g, '""');

const SETUP = `
CREATE SCHEMA ${S};
CREATE SCHEMA "${ODD}";
CREATE TABLE ${S}.plain (id int PRIMARY KEY, name text);
INSERT INTO ${S}.plain VALUES (1, 'a'), (2, 'b');
CREATE TABLE "${ODD}"."Odd ""Table" ("Col A" int, "select" int, lower_col int);
INSERT INTO "${ODD}"."Odd ""Table" VALUES (7, 8, 9);
CREATE TABLE ${S}.no_columns ();
INSERT INTO ${S}.no_columns DEFAULT VALUES;
CREATE TABLE ${S}.dropped (a int, b int, c int);
ALTER TABLE ${S}.dropped DROP COLUMN b;
INSERT INTO ${S}.dropped VALUES (1, 3);
CREATE TABLE ${S}.parted (id int, d date) PARTITION BY RANGE (d);
CREATE TABLE ${S}.parted_2024 PARTITION OF ${S}.parted FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
INSERT INTO ${S}.parted VALUES (1, '2024-05-05');
CREATE VIEW ${S}.v AS SELECT id, name FROM ${S}.plain;
CREATE MATERIALIZED VIEW ${S}.mv AS SELECT id FROM ${S}.plain;
`;

describe("scriptObject (PostgreSQL)", () => {
    let connection: DriverConnection;
    const server = pgServer();

    async function walk(conn: DriverConnection, ...labels: string[]): Promise<ObjectNode> {
        let node = conn.getRootNode();
        for (const label of labels) {
            const found = (await conn.expandNode(node)).find((c) => c.label === label);
            if (!found) throw new Error(`"${label}" not found under "${node.label}"`);
            node = found;
        }
        return node;
    }

    const find = (conn: DriverConnection, schema: string, folder: string, name: string) =>
        walk(conn, "Databases", "yast", "Schemas", schema, folder, name);

    async function rowsOf(script: string): Promise<string[][]> {
        const rows: string[][] = [];
        for (const batch of pgDriver.splitBatches(script)) {
            await connection.execute(
                batch,
                (event) => {
                    if (event.type === "message") expect(event.isError).toBe(false);
                    if (event.type === "rows")
                        rows.push(...event.rows.map((r) => r.map((c) => c.displayValue)));
                },
                new AbortController().signal,
            );
        }
        return rows;
    }

    async function run(script: string) {
        for (const batch of pgDriver.splitBatches(script)) {
            await connection.execute(batch, () => undefined, new AbortController().signal);
        }
    }

    beforeAll(async () => {
        connection = await pgDriver.connect({ options: pgOptions() });
        await run(SETUP);
    });
    afterAll(async () => {
        await run(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS "${ODD}" CASCADE`);
        await connection.close();
    });

    it("is reachable from the server root", () => {
        expect(connection.getRootNode().nodePath).toBe(server);
    });

    it("scripts a table and the script returns its rows", async () => {
        const script = await connection.scriptObject(
            await find(connection, S, "Tables", "plain"),
            "select",
        );
        expect(script).toBe(`SELECT id\n      ,name\n  FROM ${S}.plain\n  LIMIT 1000`);
        expect(await rowsOf(script)).toEqual([
            ["1", "a"],
            ["2", "b"],
        ]);
    });

    it("scripts a view and a materialized view", async () => {
        const view = await connection.scriptObject(
            await find(connection, S, "Views", "v"),
            "select",
        );
        expect(view).toBe(`SELECT id\n      ,name\n  FROM ${S}.v\n  LIMIT 1000`);
        expect(await rowsOf(view)).toHaveLength(2);
        const materialized = await connection.scriptObject(
            await find(connection, S, "Materialized Views", "mv"),
            "select",
        );
        expect(materialized).toBe(`SELECT id\n  FROM ${S}.mv\n  LIMIT 1000`);
        expect(await rowsOf(materialized)).toEqual([["1"], ["2"]]);
    });

    it("scripts a partitioned table", async () => {
        const script = await connection.scriptObject(
            await find(connection, S, "Tables", "parted"),
            "select",
        );
        expect(script).toBe(`SELECT id\n      ,d\n  FROM ${S}.parted\n  LIMIT 1000`);
        expect(await rowsOf(script)).toHaveLength(1);
    });

    it("quotes only what PostgreSQL requires", async () => {
        const script = await connection.scriptObject(
            await find(connection, ODD_SCHEMA, "Tables", 'Odd "Table'),
            "select",
        );
        expect(script).toBe(
            `SELECT "Col A"\n      ,"select"\n      ,lower_col\n  FROM "${ODD}"."Odd ""Table"\n  LIMIT 1000`,
        );
        expect(await rowsOf(script)).toEqual([["7", "8", "9"]]);
    });

    it("selects * from a table without columns", async () => {
        const script = await connection.scriptObject(
            await find(connection, S, "Tables", "no_columns"),
            "select",
        );
        expect(script).toBe(`SELECT *\n  FROM ${S}.no_columns\n  LIMIT 1000`);
        await rowsOf(script);
    });

    it("leaves dropped columns out", async () => {
        const script = await connection.scriptObject(
            await find(connection, S, "Tables", "dropped"),
            "select",
        );
        expect(script).toBe(`SELECT a\n      ,c\n  FROM ${S}.dropped\n  LIMIT 1000`);
        expect(await rowsOf(script)).toEqual([["1", "3"]]);
    });

    it("does not change the session database", async () => {
        const other = await pgDriver.connect({ options: pgOptions({ database: "postgres" }) });
        try {
            const node = await find(other, S, "Tables", "plain");
            await other.scriptObject(node, "select");
            expect(await other.getCurrentDatabase()).toBe("postgres");
        } finally {
            await other.close();
        }
    });

    it("rejects unsupported operations and nodes that are not relations", async () => {
        const node = await find(connection, S, "Tables", "plain");
        for (const operation of ["alter", "execute"] as const) {
            await expect(connection.scriptObject(node, operation)).rejects.toThrow(/not supported/);
        }
        await expect(
            connection.scriptObject({ ...node, nodeType: "Folder" }, "select"),
        ).rejects.toThrow(/Cannot script/);
    });
});
