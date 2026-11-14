import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ObjectMetadata } from "vscode-mssql";
import { pgDriver } from "../../src/drivers/pg";
import type { DriverConnection, ObjectNode, ScriptOperation } from "../../src/drivers/types";
import { pgOptions } from "../support/databases";

// "Script as Create / Drop / Alter / Execute" on a real PostgreSQL: every object is dropped with
// its Drop script, created again with its Create script, and must then script the same.

const DB = `yast_oe_pgso_${randomBytes(4).toString("hex")}`;
const OBJECTS = readFileSync(resolve(__dirname, "../fixtures/scripting/pg-objects.sql"), "utf8");

/** A node as the pg Object Explorer builds it (only what scripting reads). */
function node(
    nodeType: string,
    schema: string | null,
    name: string,
    extra: { parentName?: string; label?: string; typeName?: string } = {},
): ObjectNode {
    return {
        nodePath: `x/${name}`,
        parentNodePath: "x",
        nodeType,
        label: extra.label ?? name,
        isLeaf: true,
        database: DB,
        metadata: {
            metadataType: 0,
            metadataTypeName: extra.typeName ?? nodeType,
            schema,
            name,
            parentName: extra.parentName ?? null,
            parentTypeName: null,
            urn: "",
        } as unknown as ObjectMetadata,
    };
}

const routine = (nodeType: string, name: string, args: string) =>
    node(nodeType, "app", name, { label: `${name}(${args})` });

