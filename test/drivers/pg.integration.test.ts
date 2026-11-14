import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDriver } from "../../src/drivers/pg";
import { buildConnectionString } from "../../src/drivers/pg/connectionString";
import type {
    CellValue,
    DriverConnection,
    ExecuteEvent,
    ObjectNode,
} from "../../src/drivers/types";
import { pgOptions, pgServer } from "../support/databases";

const options = pgOptions();
/** Root of the Object Explorer paths: "host:port". */
const server = pgServer();
const TREE_SCHEMA = "yast_pgtest_tree";

let connection: DriverConnection;

beforeAll(async () => {
    connection = await pgDriver.connect({ options });
});

afterAll(async () => {
    await run(`DROP SCHEMA IF EXISTS ${TREE_SCHEMA} CASCADE`);
    await connection.close();
});

async function run(script: string, signal = new AbortController().signal): Promise<ExecuteEvent[]> {
    const events: ExecuteEvent[] = [];
    for (const batch of pgDriver.splitBatches(script)) {
        await connection.execute(batch, (event) => events.push(event), signal);
    }
    return events;
}

const messages = (events: ExecuteEvent[]) =>
    events.flatMap((e) => (e.type === "message" ? [e] : []));

/** Runs a one-row query and returns the displayed text of each cell. */
async function singleRow(sql: string): Promise<CellValue[]> {
    const events = await run(sql);
    const rows = events.flatMap((e) => (e.type === "rows" ? e.rows : []));
    expect(messages(events).filter((m) => m.isError)).toEqual([]);
    expect(rows).toHaveLength(1);
    return rows[0];
}

async function expandPath(...labels: string[]): Promise<ObjectNode> {
    // Paths start with the server label, which is the root node itself.
    let node = connection.getRootNode();
    for (const label of labels.slice(1)) {
        const children = await connection.expandNode(node);
        const found = children.find((c) => c.label === label);
        if (!found)
            throw new Error(
                `"${label}" not found under "${node.label}": ${children.map((c) => c.label).join(" | ")}`,
            );
        node = found;
    }
    return node;
}

async function labelsUnder(...path: string[]): Promise<string[]> {
    const node = await expandPath(...path);
    return (await connection.expandNode(node)).map((c) => c.label);
}

describe("connection", () => {
    it("reads server info", () => {
        expect(connection.serverInfo.productName).toBe("PostgreSQL");
        expect(connection.serverInfo.serverVersion).toMatch(/^17\./);
        expect(connection.serverInfo.userName).toBe("yast");
        expect(connection.serverInfo.isCloud).toBe(false);
        expect(connection.getRootNode().label).toMatch(
            new RegExp(`^${server} \\(PostgreSQL 17\\.[^ ]+ - yast\\)$`),
        );
        expect(connection.getRootNode().nodePath).toBe(server);
    });

    it("rejects with a readable message", async () => {
        await expect(
            pgDriver.connect({ options: { ...options, password: "wrong" } }),
        ).rejects.toThrow(/password authentication failed/);
        await expect(pgDriver.connect({ options: { ...options, port: 1 } })).rejects.toThrow(
            /connection refused/,
        );
        await expect(pgDriver.connect({ options: { ...options, server: "" } })).rejects.toThrow(
            /server name is required/,
        );
    });

    it("connects with a built then parsed connection string", async () => {
        const text = buildConnectionString(options, true);
        const other = await pgDriver.connect({ options: pgDriver.parseConnectionString(text) });
        expect(await other.getCurrentDatabase()).toBe("yast");
        await other.close();
    });

    it("defaults the database to postgres", async () => {
        const other = await pgDriver.connect({ options: { ...options, database: "" } });
        expect(await other.getCurrentDatabase()).toBe("postgres");
        await other.close();
    });

    it("switches database by reconnecting", async () => {
        const other = await pgDriver.connect({ options });
        await other.changeDatabase("postgres");
        expect(await other.getCurrentDatabase()).toBe("postgres");
        const events: ExecuteEvent[] = [];
        await other.execute(
            { text: "SELECT current_database()", startLine: 0 },
            (e) => events.push(e),
            new AbortController().signal,
        );
        expect(events.find((e) => e.type === "rows")).toMatchObject({
            rows: [[{ displayValue: "postgres" }]],
        });
        await other.close();
    });
});

