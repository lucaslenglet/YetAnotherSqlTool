import type { CellValue, ColumnInfo } from "../../drivers/types";
import { formatWith, type CsvOptions, type ExportTable, type TextFormatWriter } from "./types";

/**
 * Formats a table as CSV. Follows sqltoolsservice's SaveAsCsvFileStreamWriter:
 * only the first character of the delimiter / text identifier is used, and every
 * line (the last one included) ends with the line separator.
 */
export function formatCsv(table: ExportTable, options: CsvOptions): string {
    return formatWith(csvWriter(table.columns, options), table.rows);
}

/** formatCsv, piece by piece. */
export function csvWriter(columns: ColumnInfo[], options: CsvOptions): TextFormatWriter {
    const delimiter = options.delimiter ? options.delimiter[0] : ",";
    const identifier = options.textIdentifier ? options.textIdentifier[0] : '"';
    const separator = options.lineSeparator;
    return {
        start: () =>
            options.includeHeaders
                ? columns
                      .map((c) => encodeCsvField(c.columnName, delimiter, identifier))
                      .join(delimiter) + separator
                : "",
        rows: (rows) => {
            let text = "";
            for (const row of rows) {
                text +=
                    row.map((cell) => encodeCsvCell(cell, delimiter, identifier)).join(delimiter) +
                    separator;
            }
            return text;
        },
        end: () => "",
    };
}

/** A selected NULL is written as NULL, an unselected cell as an empty field. */
function encodeCsvCell(cell: CellValue | undefined, delimiter: string, identifier: string): string {
    if (cell === undefined) {
        return "";
    }
    if (cell.isNull) {
        return "NULL";
    }
    return encodeCsvField(cell.displayValue, delimiter, identifier);
}

/** SaveAsCsvFileStreamWriter.EncodeCsvField. */
function encodeCsvField(field: string, delimiter: string, identifier: string): string {
    const escaped = field.split(identifier).join(identifier + identifier);
    const needsQuotes =
        field.includes(delimiter) ||
        field.includes("\r") ||
        field.includes("\n") ||
        field.includes(identifier) ||
        field.startsWith(" ") ||
        field.endsWith(" ") ||
        field.startsWith("\t") ||
        field.endsWith("\t");
    return needsQuotes ? identifier + escaped + identifier : escaped;
}
