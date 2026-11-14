import * as sql from "mssql";
import {
    QUERY_CANCELED_MESSAGE,
    type Batch,
    type CellValue,
    type ExecuteEventHandler,
} from "../types";
import { formatCell, toColumnInfo, type MssqlColumn } from "./formatting";

const ROWS_PER_CHUNK = 500;

// Column names SQL Server gives to the single column of an unnamed FOR XML / FOR JSON result.
const XML_COLUMN_ID = "XML_F52E2B61-18A1-11d1-B105-00805F49916B";
const JSON_COLUMN_ID = "JSON_F52E2B61-18A1-11d1-B105-00805F49916B";

/** Error codes (mssql RequestError.code) that mean "the query ran and failed", not "the connection is broken". */
const QUERY_ERROR_CODES = new Set(["EREQUEST", "ETIMEOUT", "ECANCEL"]);

/** Fields mssql adds to the errors and info messages it emits for a request. */
interface ServerMessage {
    message: string;
    number?: number;
    state?: number;
    class?: number;
    lineNumber?: number;
    procName?: string;
    code?: string;
}

/**
 * Runs one batch on the pool's connection and reports progress through `onEvent`.
 * Server errors become error messages; only a broken connection rejects.
 */
export async function executeBatch(
    pool: sql.ConnectionPool,
    batch: Batch,
    onEvent: ExecuteEventHandler,
    signal: AbortSignal,
): Promise<void> {
    const request = new sql.Request(pool);
    request.stream = true;
    request.arrayRowMode = true;

    // Backpressure: while the extension stores rows, tedious stops parsing the server's response
    // (no event at all, so messages keep their order) and stops reading the socket.
    let waits = 0;
    const reporter = new BatchReporter(onEvent, (wait) => {
        if (waits++ === 0) request.pause();
        const settle = () => {
            if (--waits === 0) request.resume();
        };
        return wait.then(settle, settle);
    });
    if (signal.aborted) {
        reporter.reportCanceled();
        return;
    }

    let connectionError: Error | undefined;
    request.on("recordset", (columns: MssqlColumn[]) => reporter.startResultSet(columns));
    request.on("row", (row: unknown[] | Record<string, unknown>) => reporter.addRow(row));
    request.on("rowsaffected", (count: number) => reporter.finishStatement(count));
    request.on("info", (info: ServerMessage) => reporter.reportInfo(info));
    request.on("error", (error: ServerMessage) => {
        if (signal.aborted) return; // the cancellation is reported once, below
        if (error.code && !QUERY_ERROR_CODES.has(error.code)) connectionError = toError(error);
        else reporter.reportError(error);
    });

    let canceled = false;
    const cancel = () => {
        canceled = true;
        request.cancel();
    };
    signal.addEventListener("abort", cancel, { once: true });

    try {
        await new Promise<void>((resolve) => {
            request.on("done", () => resolve());
            // batch() sends the text as is (no sp_executesql), so USE, SET and #temp tables behave like in SSMS.
            request.batch(batch.text);
        });
    } finally {
        signal.removeEventListener("abort", cancel);
    }

    reporter.closeResultSet();
    await reporter.settled();
    if (connectionError) throw connectionError;
    if (canceled) reporter.reportCanceled();
}

/** Turns the raw events of one request into ExecuteEvents, keeping the current result set's state. */
class BatchReporter {
    private columns: MssqlColumn[] | undefined;
    private pendingRows: CellValue[][] = [];
    private rowCount = 0;
    private lastErrorKey = "";
    /** Row count of a FOR XML / FOR JSON statement, reported once its (late) single row has arrived. */
    private deferredRowCount: number | undefined;
    private waiting: Promise<void> = Promise.resolve();

    constructor(
        private readonly emit: ExecuteEventHandler,
        /** Holds the request until `wait` settles; returns a promise settled after that. */
        private readonly hold: (wait: Promise<void>) => Promise<void>,
    ) {}

