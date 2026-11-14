import type { CellValue, ColumnInfo } from "../../drivers/types";
import {
    formatWith,
    type ExportTable,
    type InClauseOptions,
    type InsertOptions,
    type SqlDialect,
    type TextFormatWriter,
} from "./types";

const BATCH_SIZE = 1000;
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Quotes an identifier only when needed. Follows SqlValueFormatter.EscapeIdentifier,
 * made engine-aware: `[...]` for SQL Server, `"..."` for PostgreSQL (which folds
 * unquoted names to lower case, so only `^[a-z_][a-z0-9_$]*$` is left bare).
 */
export function quoteIdentifier(name: string, dialect: SqlDialect): string {
    if (name === "") {
        return name;
    }
    if (dialect === "pg") {
        return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
    }
    return /^[A-Za-z_][A-Za-z0-9_@#$]*$/.test(name) ? name : `[${name.replace(/]/g, "]]")}]`;
}

/**
 * Formats one cell as a SQL literal. Replaces SqlValueFormatter.FormatValue, with
 * the string and binary syntax of the target engine.
 */
export function formatSqlLiteral(
    cell: CellValue | undefined,
    column: ColumnInfo,
    dialect: SqlDialect,
): string {
    if (cell === undefined || cell.isNull) {
        return "NULL";
    }
    const text = cell.displayValue;
    switch (column.kind) {
        case "number":
            return NUMERIC.test(text) ? text : quoteString(text, "pg");
        case "boolean":
            return text;
        case "binary":
            return dialect === "mssql" ? text : quoteString(text, "pg");
        default:
            return quoteString(text, dialect);
    }
}

function quoteString(text: string, dialect: SqlDialect): string {
    const body = `'${text.replace(/'/g, "''")}'`;
    return dialect === "mssql" ? "N" + body : body;
}

/**
 * Formats a table as batched INSERT statements (1000 rows each). Follows
 * sqltoolsservice's SaveAsInsertFileStreamWriter.
 */
export function formatInsert(table: ExportTable, options: InsertOptions): string {
    return formatWith(insertWriter(table.columns, options), table.rows);
}

/** formatInsert, piece by piece: holds at most one batch of 1000 rows. */
export function insertWriter(columns: ColumnInfo[], options: InsertOptions): TextFormatWriter {
    const sep = options.lineSeparator;
    const { dialect } = options;
    let head = "INSERT INTO " + quoteIdentifier(options.tableName, dialect);
    if (options.includeHeaders) {
        head += ` (${columns.map((c) => quoteIdentifier(c.columnName, dialect)).join(", ")})`;
    }
    head += sep + "VALUES" + sep;

    let batch: string[] = [];
    const flush = () => {
        const text = batch.length > 0 ? head + batch.join("," + sep) + ";" + sep + sep : "";
        batch = [];
        return text;
    };
    return {
        start: () => "",
        rows: (rows) => {
            let out = "";
            for (const row of rows) {
                const values = columns.map((c, i) => formatSqlLiteral(row[i], c, dialect));
                batch.push(`    (${values.join(", ")})`);
                if (batch.length === BATCH_SIZE) {
                    out += flush();
                }
            }
            return out;
        },
        end: flush,
    };
}

/**
 * Formats a single-column table as an IN clause. Follows CopyTextBuilder.BuildInCopyAsync.
 */
export function formatInClause(table: ExportTable, options: InClauseOptions): string {
    return formatWith(inClauseWriter(table.columns, options), table.rows);
}

/** formatInClause, piece by piece. */
export function inClauseWriter(columns: ColumnInfo[], options: InClauseOptions): TextFormatWriter {
    if (columns.length !== 1) {
        throw new Error("Copying as an IN clause requires selecting exactly one column.");
    }
    const sep = options.lineSeparator;
    const column = columns[0];
    let empty = true;
    return {
        start: () => "IN" + sep + "(" + sep,
        rows: (rows) => {
            let text = "";
            for (const row of rows) {
                if (row[0] === undefined) {
                    continue;
                }
                text +=
                    (empty ? "" : "," + sep) +
                    "    " +
                    formatSqlLiteral(row[0], column, options.dialect);
                empty = false;
            }
            return text;
        },
        end: () => (empty ? "" : sep) + ")" + sep,
    };
}