describe("Script as Create / Drop / Alter / Execute (PostgreSQL)", () => {
    let admin: DriverConnection;
    let connection: DriverConnection;

    async function run(conn: DriverConnection, script: string) {
        const errors: string[] = [];
        for (const batch of pgDriver.splitBatches(script)) {
            await conn.execute(
                batch,
                (e) => {
                    if (e.type === "message" && e.isError) errors.push(e.text);
                },
                new AbortController().signal,
            );
        }
        expect(errors, script.slice(0, 300)).toEqual([]);
    }

    const script = (target: ObjectNode, operation: ScriptOperation) =>
        connection.scriptObject(target, operation);

    beforeAll(async () => {
        admin = await pgDriver.connect({ options: pgOptions() });
        await run(admin, `CREATE DATABASE ${DB}`);
        connection = await pgDriver.connect({ options: pgOptions({ database: DB }) });
        await run(connection, OBJECTS);
    }, 60000);

    afterAll(async () => {
        await connection?.close();
        await run(admin, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
        await admin.close();
    });

    it("scripts a table like pg_dump, with its sequences, keys, comments and triggers", async () => {
        expect(await script(node("Table", "app", "customers"), "create")).toBe(
            `CREATE SEQUENCE app.customers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE app.customers (
    id integer DEFAULT nextval('app.customers_id_seq'::regclass) NOT NULL,
    code text COLLATE pg_catalog."C" NOT NULL,
    mood app.mood DEFAULT 'ok'::app.mood,
    qty app.positive,
    price numeric(10,2),
    total numeric GENERATED ALWAYS AS (((qty)::numeric * price)) STORED,
    twice integer DEFAULT app.double(3),
    created timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customers_price_check CHECK ((price >= (0)::numeric))
)
WITH (fillfactor=80);

ALTER TABLE ONLY app.customers
    ADD CONSTRAINT customers_code_key UNIQUE (code);

ALTER TABLE ONLY app.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

COMMENT ON TABLE app.customers IS 'People who buy';

COMMENT ON COLUMN app.customers.code IS 'Unique code, it''s case sensitive';

ALTER SEQUENCE app.customers_id_seq OWNED BY app.customers.id;
`,
        );
        const orders = await script(node("Table", "app", "orders"), "create");
        expect(orders).toContain(
            "id bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME app.orders_id_seq START WITH 100 INCREMENT BY 10 NO MINVALUE NO MAXVALUE CACHE 1) NOT NULL",
        );
        expect(orders).toContain(
            "ALTER TABLE ONLY app.orders\n    ADD CONSTRAINT note_length CHECK ((length(note) < 100)) NOT VALID;",
        );
        expect(orders).toContain("ALTER TABLE app.orders DISABLE TRIGGER orders_off;");
        expect(await script(node("Table", "app", "orders"), "delete")).toBe(
            "DROP TABLE IF EXISTS app.orders;\n",
        );
    });

    it("scripts a partitioned table with its partitions", async () => {
        const events = await script(node("Table", "app", "events"), "create");
        expect(events).toContain(") \nPARTITION BY RANGE (happened);".replace(" \n", "\n"));
        expect(events).toContain(
            "CREATE TABLE app.events_2024 PARTITION OF app.events\nFOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
        );
        expect(events).toContain("CREATE TABLE app.events_rest PARTITION OF app.events\nDEFAULT;");
        expect(events).toContain(
            "CREATE INDEX events_payload_idx ON app.events USING gin (payload);",
        );
        expect(events.match(/PRIMARY KEY/g)).toHaveLength(1);
    });

    it("scripts views, functions and procedures as Create, Alter and Execute", async () => {
        expect(await script(node("View", "app", "big_orders"), "alter")).toBe(
            "CREATE OR REPLACE VIEW app.big_orders WITH (security_barrier=true) AS\n SELECT id,\n    customer_id\n   FROM app.orders\n  WHERE (id > 100)\n  WITH LOCAL CHECK OPTION;\n",
        );
        const create = await script(
            routine("ScalarValuedFunction", "double", "x integer"),
            "create",
        );
        expect(create).toMatch(/^CREATE FUNCTION app\.double\(x integer\)/);
        expect(create).toContain("\nCOMMENT ON FUNCTION app.double(x integer) IS 'Twice';\n");
        expect(await script(routine("ScalarValuedFunction", "double", "x numeric"), "delete")).toBe(
            "DROP FUNCTION IF EXISTS app.double(x numeric);\n",
        );
        expect(
            await script(
                routine(
                    "StoredProcedure",
                    "add_order",
                    "IN customer integer, IN note text, INOUT new_id bigint",
                ),
                "execute",
            ),
        ).toBe(
            "-- TODO: Set parameter values here.\n\nCALL app.add_order(\n    customer => NULL::integer,\n    note => NULL::text,\n    new_id => NULL::bigint\n);\n",
        );
        expect(
            await script(
                routine(
                    "StoredProcedure",
                    "add_order",
                    "IN customer integer, IN note text, INOUT new_id bigint",
                ),
                "alter",
            ),
        ).toMatch(/^CREATE OR REPLACE PROCEDURE app\.add_order\(/);
    });

    it("runs the Execute script of a procedure", async () => {
        const execute = await script(
            routine(
                "StoredProcedure",
                "add_order",
                "IN customer integer, IN note text, INOUT new_id bigint",
            ),
            "execute",
        );
        await run(connection, execute.replace("customer => NULL::integer", "customer => 1"));
    });

    const ROUND_TRIPS: Array<[string, ObjectNode, ScriptOperation[]]> = [
        ["table", node("Table", "app", "scratch"), []],
        ["partitioned table", node("Table", "app", "events"), []],
        ["table of every type", node("Table", "app", "all_types"), []],
        ["oddly named table", node("Table", "Odd Schema", 'Odd "Table"'), []],
        ["view with options", node("View", "app", "big_orders"), ["alter"]],
        ["view used by a view", node("View", "app", "top_totals"), ["alter"]],
        ["materialized view", node("View", "app", "mood_counts"), ["alter"]],
        ["overloaded function", routine("ScalarValuedFunction", "double", "x numeric"), ["alter"]],
        [
            "set-returning function",
            routine("TableValuedFunction", "orders_of", "customer integer"),
            ["alter"],
        ],
        [
            "procedure",
            routine(
                "StoredProcedure",
                "add_order",
                "IN customer integer, IN note text, INOUT new_id bigint",
            ),
            ["alter"],
        ],
        ["trigger", node("Trigger", "app", "orders_touch", { parentName: "orders" }), []],
        ["disabled trigger", node("Trigger", "app", "orders_off", { parentName: "orders" }), []],
        ["index", node("Index", "app", "orders_note_idx", { parentName: "orders" }), []],
        ["primary key index", node("Index", "app", "orders_pkey", { parentName: "orders" }), []],
        [
            "materialized view index",
            node("Index", "app", "mood_counts_mood", { parentName: "mood_counts" }),
            [],
        ],
        [
            "foreign key",
            node("Key", "app", "orders_customer_id_fkey", {
                parentName: "orders",
                typeName: "ForeignKey",
            }),
            [],
        ],
        [
            "unique key",
            node("Key", "app", "customers_code_key", {
                parentName: "customers",
                typeName: "Index",
            }),
            [],
        ],
        ["schema", node("Schema", null, "empty_one"), []],
        ["sequence", node("Sequence", "app", "counter"), []],
        ["descending sequence", node("Sequence", "app", "countdown"), []],
        ["range type", node("UserDefinedType", "app", "floatrange"), []],
    ];
    for (const [what, target, alsoRun] of ROUND_TRIPS) {
        it(`drops and creates a ${what} again with its scripts`, async () => {
            const create = await script(target, "create");
            for (const operation of alsoRun) await run(connection, await script(target, operation));
            await run(connection, await script(target, "delete"));
            await expect(script(target, "create")).rejects.toThrow(/does not exist/);
            await run(connection, create);
            expect(await script(target, "create")).toBe(create);
        });
    }
});
