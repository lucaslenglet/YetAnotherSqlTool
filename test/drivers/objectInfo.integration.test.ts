import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import type { Driver, DriverConnection, ExecuteEvent } from "../../src/drivers/types";
import { pgOptions } from "../support/databases";
import { dockerOptions } from "./mssql/helpers";

interface Grid {
    columns: string[];
    rows: (string | null)[][];
}

interface Info {
    grids: Grid[];
    messages: { text: string; isError: boolean }[];
}

/** Collects what describeObject reports, in the shape the tests read. */
async function describe_(
    connection: DriverConnection,
    name: string | undefined,
    signal = new AbortController().signal,
): Promise<Info> {
    const events: ExecuteEvent[] = [];
    await connection.describeObject(name, (event) => events.push(event), signal);
    const info: Info = { grids: [], messages: [] };
    for (const event of events) {
        if (event.type === "resultSetStart") {
            info.grids.push({ columns: event.columns.map((c) => c.columnName), rows: [] });
        } else if (event.type === "rows") {
            info.grids[info.grids.length - 1].rows.push(
                ...event.rows.map((row) => row.map((c) => (c.isNull ? null : c.displayValue))),
            );
        } else if (event.type === "message") {
            info.messages.push({ text: event.text, isError: event.isError });
        }
    }
    return info;
}

/** The grid whose first column has this name. */
const grid = (info: Info, firstColumn: string): Grid => {
    const found = info.grids.find((g) => g.columns[0] === firstColumn);
    if (!found) {
        throw new Error(
            `No grid starting with ${firstColumn}: ${info.grids.map((g) => g.columns[0]).join(", ")}`,
        );
    }
    return found;
};

/** Rows of a grid as objects keyed by column name. */
const records = (g: Grid) =>
    g.rows.map((row) => Object.fromEntries(g.columns.map((c, i) => [c, row[i]])));

async function run(driver: Driver, connection: DriverConnection, script: string) {
    for (const batch of driver.splitBatches(script)) {
        await connection.execute(batch, () => undefined, new AbortController().signal);
    }
}

// ---------------------------------------------------------------------------