describe("object explorer", () => {
    it("lists databases without templates", async () => {
        const databases = await labelsUnder(server, "Databases");
        expect(databases).toContain("yast");
        expect(databases).not.toContain("template0");
        expect(databases).not.toContain("template1");
    });

    it("lists roles with the right icons", async () => {
        const roles = await connection.expandNode(await expandPath(server, "Login/Group Roles"));
        const yast = roles.find((r) => r.label === "yast");
        expect(yast?.nodeType).toBe("ServerLevelLogin");
        expect(yast?.metadata?.metadataTypeName).toBe("Login");
        expect(roles.find((r) => r.label === "pg_read_all_data")?.nodeType).toBe(
            "ServerLevelServerRole",
        );
    });

    it("lists user and system schemas", async () => {
        const path = [server, "Databases", "yast", "Schemas"];
        const schemas = await labelsUnder(...path);
        expect(schemas).toContain("public");
        expect(schemas[schemas.length - 1]).toBe("System Schemas");
        expect(schemas).not.toContain("pg_catalog");
        expect(await labelsUnder(...path, "System Schemas")).toEqual([
            "information_schema",
            "pg_catalog",
        ]);
    });

    it("lists the object folders of a schema", async () => {
        expect(await labelsUnder(server, "Databases", "yast", "Schemas", "public")).toEqual([
            "Tables",
            "Views",
            "Materialized Views",
            "Functions",
            "Procedures",
            "Sequences",
            "Types",
        ]);
    });

    const publicPath = [server, "Databases", "yast", "Schemas", "public"];

    it("walks the customers table", async () => {
        const tables = await connection.expandNode(await expandPath(...publicPath, "Tables"));
        expect(tables.map((t) => t.label)).toEqual(["customers", "orders"]);

        const customers = tables[0];
        expect(customers).toMatchObject({
            nodePath: `${server}/Databases/yast/Schemas/public/Tables/customers`,
            parentNodePath: `${server}/Databases/yast/Schemas/public/Tables`,
            nodeType: "Table",
            isLeaf: false,
            database: "yast",
        });
        expect(customers.metadata).toMatchObject({
            metadataTypeName: "Table",
            schema: "public",
            name: "customers",
            parentName: null,
        });

        expect(await labelsUnder(...publicPath, "Tables", "customers")).toEqual([
            "Columns",
            "Keys",
            "Constraints",
            "Indexes",
            "Triggers",
        ]);
        expect(await labelsUnder(...publicPath, "Tables", "customers", "Columns")).toEqual([
            "id (PK, integer, not null)",
            "name (character varying(100), not null)",
            "email (character varying(255), not null)",
            "created_at (timestamp without time zone, not null)",
        ]);
        expect(await labelsUnder(...publicPath, "Tables", "customers", "Keys")).toEqual([
            "customers_pkey",
            "customers_email_key",
        ]);
        expect(await labelsUnder(...publicPath, "Tables", "customers", "Indexes")).toEqual([
            "customers_pkey (Unique, Primary)",
            "customers_email_key (Unique)",
        ]);
        expect(await labelsUnder(...publicPath, "Tables", "customers", "Constraints")).toEqual([]);
        expect(await labelsUnder(...publicPath, "Tables", "customers", "Triggers")).toEqual([]);
    });

    it("walks the orders table", async () => {
        expect(await labelsUnder(...publicPath, "Tables", "orders", "Columns")).toEqual([
            "id (PK, integer, not null)",
            "customer_id (FK, integer, not null)",
            "amount (numeric(10,2), not null)",
            "status (character varying(20), not null)",
        ]);
        const keys = await connection.expandNode(
            await expandPath(...publicPath, "Tables", "orders", "Keys"),
        );
        expect(
            keys.map((k) => [k.label, k.nodeType, k.nodeSubType, k.metadata?.metadataTypeName]),
        ).toEqual([
            ["orders_pkey", "Key", "PrimaryKey", "Index"],
            ["orders_customer_id_fkey", "Key", "ForeignKey", "ForeignKey"],
        ]);
        expect(await labelsUnder(...publicPath, "Tables", "orders", "Indexes")).toEqual([
            "orders_pkey (Unique, Primary)",
        ]);
    });

    it("sets column metadata and paths", async () => {
        const columns = await connection.expandNode(
            await expandPath(...publicPath, "Tables", "customers", "Columns"),
        );
        expect(columns[0]).toMatchObject({
            nodePath: `${server}/Databases/yast/Schemas/public/Tables/customers/Columns/id`,
            nodeType: "Column",
            isLeaf: true,
            database: "yast",
        });
        expect(columns[0].metadata).toMatchObject({
            metadataTypeName: "Column",
            schema: "public",
            name: "id",
            parentName: "customers",
            parentTypeName: "Table",
        });
    });

    it("shows every kind of schema object", async () => {
        const s = TREE_SCHEMA;
        const setup = await run(`
            CREATE SCHEMA ${s};
            CREATE TABLE ${s}.items (id int PRIMARY KEY, qty int CHECK (qty >= 0), name text);
            CREATE INDEX items_name_idx ON ${s}.items (name);
            CREATE VIEW ${s}.item_names AS SELECT id, name FROM ${s}.items;
            CREATE MATERIALIZED VIEW ${s}.item_counts AS SELECT count(*) AS n FROM ${s}.items;
            CREATE SEQUENCE ${s}.item_seq;
            CREATE TYPE ${s}.mood AS ENUM ('sad', 'happy');
            CREATE TYPE ${s}.pair AS (a int, b int);
            CREATE DOMAIN ${s}.positive AS int CHECK (VALUE > 0);
            CREATE FUNCTION ${s}.add_one(x int) RETURNS int LANGUAGE sql AS 'SELECT x + 1';
            CREATE FUNCTION ${s}.all_items() RETURNS SETOF ${s}.items LANGUAGE sql AS 'SELECT * FROM ${s}.items';
            CREATE FUNCTION ${s}.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
            CREATE TRIGGER items_touch BEFORE INSERT ON ${s}.items FOR EACH ROW EXECUTE FUNCTION ${s}.touch();
            CREATE PROCEDURE ${s}.do_nothing() LANGUAGE sql AS 'SELECT 1';
            CREATE AGGREGATE ${s}.my_sum(int) (SFUNC = int4pl, STYPE = int, INITCOND = 0);
        `);
        expect(messages(setup).filter((m) => m.isError)).toEqual([]);

        const path = [server, "Databases", "yast", "Schemas", s];
        expect(await labelsUnder(...path, "Tables")).toEqual(["items"]);
        expect(await labelsUnder(...path, "Views")).toEqual(["item_names"]);
        expect(await labelsUnder(...path, "Materialized Views")).toEqual(["item_counts"]);
        expect(await labelsUnder(...path, "Sequences")).toEqual(["item_seq"]);
        expect(await labelsUnder(...path, "Procedures")).toEqual(["do_nothing()"]);

        const views = await connection.expandNode(await expandPath(...path, "Views"));
        expect(views[0]).toMatchObject({
            nodeType: "View",
            metadata: { metadataTypeName: "View", metadataType: 1 },
        });
        expect(await labelsUnder(...path, "Views", "item_names")).toEqual(["Columns"]);
        expect(await labelsUnder(...path, "Views", "item_names", "Columns")).toEqual([
            "id (integer, null)",
            "name (text, null)",
        ]);
        expect(await labelsUnder(...path, "Materialized Views", "item_counts")).toEqual([
            "Columns",
            "Indexes",
        ]);

        const functions = await connection.expandNode(await expandPath(...path, "Functions"));
        expect(functions.map((f) => [f.label, f.nodeType])).toEqual([
            ["add_one(x integer)", "ScalarValuedFunction"],
            ["all_items()", "TableValuedFunction"],
            ["my_sum(integer)", "AggregateFunction"],
            ["touch()", "ScalarValuedFunction"],
        ]);

        const types = await connection.expandNode(await expandPath(...path, "Types"));
        expect(types.map((t) => [t.label, t.nodeType])).toEqual([
            ["mood", "UserDefinedType"],
            ["pair", "UserDefinedType"],
            ["positive", "UserDefinedDataType"],
        ]);

        expect(await labelsUnder(...path, "Tables", "items", "Constraints")).toEqual([
            "items_qty_check",
        ]);
        expect(await labelsUnder(...path, "Tables", "items", "Triggers")).toEqual(["items_touch"]);
        expect(await labelsUnder(...path, "Tables", "items", "Indexes")).toEqual([
            "items_pkey (Unique, Primary)",
            "items_name_idx (Non-Unique)",
        ]);
        const sequences = await connection.expandNode(await expandPath(...path, "Sequences"));
        expect(sequences[0].nodeType).toBe("Sequence");
    });

    it("shows system schema contents", async () => {
        const tables = await labelsUnder(
            server,
            "Databases",
            "yast",
            "Schemas",
            "System Schemas",
            "pg_catalog",
            "Tables",
        );
        expect(tables).toContain("pg_class");
    });

    it("opens another database lazily", async () => {
        const schemas = await labelsUnder(server, "Databases", "postgres", "Schemas");
        expect(schemas).toContain("public");
        const node = await expandPath(server, "Databases", "postgres", "Schemas", "public");
        expect(node.database).toBe("postgres");
    });
});

