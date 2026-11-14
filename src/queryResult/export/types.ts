/**
 * Shared shapes of the result exports (copy as CSV/JSON/IN/INSERT, save as
 * CSV/JSON/Excel/INSERT).
 *
 * Plays the part of sqltoolsservice's DataStorage writers (SaveAs*FileStreamWriter,
 * CopyTextBuilder): the formatters here are pure functions, free of `vscode`, that
 * turn a projected table into text or bytes. The QueryManager picks the rows,
 * reads the settings and writes to the clipboard or to a file.
 */

import type { CellValue, ColumnInfo, DriverId } from "../../drivers/types";

/**
 * The cells to export, already cut down to the selection: `rows[i][j]` belongs to
 * `columns[j]`. A selected NULL has isNull = true; a cell inside the rectangle but
 * outside every selected range is `undefined` (CSV writes it empty, JSON/INSERT
 * write it as NULL, like CopyTextBuilder's treatUnselectedAsNull).
 */
export interface ExportTable {
    columns: ColumnInfo[];
    rows: (CellValue | undefined)[][];
}

/**
 * The same cells, read in chunks from the result store: a save of millions of rows streams
 * them to the file instead of holding the table.
 */
export interface ExportSource {
    columns: ColumnInfo[];
    /** Rows `chunks` yields in total. */
    rowCount: number;
    chunks(): AsyncIterable<(CellValue | undefined)[][]>;
}

/**
 * A text format written piece by piece: `start`, then `rows` for each chunk in order, then
 * `end`. Concatenating the pieces gives exactly what the whole-table formatter returns.
 */
export interface TextFormatWriter {
    start(): string;
    rows(rows: (CellValue | undefined)[][]): string;
    end(): string;
}

/** Writes a whole table with a writer. */
export function formatWith(writer: TextFormatWriter, rows: (CellValue | undefined)[][]): string {
    return writer.start() + writer.rows(rows) + writer.end();
}

/** Engine whose SQL syntax INSERT and IN use (identifier quoting, string literals). */
export type SqlDialect = DriverId;

export interface CsvOptions {
    includeHeaders: boolean;
    /** First character is used, as sqltoolsservice does. Default ",". */
    delimiter: string;
    /** Default: the editor's end of line. */
    lineSeparator: string;
    /** First character is used. Default '"'. */
    textIdentifier: string;
}

export interface JsonOptions {
    lineSeparator: string;
}

export interface InsertOptions {
    dialect: SqlDialect;
    /** Table name written after INSERT INTO; sqltoolsservice uses "TableName". */
    tableName: string;
    /** Writes the column list after the table name. */
    includeHeaders: boolean;
    lineSeparator: string;
}

export interface InClauseOptions {
    dialect: SqlDialect;
    lineSeparator: string;
}

export interface ExcelOptions {
    includeHeaders: boolean;
    freezeHeaderRow: boolean;
    boldHeaderRow: boolean;
    autoFilterHeaderRow: boolean;
    autoSizeColumns: boolean;
}