describe("describeObject on SQL Server", () => {
    let connection: DriverConnection;
    const runMssql = (script: string) => run(mssqlDriver, connection, script);
    beforeAll(async () => {
        connection = await mssqlDriver.connect({ options: dockerOptions() });
        await runMssql(`
IF OBJECT_ID('dbo.yast_oi_view') IS NOT NULL DROP VIEW dbo.yast_oi_view;
IF OBJECT_ID('dbo.yast_oi_proc') IS NOT NULL DROP PROCEDURE dbo.yast_oi_proc;
IF OBJECT_ID('dbo.yast_oi_child') IS NOT NULL DROP TABLE dbo.yast_oi_child;
IF OBJECT_ID('dbo.yast_oi_parent') IS NOT NULL DROP TABLE dbo.yast_oi_parent;
IF OBJECT_ID('dbo.[yast_oi_Mixed Case]') IS NOT NULL DROP TABLE dbo.[yast_oi_Mixed Case];
IF TYPE_ID('dbo.yast_oi_type') IS NOT NULL DROP TYPE dbo.yast_oi_type;
GO
CREATE TABLE dbo.yast_oi_parent (id INT NOT NULL PRIMARY KEY, label NVARCHAR(10) NULL);
CREATE TABLE dbo.yast_oi_child (
    id INT IDENTITY(5, 2) PRIMARY KEY,
    parent_id INT NULL CONSTRAINT fk_oi_child FOREIGN KEY REFERENCES dbo.yast_oi_parent(id) ON DELETE CASCADE,
    code VARCHAR(5) NOT NULL CONSTRAINT uq_oi_code UNIQUE,
    qty INT NOT NULL CONSTRAINT df_oi_qty DEFAULT 3 CONSTRAINT ck_oi_qty CHECK (qty > 0));
CREATE INDEX ix_oi_qty ON dbo.yast_oi_child (qty DESC);
CREATE TABLE dbo.[yast_oi_Mixed Case] (a INT);
GO
CREATE VIEW dbo.yast_oi_view WITH SCHEMABINDING AS SELECT id, qty FROM dbo.yast_oi_child;
GO
CREATE PROCEDURE dbo.yast_oi_proc @a INT, @b NVARCHAR(10) = N'x' OUTPUT AS SELECT 1;
GO
CREATE TYPE dbo.yast_oi_type FROM VARCHAR(20) NOT NULL;
`);
    });
    afterAll(async () => {
        await runMssql(`DROP VIEW dbo.yast_oi_view; DROP PROCEDURE dbo.yast_oi_proc;
DROP TABLE dbo.yast_oi_child; DROP TABLE dbo.yast_oi_parent; DROP TABLE dbo.[yast_oi_Mixed Case];
DROP TYPE dbo.yast_oi_type;`);
        await connection.close();
    });

    it("lists the objects of the database without a name", async () => {
        const info = await describe_(connection, undefined);
        const objects = records(grid(info, "Name"));
        expect(objects).toContainEqual({
            Name: "customers",
            Owner: "dbo",
            Object_type: "user table",
        });
        expect(objects).toContainEqual({ Name: "orders", Owner: "dbo", Object_type: "user table" });
        expect(grid(info, "User_type").rows.map((r) => r[0])).toContain("yast_oi_type");
    });

    it("describes a fixture table, schema-qualified or not", async () => {
        for (const name of ["customers", "dbo.customers", "[dbo].[customers]"]) {
            const info = await describe_(connection, name);
            expect(records(grid(info, "Name"))[0]).toMatchObject({
                Name: "customers",
                Owner: "dbo",
                Type: "user table",
            });
            expect(grid(info, "Column_name").rows.map((r) => [r[0], r[1]])).toEqual([
                ["id", "int"],
                ["name", "nvarchar"],
                ["email", "nvarchar"],
                ["created_at", "datetime2"],
            ]);
            expect(records(grid(info, "Identity"))[0]).toMatchObject({
                Identity: "id",
                Seed: "1",
                Increment: "1",
            });
        }
    });

    it("shows identity, indexes, constraints and references like sp_help", async () => {
        const child = await describe_(connection, "dbo.yast_oi_child");
        expect(records(grid(child, "Identity"))[0]).toMatchObject({
            Identity: "id",
            Seed: "5",
            Increment: "2",
        });
        const indexes = records(grid(child, "index_name"));
        expect(indexes.find((r) => r.index_name === "ix_oi_qty")).toMatchObject({
            index_keys: "qty(-)",
        });
        const constraints = records(grid(child, "constraint_type"));
        expect(constraints.map((r) => r.constraint_name)).toEqual(
            expect.arrayContaining(["ck_oi_qty", "df_oi_qty", "fk_oi_child", "uq_oi_code"]),
        );
        expect(constraints.find((r) => r.constraint_name === "fk_oi_child")).toMatchObject({
            constraint_type: "FOREIGN KEY",
            delete_action: "Cascade",
            constraint_keys: "parent_id",
        });

        const parent = await describe_(connection, "yast_oi_parent");
        expect(records(grid(parent, "Table is referenced by foreign key"))[0]).toMatchObject({
            "Table is referenced by foreign key": expect.stringMatching(
                /yast_oi_child: fk_oi_child$/,
            ),
        });
    });

    it("says 'No identity column defined.' for a table without one", async () => {
        const info = await describe_(connection, "dbo.yast_oi_parent");
        expect(records(grid(info, "Identity"))[0].Identity).toBe("No identity column defined.");
    });

    it("describes a view, a procedure and a type", async () => {
        const view = await describe_(connection, "yast_oi_view");
        expect(records(grid(view, "Name"))[0]).toMatchObject({
            Name: "yast_oi_view",
            Type: "view",
        });
        expect(grid(view, "Column_name").rows.map((r) => r[0])).toEqual(["id", "qty"]);

        const procedure = await describe_(connection, "[dbo].[yast_oi_proc]");
        expect(records(grid(procedure, "Name"))[0]).toMatchObject({ Type: "stored procedure" });
        expect(
            records(grid(procedure, "Parameter_name")).map((r) => [r.Parameter_name, r.Type]),
        ).toEqual([
            ["@a", "int"],
            ["@b", "nvarchar"],
        ]);

        const type = await describe_(connection, "yast_oi_type");
        expect(records(grid(type, "Type_name"))[0]).toMatchObject({
            Type_name: "yast_oi_type",
            Storage_type: "varchar",
            Nullable: "no",
        });
    });

    it("handles brackets and quotes in the name", async () => {
        const info = await describe_(connection, "[yast_oi_Mixed Case]");
        expect(records(grid(info, "Name"))[0].Name).toBe("yast_oi_Mixed Case");
        // A quote in the name must not break out of the string literal.
        const hostile = await describe_(connection, "x'; DROP TABLE dbo.customers; --");
        expect(hostile.grids).toEqual([]);
        expect(hostile.messages[0]).toMatchObject({ isError: true });
        expect((await describe_(connection, "customers")).grids.length).toBeGreaterThan(1);
    });

    it("reports an unknown object as sp_help's error message", async () => {
        const info = await describe_(connection, "no_such_object");
        expect(info.grids).toEqual([]);
        expect(info.messages).toHaveLength(1);
        expect(info.messages[0].isError).toBe(true);
        expect(info.messages[0].text).toMatch(/^Msg 15009, Level 16, State 1, Procedure sp_help/);
        expect(info.messages[0].text).toContain(
            "The object 'no_such_object' does not exist in database 'yast' or is invalid for this operation.",
        );
    });

    it("leaves the session as it was", async () => {
        await runMssql("SET LANGUAGE French");
        await describe_(connection, "customers");
        const events: ExecuteEvent[] = [];
        await connection.execute(
            { text: "SELECT @@LANGUAGE, DB_NAME()", startLine: 0 },
            (e) => events.push(e),
            new AbortController().signal,
        );
        const rows = events.flatMap((e) => (e.type === "rows" ? e.rows : []));
        expect(rows[0].map((c) => c.displayValue)).toEqual(["Français", "yast"]);
        await runMssql("SET LANGUAGE us_english");
    });

    it("stops when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const info = await describe_(connection, "customers", controller.signal);
        expect(info.grids).toEqual([]);
        expect(info.messages[0]).toMatchObject({
            text: "Query was canceled by user.",
            isError: true,
        });
    });
});

