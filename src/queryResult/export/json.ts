import type { CellValue, ColumnInfo } from "../../drivers/types";
import { formatWith, type ExportTable, type JsonOptions, type TextFormatWriter } from "./types";

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Formats a table as a JSON array of objects. Follows sqltoolsservice's
 * SaveAsJsonFileStreamWriter, i.e. Newtonsoft's Formatting.Indented (2 spaces)
 * with a custom line separator and no trailing separator.
 */
export function formatJson(table: ExportTable, options: JsonOptions): string {
    return formatWith(jsonWriter(table.columns, options), table.rows);
}

/** formatJson, piece by piece. */
export function jsonWriter(columns: ColumnInfo[], options: JsonOptions): TextFormatWriter {
    const sep = options.lineSeparator;
    let empty = true;
    const object = (row: (CellValue | undefined)[]) => {
        if (columns.length === 0) {
            return "  {}";
        }
        const props = columns.map(
            (column, i) => `    ${JSON.stringify(column.columnName)}: ${jsonValue(row[i], column)}`,
        );
        return ["  {", props.join("," + sep), "  }"].join(sep);
    };
    return {
        start: () => "",
        rows: (rows) => {
            let text = "";
            for (const row of rows) {
                text += (empty ? "[" + sep : "," + sep) + object(row);
                empty = false;
            }
            return text;
        },
        end: () => (empty ? "[]" : sep + "]"),
    };
}

function jsonValue(cell: CellValue | undefined, column: ColumnInfo): string {
    if (cell === undefined || cell.isNull) {
        return "null";
    }
    const text = cell.displayValue;
    if (column.kind === "number" && JSON_NUMBER.test(text)) {
        // Written raw to keep the precision of big decimals.
        return text;
    }
    if (column.kind === "boolean") {
        if (text === "1" || text === "true") {
            return "true";
        }
        if (text === "0" || text === "false") {
            return "false";
        }
    }
    return JSON.stringify(text);
}
