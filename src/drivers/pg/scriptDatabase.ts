/**
 * Script of a whole PostgreSQL database ("Generate Scripts..."), in the spirit of pg_dump --inserts:
 * schemas; types, sequences, functions, tables and views sorted by their dependencies (pg_depend);
 * the data; the sequences' values; then foreign keys, indexes, triggers, and the refresh of the
 * materialized views. No CREATE DATABASE or \connect: the script runs in the database the user
 * chooses. Extensions, owners, privileges, policies and event triggers are not scripted.
 *
 * Everything is read on a connection of its own, in one REPEATABLE READ READ ONLY transaction (a
 * consistent snapshot, like pg_dump), so the user's session is never touched.
 */

import type { Client } from "pg";
import Cursor from "pg-cursor";
import type { ScriptDatabaseOptions } from "../types";
import { loadTypeNames } from "./catalog";
import { rawTextTypes } from "./clients";
import { columnInfo } from "./execute";
import * as catalog from "./scriptCatalog";
import * as text from "./scriptText";
import { toSqlLiteral } from "./sqlText";

/** Rows read from the cursor, then written, at a time. */
export const ROWS_PER_READ = 500;

type Write = (text: string) => void | Promise<void>;

const HEADER = `-- Run in the database that receives the objects. Function bodies are checked when they run,
-- not when they are created (as in pg_dump): the objects they use may come later in the script.
SET check_function_bodies = false;
SET standard_conforming_strings = on;

`;
const FOOTER = "\nRESET check_function_bodies;\n";

export async function scriptDatabase(
    openClient: () => Promise<Client>,
    options: ScriptDatabaseOptions,
    write: Write,
    signal: AbortSignal,
    onProgress: (message: string) => void = () => undefined,
): Promise<void> {
    const client = await openClient();
    // pg's Client cancels nothing by itself: ending the connection stops a running read.
    const onAbort = () => void client.end().catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        // Unambiguous text for dates, intervals and floats, whatever the server's defaults.
        await client.query("SET LOCAL DateStyle = ISO, YMD");
        await client.query("SET LOCAL IntervalStyle = postgres");
        await client.query("SET LOCAL extra_float_digits = 3");
        await catalog.useEmptySearchPath(client);
        await run(client, options, write, signal, onProgress);
        await client.query("COMMIT");
    } catch (error) {
        if (signal.aborted) throw abortError();
        throw error;
    } finally {
        signal.removeEventListener("abort", onAbort);
        await client.end().catch(() => undefined);
    }
    if (signal.aborted) throw abortError();
}

function abortError(): Error {
    const error = new Error("The script was canceled.");
    error.name = "AbortError";
    return error;
}

type Item =
    | { kind: "type"; key: string; name: string; type: text.PgType }
    | { kind: "sequence"; key: string; name: string; sequence: text.PgSequence }
    | { kind: "routine"; key: string; name: string; routine: text.PgRoutine }
    | { kind: "table"; key: string; name: string; table: text.PgTable }
    | { kind: "view"; key: string; name: string; view: text.PgView };

const RANK: Record<Item["kind"], number> = { type: 0, sequence: 1, routine: 2, table: 3, view: 4 };

