import type { CellValue, ColumnInfo } from "../types";

/** "name", with double quotes doubled. */
export function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

const quoteString = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** Plain decimal or scientific notation; "NaN" and "Infinity" must be quoted. */
const isPlainNumber = (text: string) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text);

/** Renders a value as a literal, for INSERT scripts and IN (...) lists. */
export function toSqlLiteral(value: CellValue, column: ColumnInfo): string {
    if (value.isNull) return "NULL";
    const text = value.displayValue;
    switch (column.kind) {
        case "number":
            return isPlainNumber(text) ? text : quoteString(text);
        case "boolean":
            return text === "true" ? "TRUE" : "FALSE";
        case "binary":
            // displayValue is PostgreSQL's hex form: \x0102...
            return `${quoteString(text)}::bytea`;
        default:
            return quoteString(text);
    }
}
