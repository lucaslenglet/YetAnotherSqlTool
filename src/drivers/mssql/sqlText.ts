import type { CellValue, ColumnInfo } from "../types";
import { mssqlLanguage } from "./language";

/** [name], with "]" doubled. */
export function quoteIdentifier(name: string): string {
    return `[${name.replace(/]/g, "]]")}]`;
}

/** T-SQL's regular identifiers; @ and # are left out as first character (variables, temporary tables). */
const REGULAR_IDENTIFIER = /^[\p{L}_][\p{L}\p{Nd}_@$#]*$/u;

/** The name as written in a script: bracketed only when it is not a regular identifier or is reserved. */
export function formatIdentifier(name: string): string {
    return REGULAR_IDENTIFIER.test(name) && !mssqlLanguage.reservedKeywords.has(name.toUpperCase())
        ? name
        : quoteIdentifier(name);
}

/** 'text' with quotes doubled. */
function quoteString(text: string): string {
    return `'${text.replace(/'/g, "''")}'`;
}

/** Renders a grid value as a T-SQL literal, for INSERT scripts and IN (...) lists. */
export function toSqlLiteral(value: CellValue, column: ColumnInfo): string {
    if (value.isNull) return "NULL";
    const text = value.displayValue;

    if (column.dataTypeName === "uniqueidentifier") return quoteString(text);
    // "2024-01-02 03:04:05.000" is read as yyyy-dd-mm by datetime under some languages
    // (SET DATEFORMAT dmy); the ISO 8601 form with a T is read the same everywhere.
    if (column.dataTypeName === "datetime" || column.dataTypeName === "smalldatetime") {
        return quoteString(text.replace(" ", "T"));
    }

    switch (column.kind) {
        case "number":
        case "boolean": // displayed as 0 / 1, which is the literal for bit
        case "binary": // displayed as 0x...
            return text;
        case "datetime":
            return quoteString(text);
        default:
            return "N" + quoteString(text);
    }
}

/** The batch behind SSMS's Alt+F1: sp_help, with the selected text as its argument. */
export function spHelpBatch(objectName: string | undefined): string {
    return objectName === undefined ? "EXEC sp_help" : `EXEC sp_help N${quoteString(objectName)}`;
}