// ---------------------------------------------------------------------------

describe("describeObject on PostgreSQL", () => {
    let connection: DriverConnection;
    const runPg = (script: string) => run(pgDriver, connection, script);
    beforeAll(async () => {
        connection = await pgDriver.connect({ options: pgOptions() });
        await runPg(`
DROP SCHEMA IF EXISTS yast_oi CASCADE;
CREATE SCHEMA yast_oi;
CREATE TABLE yast_oi.parent (id int PRIMARY KEY, label text);
COMMENT ON TABLE yast_oi.parent IS 'the parent';
CREATE TABLE yast_oi.child (
    id int GENERATED ALWAYS AS IDENTITY (START WITH 5 INCREMENT BY 2) PRIMARY KEY,
    parent_id int CONSTRAINT fk_oi_child REFERENCES yast_oi.parent(id) ON DELETE CASCADE,
    code varchar(5) NOT NULL CONSTRAINT uq_oi_code UNIQUE,
    qty int NOT NULL DEFAULT 3 CONSTRAINT ck_oi_qty CHECK (qty > 0),
    double_qty int GENERATED ALWAYS AS (qty * 2) STORED);
CREATE INDEX ix_oi_qty ON yast_oi.child (qty DESC, lower(code));
CREATE TABLE yast_oi.serial_table (id serial PRIMARY KEY);
CREATE TABLE yast_oi."Mixed Case" (a int);
CREATE VIEW yast_oi.child_view AS SELECT id, qty FROM yast_oi.child;
CREATE MATERIALIZED VIEW yast_oi.child_matview AS SELECT id FROM yast_oi.child;
CREATE FUNCTION yast_oi.add(a int, b int DEFAULT 1) RETURNS int LANGUAGE sql AS 'SELECT a + b';
CREATE FUNCTION yast_oi.add(a text) RETURNS text LANGUAGE sql AS 'SELECT a';
CREATE PROCEDURE yast_oi.do_it(INOUT x int, IN y text) LANGUAGE plpgsql AS 'BEGIN END';
CREATE DOMAIN yast_oi.positive AS int NOT NULL DEFAULT 1 CONSTRAINT positive_check CHECK (VALUE > 0);
CREATE TYPE yast_oi.mood AS ENUM ('sad', 'ok', 'happy');
CREATE TYPE yast_oi.pair AS (first int, second text);
CREATE SEQUENCE yast_oi.counter START 10 INCREMENT 5 MAXVALUE 1000;
`);
    });
    afterAll(async () => {
        await runPg("DROP SCHEMA IF EXISTS yast_oi CASCADE");
        await connection.close();
    });

    const useSchema = () => runPg("SET search_path TO yast_oi, public");

    it("lists the objects outside the system schemas, then the user-defined types", async () => {
        const info = await describe_(connection, undefined);
        expect(info.grids.map((g) => g.columns)).toEqual([
            ["Schema", "Name", "Owner", "Object_type"],
            ["Schema", "Type_name", "Owner", "Kind", "Base_type"],
        ]);
        const objects = records(info.grids[0]);
        expect(objects).toContainEqual(
            expect.objectContaining({ Schema: "public", Name: "customers", Object_type: "table" }),
        );
        expect(objects).toContainEqual(
            expect.objectContaining({ Schema: "yast_oi", Name: "child_view", Object_type: "view" }),
        );
        expect(objects).toContainEqual(
            expect.objectContaining({
                Schema: "yast_oi",
                Name: "counter",
                Object_type: "sequence",
            }),
        );
        expect(objects).toContainEqual(
            expect.objectContaining({ Name: "do_it", Object_type: "procedure" }),
        );
        expect(objects.every((o) => o.Schema !== "pg_catalog")).toBe(true);
        expect(records(info.grids[1])).toContainEqual(
            expect.objectContaining({
                Schema: "yast_oi",
                Type_name: "positive",
                Kind: "domain",
                Base_type: "integer",
            }),
        );
        expect(records(info.grids[1])).toContainEqual(
            expect.objectContaining({ Type_name: "mood", Kind: "enum" }),
        );
    });

    it("describes a fixture table in the same order of topics as sp_help", async () => {
        const info = await describe_(connection, "customers");
        expect(info.grids.map((g) => g.columns[0])).toEqual([
            "Schema",
            "Column_name",
            "Identity",
            "index_name",
            "constraint_type",
            "Table is referenced by foreign key",
        ]);
        expect(records(info.grids[0])[0]).toMatchObject({
            Schema: "public",
            Name: "customers",
            Type: "table",
        });
        expect(
            records(grid(info, "Column_name")).map((r) => [r.Column_name, r.Type, r.Nullable]),
        ).toEqual([
            ["id", "integer", "no"],
            ["name", "character varying(100)", "no"],
            ["email", "character varying(255)", "no"],
            ["created_at", "timestamp without time zone", "no"],
        ]);
        expect(records(grid(info, "Column_name"))[0].Default).toMatch(/^nextval\(/);
        expect(records(grid(info, "Identity"))[0]).toMatchObject({
            Identity: "id",
            Generation: "serial",
            Seed: "1",
            Increment: "1",
        });
        expect(
            records(grid(info, "index_name")).map((r) => [
                r.index_name,
                r.index_description,
                r.index_keys,
            ]),
        ).toEqual([
            ["customers_email_key", "btree, unique key", "email"],
            ["customers_pkey", "btree, unique, primary key", "id"],
        ]);
        expect(
            records(grid(info, "constraint_type")).map((r) => [
                r.constraint_type,
                r.constraint_name,
                r.constraint_keys,
            ]),
        ).toEqual([
            ["PRIMARY KEY", "customers_pkey", "id"],
            ["UNIQUE", "customers_email_key", "email"],
        ]);
        expect(grid(info, "Table is referenced by foreign key").rows).toEqual([
            ["public.orders: orders_customer_id_fkey"],
        ]);
        expect(info.messages).toEqual([
            { text: "No views reference table 'customers'.", isError: false },
        ]);
    });

    it("describes a table with identity, indexes, constraints and dependents", async () => {
        const child = await describe_(connection, "yast_oi.child");
        expect(records(child.grids[0])[0]).toMatchObject({
            Schema: "yast_oi",
            Name: "child",
            Type: "table",
        });
        const columns = records(grid(child, "Column_name"));
        expect(columns.find((c) => c.Column_name === "double_qty")).toMatchObject({
            Computed: "yes",
            Default: "(qty * 2)",
        });
        expect(columns.find((c) => c.Column_name === "qty")).toMatchObject({
            Computed: "no",
            Default: "3",
            Nullable: "no",
        });
        expect(columns.find((c) => c.Column_name === "code")).toMatchObject({
            Type: "character varying(5)",
            Collation: "default",
        });
        expect(records(grid(child, "Identity"))).toEqual([
            {
                Identity: "id",
                Generation: "ALWAYS",
                Seed: "5",
                Increment: "2",
                Sequence: expect.stringContaining("child_id_seq"),
            },
        ]);
        expect(
            records(grid(child, "index_name")).find((r) => r.index_name === "ix_oi_qty"),
        ).toMatchObject({
            index_description: "btree",
            index_keys: "qty(-), lower(code::text)",
        });
        const constraints = records(grid(child, "constraint_type"));
        expect(constraints.map((r) => r.constraint_name)).toEqual([
            "child_pkey",
            "uq_oi_code",
            "fk_oi_child",
            "",
            "ck_oi_qty",
        ]);
        expect(constraints[2]).toMatchObject({
            constraint_type: "FOREIGN KEY",
            delete_action: "Cascade",
            update_action: "No Action",
            status_validated: "Validated",
            constraint_keys: "parent_id",
        });
        expect(constraints[3].constraint_keys).toBe("REFERENCES yast_oi.parent (id)");
        expect(constraints[4]).toMatchObject({
            constraint_type: "CHECK on column qty",
            constraint_keys: "(qty > 0)",
        });
        // child has no dependents but a view and a materialized view read it.
        expect(info_messages(child)).toContain(
            "No foreign keys reference table 'yast_oi.child', or you do not have permissions on referencing tables.",
        );
        expect(grid(child, "Table is referenced by views").rows).toEqual([
            ["yast_oi.child_matview"],
            ["yast_oi.child_view"],
        ]);

        const parent = await describe_(connection, "yast_oi.parent");
        expect(records(parent.grids[0])[0].Comment).toBe("the parent");
        expect(records(grid(parent, "Identity"))[0]).toEqual({
            Identity: "No identity column defined.",
            Generation: null,
            Seed: null,
            Increment: null,
            Sequence: null,
        });
        expect(grid(parent, "Table is referenced by foreign key").rows).toEqual([
            ["yast_oi.child: fk_oi_child"],
        ]);
    });

    it("says so when a table has no indexes or constraints", async () => {
        const info = await describe_(connection, 'yast_oi."Mixed Case"');
        expect(records(info.grids[0])[0].Name).toBe("Mixed Case");
        expect(info_messages(info)).toEqual([
            "The object 'yast_oi.\"Mixed Case\"' does not have any indexes, or you do not have permissions.",
            "No constraints are defined on object 'yast_oi.\"Mixed Case\"', or you do not have permissions.",
            "No foreign keys reference table 'yast_oi.\"Mixed Case\"', or you do not have permissions on referencing tables.",
            "No views reference table 'yast_oi.\"Mixed Case\"'.",
        ]);
    });

    it("recognizes serial columns as identity", async () => {
        const info = await describe_(connection, "yast_oi.serial_table");
        expect(records(grid(info, "Identity"))[0]).toMatchObject({
            Identity: "id",
            Generation: "serial",
        });
    });

    it("describes views and materialized views", async () => {
        const view = await describe_(connection, "yast_oi.child_view");
        expect(view.grids.map((g) => g.columns[0])).toEqual(["Schema", "Column_name"]);
        expect(records(view.grids[0])[0]).toMatchObject({ Type: "view" });
        expect(grid(view, "Column_name").rows.map((r) => r[0])).toEqual(["id", "qty"]);

        const matview = await describe_(connection, "yast_oi.child_matview");
        expect(records(matview.grids[0])[0]).toMatchObject({ Type: "materialized view" });
        expect(grid(matview, "Column_name").rows.map((r) => r[0])).toEqual(["id"]);
    });

    it("lists every overload of a function, with its parameters", async () => {
        const info = await describe_(connection, "yast_oi.add");
        expect(
            records(info.grids[0]).map((r) => [r.Type, r.Arguments, r.Returns, r.Language]),
        ).toEqual([
            ["function", "a integer, b integer", "integer", "sql"],
            ["function", "a text", "text", "sql"],
        ]);
        expect(
            records(grid(info, "Arguments")).map((r) => [
                r.Arguments,
                r.Parameter_name,
                r.Type,
                r.Mode,
                r.Param_order,
            ]),
        ).toEqual([
            ["a integer, b integer", "", "integer", "RETURN", "0"],
            ["a integer, b integer", "a", "integer", "IN", "1"],
            ["a integer, b integer", "b", "integer", "IN", "2"],
            ["a text", "", "text", "RETURN", "0"],
            ["a text", "a", "text", "IN", "1"],
        ]);
        // An argument list in the selection is ignored.
        expect((await describe_(connection, "yast_oi.add(int, int)")).grids[0].rows).toHaveLength(
            2,
        );
    });

    it("describes a procedure, found through search_path", async () => {
        await useSchema();
        try {
            const info = await describe_(connection, "do_it");
            expect(records(info.grids[0])[0]).toMatchObject({
                Schema: "yast_oi",
                Name: "do_it",
                Type: "procedure",
                Returns: null,
            });
            expect(
                records(grid(info, "Arguments")).map((r) => [r.Parameter_name, r.Type, r.Mode]),
            ).toEqual([
                ["x", "integer", "INOUT"],
                ["y", "text", "IN"],
            ]);
        } finally {
            await runPg("RESET search_path");
        }
    });

    it("describes domains, enums, composite types and sequences", async () => {
        const domain = await describe_(connection, "yast_oi.positive");
        expect(records(domain.grids[0])[0]).toMatchObject({ Name: "positive", Type: "domain" });
        expect(records(grid(domain, "Base_type"))[0]).toMatchObject({
            Base_type: "integer",
            Nullable: "no",
            Default: "1",
        });
        expect(records(grid(domain, "constraint_name"))[0]).toMatchObject({
            constraint_name: "positive_check",
            constraint_definition: "CHECK ((VALUE > 0))",
        });

        const mood = await describe_(connection, "yast_oi.mood");
        expect(records(mood.grids[0])[0]).toMatchObject({ Type: "enum type" });
        expect(grid(mood, "Label_order").rows.map((r) => r[1])).toEqual(["sad", "ok", "happy"]);

        const pair = await describe_(connection, "yast_oi.pair");
        expect(records(pair.grids[0])[0]).toMatchObject({ Type: "composite type" });
        expect(grid(pair, "Column_name").rows.map((r) => [r[0], r[1]])).toEqual([
            ["first", "integer"],
            ["second", "text"],
        ]);

        const counter = await describe_(connection, "yast_oi.counter");
        expect(records(counter.grids[0])[0]).toMatchObject({ Type: "sequence" });
        expect(records(grid(counter, "Data_type"))[0]).toMatchObject({
            Data_type: "bigint",
            Start_value: "10",
            Increment: "5",
            Maximum_value: "1000",
            Cycle: "no",
        });

        const builtin = await describe_(connection, "integer");
        expect(records(builtin.grids[0])[0]).toMatchObject({
            Schema: "pg_catalog",
            Name: "int4",
            Type: "base type",
        });
    });

    it("describes an index", async () => {
        const info = await describe_(connection, "yast_oi.ix_oi_qty");
        expect(records(info.grids[0])[0]).toMatchObject({ Type: "index" });
        expect(grid(info, "index_name").rows).toHaveLength(1);
    });

    it("reports an unknown or malformed name as an error message", async () => {
        for (const name of [
            "no_such_object",
            "yast_oi.",
            "a.b.c.d",
            "other_db.public.customers",
            "1abc",
            "x; DROP TABLE customers",
        ]) {
            const info = await describe_(connection, name);
            expect(info.grids).toEqual([]);
            expect(info.messages).toEqual([
                {
                    text: expect.stringContaining(
                        `The object '${name}' does not exist in database '${pgOptions().database}' or is invalid for this operation.`,
                    ),
                    isError: true,
                },
            ]);
        }
        // database.schema.name works for the current database.
        const qualified = await describe_(connection, `${pgOptions().database}.public.customers`);
        expect(records(qualified.grids[0])[0].Name).toBe("customers");
    });

    it("changes nothing in the session, even inside a transaction", async () => {
        await runPg("SET search_path TO yast_oi; BEGIN");
        try {
            await describe_(connection, "child");
            await describe_(connection, "no_such_object");
            await describe_(connection, undefined);
            const events: ExecuteEvent[] = [];
            await connection.execute(
                {
                    text: "SELECT current_setting('search_path'), txid_current_if_assigned() IS NULL, now() = statement_timestamp()",
                    startLine: 0,
                },
                (e) => events.push(e),
                new AbortController().signal,
            );
            const row = events.flatMap((e) => (e.type === "rows" ? e.rows : []))[0];
            expect(row[0].displayValue).toBe("yast_oi");
            // Still inside the transaction opened above: now() stays at its start.
            expect(row[2].displayValue).toBe("false");
        } finally {
            await runPg("ROLLBACK; RESET search_path");
        }
    });

    it("stops when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const info = await describe_(connection, "customers", controller.signal);
        expect(info.grids).toEqual([]);
        expect(info.messages[0]).toMatchObject({
            text: "Query was canceled by user.",
            isError: true,
        });
    });
});

function info_messages(info: Info): string[] {
    return info.messages.map((m) => m.text);
}