describe("execute", () => {
    it("runs a multi-statement script in order", async () => {
        const events = await run("SELECT 1 AS a; SELECT 'x;y' AS b, 2 AS c; -- done");
        expect(events.map((e) => e.type)).toEqual([
            "resultSetStart",
            "rows",
            "resultSetEnd",
            "message",
            "resultSetStart",
            "rows",
            "resultSetEnd",
            "message",
        ]);
        expect(events[0]).toMatchObject({
            columns: [{ columnName: "a", dataTypeName: "integer", kind: "number" }],
        });
        expect(events[4]).toMatchObject({
            columns: [{ columnName: "b", dataTypeName: "text" }, { columnName: "c" }],
        });
        expect(events[5]).toMatchObject({
            rows: [[{ displayValue: "x;y", isNull: false }, { displayValue: "2" }]],
        });
        expect(events[3]).toMatchObject({ text: "SELECT 1", isError: false });
    });

    it("streams 1200 rows in chunks", async () => {
        const events = await run("SELECT g, g * 2 AS doubled FROM generate_series(1, 1200) g");
        const chunks = events.flatMap((e) => (e.type === "rows" ? [e.rows.length] : []));
        expect(chunks).toEqual([500, 500, 200]);
        expect(events.find((e) => e.type === "resultSetEnd")).toMatchObject({ rowCount: 1200 });
        expect(messages(events).map((m) => m.text)).toEqual(["SELECT 1200"]);
    });

    it("handles exactly one full chunk", async () => {
        const events = await run("SELECT g FROM generate_series(1, 500) g");
        expect(events.flatMap((e) => (e.type === "rows" ? [e.rows.length] : []))).toEqual([500]);
        expect(events.find((e) => e.type === "resultSetEnd")).toMatchObject({ rowCount: 500 });
    });

    it("reports an empty result set with its columns", async () => {
        const events = await run("SELECT 1 AS a WHERE false");
        expect(events.map((e) => e.type)).toEqual(["resultSetStart", "resultSetEnd", "message"]);
        expect(messages(events)[0].text).toBe("SELECT 0");
    });

    it("emits command tags for statements without rows", async () => {
        const events = await run(`
            CREATE TEMP TABLE yast_t (a int);
            INSERT INTO yast_t VALUES (1), (2), (3);
            UPDATE yast_t SET a = a + 1 WHERE a > 1;
            DELETE FROM yast_t WHERE a = 1;
            DROP TABLE yast_t;
        `);
        expect(messages(events).map((m) => [m.text, m.rowsAffected])).toEqual([
            ["CREATE TABLE", undefined],
            ["INSERT 0 3", 3],
            ["UPDATE 2", 2],
            ["DELETE 1", 1],
            ["DROP TABLE", undefined],
        ]);
        expect(events.some((e) => e.type === "resultSetStart")).toBe(false);
    });

    it("keeps the same session between batches", async () => {
        await run("BEGIN; CREATE TEMP TABLE yast_keep (a int); INSERT INTO yast_keep VALUES (7);");
        const row = await singleRow("SELECT a FROM yast_keep");
        expect(row[0].displayValue).toBe("7");
        await run("ROLLBACK");
        const events = await run("SELECT * FROM yast_keep");
        expect(messages(events)[0].text).toMatch(/relation "yast_keep" does not exist/);
    });

    it("turns RAISE NOTICE into messages", async () => {
        const events = await run(
            `DO $$ BEGIN RAISE NOTICE 'hello %', 42; RAISE WARNING 'careful'; END $$;`,
        );
        expect(messages(events).map((m) => [m.text, m.isError])).toEqual([
            ["NOTICE:  hello 42", false],
            ["WARNING:  careful", false],
            ["DO", false],
        ]);
    });

    it("reports errors with a position and stops the script", async () => {
        const events = await run(
            "SELECT 1;\nSELECT 2;\nSELECT * FROM missing_table_xyz;\nSELECT 4;",
        );
        const error = messages(events).find((m) => m.isError);
        expect(error?.text).toBe('ERROR:  relation "missing_table_xyz" does not exist');
        expect(error?.position).toEqual({ line: 2, column: 14 });
        const shown = events.flatMap((e) =>
            e.type === "rows" ? e.rows.map((r) => r[0].displayValue) : [],
        );
        expect(shown).toEqual(["1", "2"]);
    });

    it("includes DETAIL and HINT lines", async () => {
        const events = await run("SELECT 1 / 0; ");
        expect(messages(events)[0]).toMatchObject({
            text: "ERROR:  division by zero",
            isError: true,
        });

        const withHint = await run("SELECT length(5, 6)");
        expect(messages(withHint)[0].text).toMatch(
            /^ERROR: {2}function length\(integer, integer\) does not exist\nHINT: {2}/,
        );
    });

    it("maps positions after earlier statements on the same line", async () => {
        const events = await run("SELECT 1; SELECT nope");
        expect(messages(events).find((m) => m.isError)?.position).toEqual({ line: 0, column: 17 });
    });

    it("produces nothing for comment-only scripts", async () => {
        expect(await run("-- just a comment\n/* another */")).toEqual([]);
    });

    it("cancels a long statement", async () => {
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(), 300);
        const events = await run("SELECT pg_sleep(30); SELECT 'never'", controller.signal);
        expect(Date.now() - started).toBeLessThan(10000);
        expect(messages(events)).toEqual([
            { type: "message", text: "Query was canceled by user.", isError: true },
        ]);
        // The session is still usable afterwards.
        expect((await singleRow("SELECT 5"))[0].displayValue).toBe("5");
    });

    it("does not run anything when already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const events = await run("SELECT 1", controller.signal);
        expect(messages(events).map((m) => m.text)).toEqual(["Query was canceled by user."]);
    });
});

