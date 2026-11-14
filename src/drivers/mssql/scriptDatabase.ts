/**
 * Script of a whole SQL Server database ("Generate Scripts..."): its objects, in an order that
 * runs, and optionally the rows of its tables as INSERT statements.
 *
 * Order: principals, schemas, types, sequences, synonyms; tables (columns, primary and unique keys,
 * defaults) together with views, functions and procedures sorted by their dependencies; the data;
 * then the other indexes, foreign keys and checks, system versioning, and last the triggers.
 * Like SSMS's, the script has no CREATE DATABASE: it is meant for a database the user chooses
 * (SSMS also starts with USE [database]; it is left out for the same reason).
 */

import type * as sql from "mssql";
import type { ColumnInfo, ScriptDatabaseOptions } from "../types";
import { formatCell, toColumnInfo, type MssqlColumn } from "./formatting";
import type { ScriptCatalog } from "./scriptCatalog";
import * as text from "./scriptText";
import { quoteIdentifier as q, toSqlLiteral } from "./sqlText";

/** INSERT statements between two GO lines. */
export const ROWS_PER_BATCH = 1000;
/** Rows formatted before the stream is paused and the text written. */
const ROWS_PER_WRITE = 200;

type Write = (text: string) => void | Promise<void>;

export interface ScriptDatabaseContext {
    catalog: ScriptCatalog;
    /** A pool of one connection to the database, for the data; closed by the caller. */
    openDataPool: () => Promise<sql.ConnectionPool>;
}

export async function scriptDatabase(
    context: ScriptDatabaseContext,
    options: ScriptDatabaseOptions,
    write: Write,
    signal: AbortSignal,
    onProgress: (message: string) => void = () => undefined,
): Promise<void> {
    const { catalog } = context;
    const checkAborted = () => {
        if (signal.aborted) throw abortError();
    };

    onProgress("Reading the catalog");
    const tables = (await catalog.tables("all")).sort((a, b) => byQualifiedName(a.table, b.table));
    checkAborted();
    const modules = await catalog.modules(`o.type IN ('V', 'P', 'FN', 'IF', 'TF')`);
    const triggers = await catalog.modules(`o.type = 'TR'`);
    const databaseTriggers = await catalog.databaseTriggers();
    checkAborted();

    if (options.schema) {
        onProgress("Scripting users, roles and schemas");
        const roles = await catalog.principals(["R"]);
        const applicationRoles = await catalog.principals(["A"]);
        const users = await catalog.principals(["S", "U", "G", "E", "X", "C", "K"]);
        await write(roles.map((r) => text.scriptRoleCreate(r.name)).join(""));
        await write(applicationRoles.map(text.scriptApplicationRoleCreate).join(""));
        await write(users.map(text.scriptUserCreate).join(""));
        await write(roles.map(text.scriptRoleMemberships).join(""));
        await write((await catalog.schemas()).map(text.scriptSchemaCreate).join(""));
        checkAborted();

        onProgress("Scripting types, sequences and synonyms");
        await write((await catalog.types()).map(text.scriptTypeCreate).join(""));
        await write((await catalog.tableTypes()).map(text.scriptTableTypeCreate).join(""));
        await write((await catalog.sequences()).map(text.scriptSequenceCreate).join(""));
        await write((await catalog.synonyms()).map(text.scriptSynonymCreate).join(""));
        checkAborted();

        const order = dependencyOrder(tables, modules, await catalog.dependencies());
        for (const item of order) {
            checkAborted();
            if ("table" in item) {
                onProgress(`Scripting table ${item.table.schemaName}.${item.table.name}`);
                await write(tableBeforeData(item));
            } else {
                onProgress(`Scripting ${item.schemaName}.${item.name}`);
                await write(text.scriptModuleCreate(item));
                if (item.type === "V") {
                    const view = await catalog.view(item.objectId);
                    await write(
                        text
                            .orderedIndexes(view?.indexes ?? [])
                            .map((i) =>
                                text.scriptIndexCreate(item.schemaName!, item.name, i, true),
                            )
                            .join(""),
                    );
                }
            }
        }
    }

    // A module created with QUOTED_IDENTIFIER OFF leaves it off; inserting into a table with a
    // filtered index or an indexed view, or creating such an index, needs these two ON.
    const sessionOptions = "SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\n";
    if (options.data) {
        if (options.schema) await write(sessionOptions);
        const pool = await context.openDataPool();
        try {
            for (const table of tables) {
                checkAborted();
                onProgress(`Scripting the data of ${table.table.schemaName}.${table.table.name}`);
                await scriptTableData(pool, table, write, signal);
            }
        } finally {
            await pool.close().catch(() => undefined);
        }
    }

    if (options.schema) {
        onProgress("Scripting indexes, keys and triggers");
        await write(sessionOptions);
        for (const table of tables) {
            checkAborted();
            await write(tableAfterData(table));
        }
        for (const trigger of [...triggers].sort(byQualifiedName)) {
            await write(text.scriptModuleCreate(trigger));
        }
        await write(databaseTriggers.map(text.scriptModuleCreate).join(""));
    }
}