async function run(
    client: Client,
    options: ScriptDatabaseOptions,
    write: Write,
    signal: AbortSignal,
    onProgress: (message: string) => void,
): Promise<void> {
    const checkAborted = () => {
        if (signal.aborted) throw abortError();
    };
    onProgress("Reading the catalog");
    const tables = await catalog.loadTables(client);
    const leafTables = tables
        .flatMap((t) => [t, ...text.allPartitions(t)])
        .filter((t) => t.kind === "r");
    checkAborted();

    if (options.schema) {
        await write(HEADER);
        const schemas = await catalog.loadSchemas(client);
        // public exists in every new database.
        await write(
            schemas
                .filter(([name]) => name !== "public")
                .map(([name, comment]) => text.scriptSchemaCreate(name, comment))
                .join("\n"),
        );
        const items = dependencyOrder(
            [
                ...(await catalog.loadTypes(client)).map((type): Item => ({
                    kind: "type",
                    key: `t${type.oid}`,
                    name: type.qualifiedName,
                    type,
                })),
                ...(await catalog.loadSequences(client)).map((sequence): Item => ({
                    kind: "sequence",
                    key: `c${sequence.oid}`,
                    name: sequence.qualifiedName,
                    sequence,
                })),
                ...(await catalog.loadRoutines(client)).map((routine): Item => ({
                    kind: "routine",
                    key: `p${routine.oid}`,
                    name: `${routine.qualifiedName}(${routine.identityArguments})`,
                    routine,
                })),
                ...tables.map((table): Item => ({
                    kind: "table",
                    key: `c${table.oid}`,
                    name: table.qualifiedName,
                    table,
                })),
                ...(await catalog.loadViews(client)).map((view): Item => ({
                    kind: "view",
                    key: `c${view.oid}`,
                    name: view.qualifiedName,
                    view,
                })),
            ],
            await catalog.loadDependencies(client),
            partitionRoots(tables),
        );
        for (const item of items) {
            checkAborted();
            onProgress(`Scripting ${item.name}`);
            await write(`\n${scriptItem(item)}`);
        }
        await write(
            tables
                .map((t) => text.tableScriptParts(t).sequenceOwners)
                .filter(Boolean)
                .map((t) => `\n${t}`)
                .join(""),
        );
    }

    if (options.data) {
        const typeNames = await loadTypeNames(client);
        for (const table of leafTables) {
            checkAborted();
            onProgress(`Scripting the data of ${table.qualifiedName}`);
            await scriptTableData(
                client,
                typeNames,
                table,
                primaryKeyOf(table, tables),
                write,
                signal,
            );
        }
        checkAborted();
        const states = await catalog.loadSequenceStates(client);
        const lines: string[] = [];
        for (const sequence of states) {
            const state = await client.query(
                `SELECT last_value::text AS value, is_called FROM ${sequence.qualifiedName}`,
            );
            const { value, is_called: isCalled } = state.rows[0];
            lines.push(
                `SELECT pg_catalog.setval(${sequence.literal}, ${value}, ${isCalled ? "true" : "false"});\n`,
            );
        }
        if (lines.length > 0) await write(`\n${lines.join("")}`);
    }

    if (options.schema) {
        onProgress("Scripting keys, indexes and triggers");
        for (const table of tables) {
            checkAborted();
            const rest = text.tableScriptParts(table).rest;
            if (rest !== "") await write(`\n${rest}`);
        }
        const views = await catalog.loadViews(client);
        for (const view of views) {
            for (const trigger of view.triggers) {
                await write(`\n${text.scriptTriggerCreate(view.qualifiedName, trigger)}`);
            }
        }
        // Materialized views are created empty, and filled once the data is there.
        const populated = views.filter((v) => v.materialized && v.populated);
        await write(
            populated.map((v) => `\nREFRESH MATERIALIZED VIEW ${v.qualifiedName};\n`).join(""),
        );
        await write(FOOTER);
    }
}

function scriptItem(item: Item): string {
    switch (item.kind) {
        case "type":
            return text.scriptTypeCreate(item.type);
        case "sequence":
            return text.scriptSequenceCreate(item.sequence, false);
        case "routine":
            return text.scriptRoutineCreate(item.routine);
        case "table":
            return text.tableScriptParts(item.table).table;
        case "view": {
            const view = { ...item.view, populated: false, triggers: [] };
            return text.scriptViewCreate(view);
        }
    }
}