    /** Resolves once the consumer has taken every row reported so far. */
    settled(): Promise<void> {
        return this.waiting;
    }

    startResultSet(columns: MssqlColumn[]): void {
        this.closeResultSet();
        this.columns = columns;
        this.rowCount = 0;
        this.emit({ type: "resultSetStart", columns: columns.map(toColumnInfo) });
    }

    addRow(row: unknown[] | Record<string, unknown>): void {
        const columns = this.columns;
        if (!columns) return;
        // FOR XML / FOR JSON results arrive as an object with a single property instead of an array.
        const values = Array.isArray(row) ? row : Object.values(row);
        this.pendingRows.push(values.map((value, index) => formatCell(value, columns[index])));
        this.rowCount++;
        if (this.pendingRows.length >= ROWS_PER_CHUNK) this.flushRows();
        if (this.deferredRowCount !== undefined) this.closeResultSet();
    }

    /** A statement finished (SELECT, INSERT, UPDATE...): close its result set, then print "(N rows affected)". */
    finishStatement(count: number): void {
        // mssql reports the "done" of a FOR XML / FOR JSON statement BEFORE emitting its single row.
        if (this.isXmlOrJsonResult() && this.rowCount === 0) {
            this.deferredRowCount = count;
            return;
        }
        this.closeResultSet();
        this.emitRowsAffected(count);
    }

    /** Ends the current result set (if any) and prints the deferred "(N rows affected)" of a FOR XML / FOR JSON statement. */
    closeResultSet(): void {
        if (this.columns) {
            this.flushRows();
            this.emit({ type: "resultSetEnd", rowCount: this.rowCount });
            this.columns = undefined;
        }
        if (this.deferredRowCount !== undefined) {
            const count = this.deferredRowCount;
            this.deferredRowCount = undefined;
            this.emitRowsAffected(count);
        }
    }

    reportInfo(info: ServerMessage): void {
        this.emit({ type: "message", text: info.message, isError: false });
    }

    reportError(error: ServerMessage): void {
        // mssql can report the same server error twice (once from the message, once from the request).
        const key = `${error.number}|${error.lineNumber}|${error.message}`;
        if (key === this.lastErrorKey) return;
        this.lastErrorKey = key;

        const isServerError = error.number !== undefined;
        if (!isServerError) {
            this.emit({ type: "message", text: error.message, isError: true });
            return;
        }
        const procedure = error.procName ? `Procedure ${error.procName}, ` : "";
        const header = `Msg ${error.number}, Level ${error.class}, State ${error.state}, ${procedure}Line ${error.lineNumber}`;
        this.emit({
            type: "message",
            text: `${header}\n${error.message}`,
            isError: true,
            // A line number inside a stored procedure is relative to the procedure, not to the batch.
            position: error.procName
                ? undefined
                : { line: Math.max((error.lineNumber ?? 1) - 1, 0), column: 0 },
        });
    }

    reportCanceled(): void {
        this.closeResultSet();
        this.emit({ type: "message", text: QUERY_CANCELED_MESSAGE, isError: true });
    }

    private emitRowsAffected(count: number): void {
        this.emit({
            type: "message",
            text: `(${count} ${count === 1 ? "row" : "rows"} affected)`,
            isError: false,
            rowsAffected: count,
        });
    }

    private isXmlOrJsonResult(): boolean {
        const name = this.columns?.length === 1 ? this.columns[0].name : "";
        return name === XML_COLUMN_ID || name === JSON_COLUMN_ID;
    }

    private flushRows(): void {
        if (this.pendingRows.length === 0) return;
        const wait = this.emit({ type: "rows", rows: this.pendingRows });
        this.pendingRows = [];
        // Only a promise asks to wait (a handler may return anything else, e.g. `array.push`).
        if (wait instanceof Promise) {
            const held = this.hold(wait);
            this.waiting = this.waiting.then(() => held);
        }
    }
}

function toError(error: ServerMessage): Error {
    return error instanceof Error ? error : new Error(error.message);
}
