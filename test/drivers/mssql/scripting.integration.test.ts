import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriverConnection, ObjectNode } from "../../../src/drivers/types";
import { connectToDocker, runBatch, runScript } from "./helpers";

// The objects live in a database of their own: DDL in the yast database, while the Object Explorer
// tests read its catalog in parallel, causes deadlocks. The "yast_oe_" prefix keeps the database
// out of the Object Explorer comparison with the reference.
const DB = `yast_oe_sc_${randomBytes(4).toString("hex")}`;
const S = "sc";
const ODD_SCHEMA = `${S} we]ird`;
/** Escaped for use inside [...]. */
const ODD = ODD_SCHEMA.replace(/]/g, "]]");

const SETUP = `
CREATE DATABASE [${DB}];
GO
USE [${DB}];
GO
CREATE SCHEMA [${S}];
GO
CREATE SCHEMA [${ODD}];
GO
CREATE TABLE [${S}].plain (id int NOT NULL PRIMARY KEY, name nvarchar(50) NULL);
INSERT INTO [${S}].plain VALUES (1, N'a'), (2, N'b');
CREATE TABLE [${ODD}].[odd ]] table] ([col ]] one] int, [Mixed Case] int);
INSERT INTO [${ODD}].[odd ]] table] VALUES (7, 8);
CREATE TABLE [${S}].special (
    id int NOT NULL,
    version rowversion,
    doubled AS (id * 2),
    area geography NULL
);
INSERT INTO [${S}].special (id) VALUES (5);
CREATE TABLE [${S}].temporal (
    id int NOT NULL PRIMARY KEY,
    v int NULL,
    valid_from datetime2 GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    valid_to datetime2 GENERATED ALWAYS AS ROW END HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (valid_from, valid_to)
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = [${S}].temporal_history));
INSERT INTO [${S}].temporal (id, v) VALUES (1, 10);
CREATE TABLE [${S}].temporal_visible (
    id int NOT NULL PRIMARY KEY,
    v int NULL,
    valid_from datetime2 GENERATED ALWAYS AS ROW START NOT NULL,
    valid_to datetime2 GENERATED ALWAYS AS ROW END NOT NULL,
    PERIOD FOR SYSTEM_TIME (valid_from, valid_to)
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = [${S}].temporal_visible_history));
GO
CREATE VIEW [${S}].v AS SELECT id, name FROM [${S}].plain;
`;

const CLEANUP = `
USE master;
ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
DROP DATABASE [${DB}];
`;

describe("scriptObject (SQL Server)", () => {
    let connection: DriverConnection;

    /** Table or view node of the test database, found by walking the tree of `conn`. */
    async function find(
        conn: DriverConnection,
        folder: "Tables" | "Views",
        label: string,
    ): Promise<ObjectNode> {
        let node = conn.getRootNode();
        for (const segment of ["Databases", DB, folder]) {
            const children = await conn.expandNode(node);
            const next = children.find((c) => c.nodePath === `${node.nodePath}/${segment}`);
            if (!next) throw new Error(`No node ${segment} under ${node.nodePath}`);
            node = next;
        }
        const found = (await conn.expandNode(node)).find((n) => n.label === label);
        if (!found) throw new Error(`No node ${label} under ${folder}`);
        return found;
    }

    /** Rows of a script as displayed text, run on the session. */
    async function rowsOf(script: string): Promise<string[][]> {
        const events = await runBatch(connection, script);
        expect(events.filter((e) => e.type === "message" && e.isError)).toEqual([]);
        return events.flatMap((e) =>
            e.type === "rows" ? e.rows.map((r) => r.map((c) => c.displayValue)) : [],
        );
    }

    beforeAll(async () => {
        connection = await connectToDocker();
        await runScript(connection, SETUP);
    });
    afterAll(async () => {
        await runScript(connection, CLEANUP);
        await connection.close();
    });

    it("scripts a table and the script returns its rows", async () => {
        const script = await connection.scriptObject(
            await find(connection, "Tables", `${S}.plain`),
            "select",
        );
        expect(script).toBe(`SELECT TOP (1000) [id]\n      ,[name]\n  FROM [${DB}].[${S}].[plain]`);
        expect(await rowsOf(script)).toEqual([
            ["1", "a"],
            ["2", "b"],
        ]);
    });

    it("scripts a view", async () => {
        const script = await connection.scriptObject(
            await find(connection, "Views", `${S}.v`),
            "select",
        );
        expect(script).toBe(`SELECT TOP (1000) [id]\n      ,[name]\n  FROM [${DB}].[${S}].[v]`);
        expect(await rowsOf(script)).toHaveLength(2);
    });

    it("quotes schemas, tables and columns that need it", async () => {
        const script = await connection.scriptObject(
            await find(connection, "Tables", `${ODD_SCHEMA}.odd ] table`),
            "select",
        );
        expect(script).toBe(
            `SELECT TOP (1000) [col ]] one]\n      ,[Mixed Case]\n  FROM [${DB}].[${ODD}].[odd ]] table]`,
        );
        expect(await rowsOf(script)).toEqual([["7", "8"]]);
    });

    it("keeps rowversion, computed and spatial columns", async () => {
        const script = await connection.scriptObject(
            await find(connection, "Tables", `${S}.special`),
            "select",
        );
        expect(script).toContain("[version]");
        expect(script).toContain("[doubled]");
        expect(script).toContain("[area]");
        expect(await rowsOf(script)).toHaveLength(1);
    });

    it("leaves the period columns of a temporal table out, hidden or not", async () => {
        const node = await find(connection, "Tables", `${S}.temporal`);
        expect(node.nodeSubType).toBe("Temporal");
        const script = await connection.scriptObject(node, "select");
        expect(script).toBe(`SELECT TOP (1000) [id]\n      ,[v]\n  FROM [${DB}].[${S}].[temporal]`);
        expect(await rowsOf(script)).toEqual([["1", "10"]]);
        // sqltoolsservice also leaves out period columns that are not hidden.
        const visible = await connection.scriptObject(
            await find(connection, "Tables", `${S}.temporal_visible`),
            "select",
        );
        expect(visible).toBe(
            `SELECT TOP (1000) [id]\n      ,[v]\n  FROM [${DB}].[${S}].[temporal_visible]`,
        );
    });

    it("does not change the session database", async () => {
        const other = await connectToDocker({ database: "master" });
        try {
            const node = await find(other, "Tables", `${S}.plain`);
            await other.scriptObject(node, "select");
            expect(await other.getCurrentDatabase()).toBe("master");
        } finally {
            await other.close();
        }
    });

    it("rejects unsupported operations and nodes that are not relations", async () => {
        const node = await find(connection, "Tables", `${S}.plain`);
        for (const operation of ["alter", "execute"] as const) {
            await expect(connection.scriptObject(node, operation)).rejects.toThrow(/not supported/);
        }
        await expect(
            connection.scriptObject({ ...node, nodeType: "Folder" }, "select"),
        ).rejects.toThrow(/Cannot script/);
    });
});