describe("displayed values", () => {
    it("shows PostgreSQL's text output", async () => {
        await run("SET TimeZone = 'UTC'");
        const row = await singleRow(`SELECT
            42::integer,
            1.50::numeric(10,2),
            1.5::real,
            true,
            false,
            DATE '2024-03-05',
            TIMESTAMPTZ '2024-03-05 10:20:30.5+00',
            INTERVAL '1 day 2 hours',
            '123e4567-e89b-12d3-a456-426614174000'::uuid,
            '{"a":  1}'::json,
            '{"a":  1}'::jsonb,
            '\\xdeadbeef'::bytea,
            ARRAY[1, 2, 3],
            ARRAY['a', NULL, 'c b'],
            NULL::text,
            ''::text`);
        expect(row.map((c) => c.displayValue)).toEqual([
            "42",
            "1.50",
            "1.5",
            "true",
            "false",
            "2024-03-05",
            "2024-03-05 10:20:30.5+00",
            "1 day 02:00:00",
            "123e4567-e89b-12d3-a456-426614174000",
            '{"a":  1}',
            '{"a": 1}',
            "\\xdeadbeef",
            "{1,2,3}",
            '{a,NULL,"c b"}',
            "NULL",
            "",
        ]);
        expect(row.map((c) => c.isNull)).toEqual([...Array(14).fill(false), true, false]);
    });

    it("describes column types", async () => {
        const events =
            await run(`SELECT 1::integer a, 1::numeric b, now() c, now()::timestamp d, 'x'::varchar e,
            '{}'::json f, '{}'::jsonb g, '\\x00'::bytea h, true i, ARRAY[1] j, '<a/>'::xml k, interval '1 day' l`);
        const start = events.find((e) => e.type === "resultSetStart");
        if (start?.type !== "resultSetStart") throw new Error("no result set");
        expect(start.columns.map((c) => [c.dataTypeName, c.kind])).toEqual([
            ["integer", "number"],
            ["numeric", "number"],
            ["timestamp with time zone", "datetime"],
            ["timestamp without time zone", "datetime"],
            ["character varying", "string"],
            ["json", "json"],
            ["jsonb", "json"],
            ["bytea", "binary"],
            ["boolean", "boolean"],
            ["integer[]", "string"],
            ["xml", "xml"],
            ["interval", "string"],
        ]);
        expect(start.columns.filter((c) => c.isJson).map((c) => c.columnName)).toEqual(["f", "g"]);
        expect(start.columns.filter((c) => c.isBytes).map((c) => c.columnName)).toEqual(["h"]);
        expect(start.columns.filter((c) => c.isXml).map((c) => c.columnName)).toEqual(["k"]);
    });

    it("learns the names of types created in the script", async () => {
        const events = await run(`
            CREATE TYPE pg_temp.yast_mood AS ENUM ('ok');
            SELECT 'ok'::pg_temp.yast_mood AS m;
            DROP TYPE pg_temp.yast_mood;`);
        const start = events.find((e) => e.type === "resultSetStart");
        expect(start).toMatchObject({
            columns: [{ dataTypeName: expect.stringContaining("yast_mood") }],
        });
    });
});