/** Partition key -> key of its root table (dependencies on a partition count for the root). */
function partitionRoots(tables: text.PgTable[]): Map<string, string> {
    const roots = new Map<string, string>();
    for (const table of tables) {
        for (const partition of text.allPartitions(table))
            roots.set(`c${partition.oid}`, `c${table.oid}`);
    }
    return roots;
}

/** Kahn's algorithm over pg_depend; at equal rank: types, sequences, functions, tables, views. */
export function dependencyOrder(
    items: Item[],
    dependencies: Array<[string, string]>,
    aliases: Map<string, string> = new Map(),
): Item[] {
    const byKey = new Map(items.map((item) => [item.key, item]));
    const waitingFor = new Map<string, Set<string>>(items.map((item) => [item.key, new Set()]));
    for (const [rawFrom, rawTo] of dependencies) {
        const from = aliases.get(rawFrom) ?? rawFrom;
        const to = aliases.get(rawTo) ?? rawTo;
        if (from !== to && byKey.has(from) && byKey.has(to)) waitingFor.get(from)!.add(to);
    }
    const compare = (a: Item, b: Item) =>
        RANK[a.kind] - RANK[b.kind] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const result: Item[] = [];
    const done = new Set<string>();
    while (done.size < items.length) {
        const remaining = items.filter((item) => !done.has(item.key));
        const ready = remaining.filter((item) =>
            [...waitingFor.get(item.key)!].every((key) => done.has(key)),
        );
        const next = (ready.length > 0 ? ready : remaining).sort(compare)[0];
        done.add(next.key);
        result.push(next);
    }
    return result;
}

/** Columns of the table's primary key (or its root's, for a partition), already quoted. */
function primaryKeyOf(table: text.PgTable, roots: text.PgTable[]): string | null {
    const own = table.constraints.find((c) => c.type === "p");
    const root = roots.find((r) => r === table || text.allPartitions(r).includes(table));
    const key = own ?? root?.constraints.find((c) => c.type === "p");
    return key?.definition.match(/^PRIMARY KEY \((.*?)\)/)?.[1] ?? null;
}

/** INSERT statements of a table's rows, read through a cursor so that memory stays bounded. */
export async function scriptTableData(
    client: Client,
    typeNames: Map<number, string>,
    table: text.PgTable,
    orderBy: string | null,
    write: Write,
    signal: AbortSignal,
): Promise<void> {
    const columns = table.columns.filter((c) => c.generatedExpression === null);
    if (columns.length === 0) return;
    const names = columns.map((c) => c.name).join(", ");
    const overriding = columns.some((c) => c.identity === "a") ? " OVERRIDING SYSTEM VALUE" : "";
    const prefix = `INSERT INTO ${table.qualifiedName} (${names})${overriding} VALUES (`;
    const cursor: any = client.query(
        new Cursor(
            `SELECT ${names} FROM ONLY ${table.qualifiedName}${orderBy === null ? "" : ` ORDER BY ${orderBy}`}`,
            [],
            { rowMode: "array", types: rawTextTypes },
        ),
    );
    let first = true;
    try {
        while (!signal.aborted) {
            const rows: (string | null)[][] = await cursor.read(ROWS_PER_READ);
            if (rows.length === 0) break;
            const infos = cursor._result.fields.map((f: { name: string; dataTypeID: number }) =>
                columnInfo(f, typeNames),
            );
            const lines = rows.map((row) => {
                const values = row.map((value, i) =>
                    toSqlLiteral(
                        value === null
                            ? { displayValue: "NULL", isNull: true }
                            : { displayValue: value, isNull: false },
                        infos[i],
                    ),
                );
                return `${prefix}${values.join(", ")});\n`;
            });
            await write(`${first ? "\n" : ""}${lines.join("")}`);
            first = false;
            if (rows.length < ROWS_PER_READ) break;
        }
    } finally {
        // After a cancel the connection is gone, and so is the cursor.
        if (!signal.aborted) await new Promise<void>((resolve) => cursor.close(() => resolve()));
    }
}
