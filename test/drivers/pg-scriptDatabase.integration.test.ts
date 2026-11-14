import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDriver } from "../../src/drivers/pg";
import type { DriverConnection, ScriptDatabaseOptions } from "../../src/drivers/types";
import { pgOptions } from "../support/databases";

// "Generate Scripts..." on a real PostgreSQL: the script of a database rich in object kinds and
// data types, run in a new empty database, must give a copy that scripts the same and holds the
// same rows.

const suffix = randomBytes(4).toString("hex");
const SOURCE = `yast_oe_pgsdb_src_${suffix}`;
const COPY = `yast_oe_pgsdb_copy_${suffix}`;
const BIG = `yast_oe_pgsdb_big_${suffix}`;
const BIG_ROWS = 100000;
const OBJECTS = readFileSync(resolve(__dirname, "../fixtures/scripting/pg-objects.sql"), "utf8");

describe("scriptDatabase (PostgreSQL)", () => {
    let admin: DriverConnection;
    const connections: DriverConnection[] = [];

    async function connect(database: string) {
        const connection = await pgDriver.connect({ options: pgOptions({ database }) });
        connections.push(connection);
        return connection;
    }

    async function run(connection: DriverConnection, script: string): Promise<string[][]> {
        const errors: string[] = [];
        const rows: string[][] = [];
        for (const batch of pgDriver.splitBatches(script)) {
            await connection.execute(
                batch,
                (e) => {
                    if (e.type === "message" && e.isError) errors.push(e.text);
                    if (e.type === "rows")
                        rows.push(
                            ...e.rows.map((r) =>
                                r.map((c) => (c.isNull ? "<null>" : c.displayValue)),
                            ),
                        );
                },
                new AbortController().signal,
            );
        }
        expect(errors).toEqual([]);
        return rows;
    }

    async function scriptOf(
        connection: DriverConnection,
        database: string,
        options: ScriptDatabaseOptions,
    ) {
        const chunks: string[] = [];
        await connection.scriptDatabase(
            database,
            options,
            (text) => {
                chunks.push(text);
            },
            new AbortController().signal,
        );
        return { script: chunks.join(""), chunks };
    }

    /** Rows of every table (generated columns left out), as sorted text. */
    async function contents(connection: DriverConnection): Promise<Record<string, string[]>> {
        const tables = await run(
            connection,
            `SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname),
                    (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '')
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               AND n.nspname NOT LIKE 'pg\\_%'
             ORDER BY 1`,
        );
        const result: Record<string, string[]> = {};
        for (const [name, columns] of tables) {
            const rows = await run(connection, `SELECT ${columns} FROM ONLY ${name}`);
            result[name] = rows.map((r) => JSON.stringify(r)).sort();
        }
        return result;
    }

    beforeAll(async () => {
        admin = await pgDriver.connect({ options: pgOptions() });
        await run(admin, `CREATE DATABASE ${SOURCE}`);
        await run(admin, `CREATE DATABASE ${COPY}`);
        await run(admin, `CREATE DATABASE ${BIG}`);
        await run(await connect(SOURCE), OBJECTS);
        await run(
            await connect(BIG),
            `CREATE TABLE big (id integer PRIMARY KEY, label text NOT NULL);
             INSERT INTO big SELECT i, 'row number ' || i FROM generate_series(1, ${BIG_ROWS}) i;`,
        );
    }, 60000);

    afterAll(async () => {
        for (const connection of connections) await connection.close();
        for (const database of [SOURCE, COPY, BIG]) {
            await run(admin, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        }
        await admin.close();
    });

    it("recreates the database in a new one: same script, same rows", async () => {
        const source = await connect(SOURCE);
        const { script } = await scriptOf(source, SOURCE, { schema: true, data: true });
        expect(script).not.toMatch(/CREATE DATABASE|\\connect/);
        expect(script).toContain("OVERRIDING SYSTEM VALUE");
        expect(script).toContain("SELECT pg_catalog.setval('app.counter', 10, true);");

        const copy = await connect(COPY);
        await run(copy, script);
        expect((await scriptOf(copy, COPY, { schema: true, data: true })).script).toBe(script);
        const [expected, actual] = [await contents(source), await contents(copy)];
        expect(actual).toEqual(expected);
        expect(expected["app.all_types"]).toHaveLength(3);
        expect(expected["app.mood_counts"]).toHaveLength(3);
        // The sequences go on from the same values.
        expect(await run(copy, "SELECT nextval('app.customers_id_seq')")).toEqual([["4"]]);
    }, 120000);

    it("scripts the schema alone, or the data alone", async () => {
        const source = await connect(SOURCE);
        const schema = (await scriptOf(source, SOURCE, { schema: true, data: false })).script;
        const data = (await scriptOf(source, SOURCE, { schema: false, data: true })).script;
        expect(schema).toContain("CREATE TABLE app.customers (");
        expect(schema).not.toMatch(/^INSERT /m);
        expect(data).not.toMatch(/^CREATE /m);
        expect(data).toContain(
            "INSERT INTO app.customers (id, code, mood, qty, price, twice, created) VALUES (1, 'a', 'happy', 2, 10.50, 6, ",
        );
    });

    it("streams the rows of a large table instead of holding them", async () => {
        const big = await connect(BIG);
        const { script, chunks } = await scriptOf(big, BIG, { schema: false, data: true });
        expect(script.match(/^INSERT /gm)).toHaveLength(BIG_ROWS);
        expect(chunks.length).toBeGreaterThan(100);
        expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(100000);
    }, 120000);

    it("stops when canceled, and leaves the session as it was", async () => {
        const big = await connect(BIG);
        const controller = new AbortController();
        const done = big.scriptDatabase(
            BIG,
            { schema: true, data: true },
            async (text) => {
                if (text.includes("INSERT ")) controller.abort();
            },
            controller.signal,
        );
        await expect(done).rejects.toThrow(/canceled/);
        expect(await big.getCurrentDatabase()).toBe(BIG);
        // The session is not in a transaction: a failing statement does not poison the next one.
        expect(await run(big, "SELECT count(*) FROM big")).toEqual([[String(BIG_ROWS)]]);
        expect(await run(big, "SELECT current_setting('check_function_bodies')")).toEqual([["on"]]);
    }, 120000);
});