function abortError(): Error {
    const error = new Error("The script was canceled.");
    error.name = "AbortError";
    return error;
}

const byQualifiedName = (
    a: { schemaName: string | null; name: string },
    b: { schemaName: string | null; name: string },
) => {
    const left = `${a.schemaName}.${a.name}`.toLowerCase();
    const right = `${b.schemaName}.${b.name}`.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * Tables and modules sorted so that each comes after what it references (Kahn's algorithm; at
 * equal rank: tables, functions, views, procedures, then by name). Cycles are broken by name.
 */
export function dependencyOrder(
    tables: text.TableModel[],
    modules: text.ModuleRow[],
    dependencies: Array<{ from: number; to: number }>,
): Array<text.TableModel | text.ModuleRow> {
    type Item = text.TableModel | text.ModuleRow;
    const items = new Map<number, Item>();
    for (const table of tables) items.set(table.table.objectId, table);
    for (const module of modules) items.set(module.objectId, module);
    const rank = (item: Item) =>
        "table" in item
            ? 0
            : ["FN", "IF", "TF"].includes(item.type)
              ? 1
              : item.type === "V"
                ? 2
                : 3;
    const key = (item: Item) => ("table" in item ? item.table : item);
    const compare = (a: Item, b: Item) => rank(a) - rank(b) || byQualifiedName(key(a), key(b));

    const waitingFor = new Map<number, Set<number>>();
    for (const id of items.keys()) waitingFor.set(id, new Set());
    for (const { from, to } of dependencies) {
        if (from !== to && items.has(from) && items.has(to)) waitingFor.get(from)!.add(to);
    }
    const result: Item[] = [];
    const done = new Set<number>();
    while (done.size < items.size) {
        const remaining = [...items.entries()].filter(([id]) => !done.has(id));
        const ready = remaining.filter(([id]) =>
            [...waitingFor.get(id)!].every((d) => done.has(d)),
        );
        const [id, item] = (ready.length > 0 ? ready : remaining).sort((a, b) =>
            compare(a[1], b[1]),
        )[0];
        done.add(id);
        result.push(item);
    }
    return result;
}

/** CREATE TABLE, its primary and unique keys and its defaults. A temporal table is not versioned yet. */
export function tableBeforeData(model: text.TableModel): string {
    const { schemaName, name } = model.table;
    // SMO's CREATE TABLE ... WITH (SYSTEM_VERSIONING = ON) fails before the primary key exists:
    // versioning is switched on after the data (tableAfterData).
    const table = { ...model, table: { ...model.table, temporalType: 0 } };
    return (
        text.scriptCreateTableStatement(table) +
        text
            .orderedIndexes(model.indexes.filter((i) => i.isPrimaryKey || i.isUniqueConstraint))
            .map((i) => text.scriptIndexCreate(schemaName, name, i))
            .join("") +
        text.scriptDefaults(model)
    );
}

/** Indexes that are not keys, foreign keys, checks, then system versioning. */
export function tableAfterData(model: text.TableModel): string {
    const { schemaName, name, temporalType, historySchema, historyName } = model.table;
    let script =
        text
            .orderedIndexes(model.indexes.filter((i) => !i.isPrimaryKey && !i.isUniqueConstraint))
            .map((i) => text.scriptIndexCreate(schemaName, name, i))
            .join("") +
        text.scriptForeignKeys(model) +
        text.scriptChecks(model);
    if (temporalType === 2 && historyName !== null) {
        script += `ALTER TABLE ${q(schemaName)}.${q(name)} SET (SYSTEM_VERSIONING = ON (HISTORY_TABLE = ${q(historySchema!)}.${q(historyName)}))\nGO\n`;
    }
    return script;
}

/** Columns that an INSERT can set: not computed, rowversion, or generated by the system. */
export function insertableColumns(model: text.TableModel): text.ColumnRow[] {
    return model.columns.filter(
        (c) =>
            c.computedDefinition === null &&
            c.typeName !== "timestamp" &&
            !(c.typeSchema === "sys" && c.typeName === "rowversion") &&
            c.generatedAlwaysType === 0,
    );
}

/**
 * T-SQL expression that turns a sql_variant column into the literal of its value with its base
 * type, e.g. CAST(N'abc' AS nvarchar(10)): the driver only sees the value, not its type.
 */
function variantLiteral(column: string): string {
    const property = (name: string) => `SQL_VARIANT_PROPERTY(${column}, '${name}')`;
    const baseType = `CONVERT(sysname, ${property("BaseType")})`;
    const typeText = `${baseType} + CASE
        WHEN ${baseType} IN ('decimal', 'numeric') THEN '(' + CONVERT(varchar(3), ${property("Precision")}) + ',' + CONVERT(varchar(3), ${property("Scale")}) + ')'
        WHEN ${baseType} IN ('datetime2', 'datetimeoffset', 'time') THEN '(' + CONVERT(varchar(3), ${property("Scale")}) + ')'
        WHEN ${baseType} IN ('char', 'varchar', 'binary', 'varbinary') THEN '(' + CONVERT(varchar(5), ${property("MaxLength")}) + ')'
        WHEN ${baseType} IN ('nchar', 'nvarchar') THEN '(' + CONVERT(varchar(5), CONVERT(int, ${property("MaxLength")}) / 2) + ')'
        ELSE '' END`;
    const value = `CASE
        WHEN ${baseType} IN ('char', 'varchar', 'nchar', 'nvarchar') THEN 'N''' + REPLACE(CONVERT(nvarchar(4000), ${column}), '''', '''''') + ''''
        WHEN ${baseType} IN ('binary', 'varbinary') THEN CONVERT(nvarchar(4000), CONVERT(varbinary(8000), ${column}), 1)
        WHEN ${baseType} IN ('float', 'real') THEN CONVERT(nvarchar(30), CONVERT(float, ${column}), 3)
        WHEN ${baseType} IN ('date', 'time', 'datetime', 'datetime2', 'smalldatetime') THEN '''' + CONVERT(nvarchar(40), ${column}, 126) + ''''
        WHEN ${baseType} = 'datetimeoffset' THEN '''' + CONVERT(nvarchar(40), ${column}, 127) + ''''
        WHEN ${baseType} = 'uniqueidentifier' THEN '''' + CONVERT(nvarchar(36), ${column}) + ''''
        ELSE CONVERT(nvarchar(4000), ${column}) END`;
    return `CASE WHEN ${column} IS NULL THEN NULL ELSE 'CAST(' + ${value} + ' AS ' + ${typeText} + ')' END`;
}

const SPATIAL_TYPES = new Set(["geography", "geometry"]);

/** SELECT of the rows to script, in key order so that the script is the same each time. */
export function dataQuery(model: text.TableModel): string {
    const { schemaName, name } = model.table;
    const columns = insertableColumns(model).map((c) => {
        if (c.typeName === "sql_variant") return variantLiteral(q(c.name));
        // tedious reads spatial values as objects; their binary form converts back implicitly.
        if (SPATIAL_TYPES.has(c.typeName))
            return `CONVERT(varbinary(max), ${q(c.name)}) AS ${q(c.name)}`;
        return q(c.name);
    });
    const key =
        model.indexes.find((i) => i.isPrimaryKey) ??
        model.indexes.find((i) => i.type === 1) ??
        model.indexes.find((i) => i.isUnique);
    const order = key?.columns
        .filter((c) => !c.isIncluded)
        .sort((a, b) => a.keyOrdinal - b.keyOrdinal)
        .map((c) => `${q(c.columnName)}${c.isDescending ? " DESC" : ""}`);
    const select = columns.length === 0 ? "1 AS [row]" : columns.join(", ");
    return `SELECT ${select} FROM ${q(schemaName)}.${q(name)}${order && order.length > 0 ? ` ORDER BY ${order.join(", ")}` : ""}`;
}

/** INSERT statements of a table's rows, streamed: the request is paused while the text is written. */
export async function scriptTableData(
    pool: sql.ConnectionPool,
    model: text.TableModel,
    write: Write,
    signal: AbortSignal,
): Promise<void> {
    const columns = insertableColumns(model);
    const target = `${q(model.table.schemaName)}.${q(model.table.name)}`;
    const identity = columns.some((c) => c.isIdentity);
    const prefix =
        columns.length === 0
            ? `INSERT ${target} DEFAULT VALUES`
            : `INSERT ${target} (${columns.map((c) => q(c.name)).join(", ")}) VALUES (`;
    const variants = columns.map((c) => c.typeName === "sql_variant");

    const request = pool.request();
    request.stream = true;
    request.arrayRowMode = true;
    let infos: ColumnInfo[] = [];
    let metadata: MssqlColumn[] = [];
    let buffer: string[] = [];
    let rowCount = 0;
    let writing: Promise<void> = Promise.resolve();
    let failure: unknown;

    const flush = () => {
        if (buffer.length === 0) return;
        const chunk = buffer.join("");
        buffer = [];
        request.pause();
        writing = writing
            .then(() => write(chunk))
            .then(
                () => {
                    request.resume();
                },
                (error) => {
                    failure = error;
                    request.cancel();
                },
            );
    };

    const done = new Promise<void>((resolve, reject) => {
        request.on("recordset", (columnMetadata: MssqlColumn[]) => {
            metadata = columnMetadata;
            infos = columnMetadata.map(toColumnInfo);
        });
        request.on("row", (row: unknown[]) => {
            if (rowCount === 0 && identity) buffer.push(`SET IDENTITY_INSERT ${target} ON \nGO\n`);
            if (rowCount > 0 && rowCount % ROWS_PER_BATCH === 0) buffer.push("GO\n");
            rowCount++;
            if (columns.length === 0) {
                buffer.push(`${prefix}\n`);
            } else {
                const values = row.map((value, i) =>
                    variants[i]
                        ? value === null
                            ? "NULL"
                            : String(value)
                        : toSqlLiteral(formatCell(value, metadata[i]), infos[i]),
                );
                buffer.push(`${prefix}${values.join(", ")})\n`);
            }
            if (buffer.length >= ROWS_PER_WRITE) flush();
        });
        request.on("error", (error: Error) => reject(error));
        request.on("done", () => resolve());
    });

    const cancel = () => request.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
        request.query(dataQuery(model));
        await done.catch((error) => {
            if (!signal.aborted && failure === undefined) throw error;
        });
        await writing;
    } finally {
        signal.removeEventListener("abort", cancel);
    }
    if (failure !== undefined) throw failure;
    if (signal.aborted) throw abortError();
    if (rowCount > 0) {
        buffer.push("GO\n");
        if (identity) buffer.push(`SET IDENTITY_INSERT ${target} OFF\nGO\n`);
        await write(buffer.join(""));
    }
}
