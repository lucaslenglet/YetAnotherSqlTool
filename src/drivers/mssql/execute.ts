import * as sql from "mssql";
import {
    QUERY_CANCELED_MESSAGE,
    type Batch,
    type CellValue,
    type ExecuteEventHandler,
    type ExecutionPlanKind,
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

/** Name of the single column of the result set that carries a showplan (sqltoolsservice's YukonXmlShowPlanColumn). */
export const SHOWPLAN_COLUMN = "Microsoft SQL Server 2005 XML Showplan";

/**
 * Runs one batch for its execution plans, as sqltoolsservice does: `SET SHOWPLAN_XML ON` (the
 * statements are compiled, not run) or `SET STATISTICS XML ON` (they run, and each one's plan
 * follows its results), each alone in a batch before the user's, and the matching OFF after it,
 * also after an error or a cancellation. Each plan result set is reported as usual (the grid shows
 * it), followed by an `executionPlan` event with the text of its cell.
 */
export async function executeBatchForPlan(
    pool: sql.ConnectionPool,
    batch: Batch,
    kind: ExecutionPlanKind,
    onEvent: ExecuteEventHandler,
    signal: AbortSignal,
): Promise<void> {
    // Canceled before it starts: nothing is sent, the cancellation is reported as by `execute`.
    if (signal.aborted) return executeBatch(pool, batch, onEvent, signal);

    // ON, the batch and OFF run on ONE physical connection, taken from the pool once. The pool
    // replaces a broken connection with a new one, which has the option off: an estimated plan
    // sent there would run the batch. A pinned connection is never replaced; once broken, the
    // batch is not sent at all.
    const session = await PinnedConnection.acquire(pool);
    try {
        await runPinned(session, batch, kind, onEvent, signal);
    } finally {
        session.release();
    }
}

/** Message when the session's connection broke during a plan run (after the option was turned on). */
export const PLAN_CONNECTION_LOST_MESSAGE =
    "The connection to the server was lost during the execution plan run; nothing was sent on another connection.";

async function runPinned(
    session: PinnedConnection,
    batch: Batch,
    kind: ExecutionPlanKind,
    onEvent: ExecuteEventHandler,
    signal: AbortSignal,
): Promise<void> {
    const pool = session.asPool();
    const option = kind === "estimated" ? "SHOWPLAN_XML" : "STATISTICS XML";
    // The SET batches run to completion even when the user cancels: the session must not keep
    // the option on, and turning it on takes no time.
    const setOption = async (value: "ON" | "OFF"): Promise<boolean> => {
        let failed = false;
        await executeBatch(
            pool,
            { text: `SET ${option} ${value}`, startLine: batch.startLine },
            (event) => {
                if (event.type === "message" && event.isError) {
                    failed = true;
                    onEvent({ ...event, position: undefined });
                }
            },
            new AbortController().signal,
        );
        return !failed;
    };

    // If the option cannot be turned on, the batch must not run: an estimated plan would execute it.
    let turnedOn: boolean;
    try {
        turnedOn = await setOption("ON");
    } catch (error) {
        if (session.isUsable()) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${PLAN_CONNECTION_LOST_MESSAGE} ${reason}`);
    }
    if (!turnedOn) return;
    if (!session.isUsable()) {
        onEvent({ type: "message", text: PLAN_CONNECTION_LOST_MESSAGE, isError: true });
        return;
    }

    let plan: { xml?: string } | undefined;
    const forward: ExecuteEventHandler = (event) => {
        if (event.type === "resultSetStart") {
            const [first] = event.columns;
            const isPlan =
                event.columns.length === 1 &&
                first.columnName.toLowerCase() === SHOWPLAN_COLUMN.toLowerCase();
            plan = isPlan ? {} : undefined;
        } else if (
            event.type === "rows" &&
            plan &&
            plan.xml === undefined &&
            event.rows.length > 0
        ) {
            const cell = event.rows[0][0];
            // A NULL cell carries no plan.
            plan.xml = cell.isNull ? undefined : cell.displayValue;
            if (cell.isNull) plan = undefined;
        }
        const result = onEvent(event);
        if (event.type === "resultSetEnd" && plan) {
            if (plan.xml !== undefined) onEvent({ type: "executionPlan", content: plan.xml });
            plan = undefined;
        }
        return result;
    };

    let failure: unknown;
    try {
        await executeBatch(pool, batch, forward, signal);
    } catch (error) {
        failure = error;
    }
    // A broken connection is dropped by the pool, and a new one has the option off.
    if (session.isUsable()) {
        try {
            await setOption("OFF");
        } catch (error) {
            // The connection broke meanwhile: the batch's own error says more.
            failure ??= error;
        }
    }
    if (failure && !session.isUsable()) {
        // Lost before or while the batch was sent: tedious refuses a request on a closed connection.
        const reason = failure instanceof Error ? failure.message : String(failure);
        throw new Error(`${PLAN_CONNECTION_LOST_MESSAGE} ${reason}`);
    }
    if (failure) throw failure;
}

/** What mssql's tedious connection exposes that the pin looks at. */
interface TediousConnection {
    closed?: boolean;
    hasError?: boolean;
    state?: unknown;
    STATE?: { LOGGED_IN: unknown };
}

/** The members of mssql's ConnectionPool that its Request uses (not in the type definitions). */
interface PoolInternals {
    config: unknown;
    connected: boolean;
    collation?: unknown;
    acquire(requester: unknown): Promise<unknown>;
    release(connection: unknown): void;
}

/**
 * One physical connection of a pool, held for a sequence of requests. mssql's Request takes its
 * connection from its parent's `acquire` (as for a Transaction): this parent always gives the same
 * one, and refuses once it is broken, instead of letting the pool open another.
 */
class PinnedConnection {
    private constructor(
        private readonly pool: PoolInternals,
        private readonly connection: TediousConnection,
    ) {}

    static async acquire(pool: sql.ConnectionPool): Promise<PinnedConnection> {
        const internals = pool as unknown as PoolInternals;
        const connection = (await internals.acquire(pool)) as TediousConnection;
        return new PinnedConnection(internals, connection);
    }

    /** False once the connection is closed or failed: it is never reopened. */
    isUsable(): boolean {
        const c = this.connection;
        return !c.closed && !c.hasError && (c.STATE === undefined || c.state === c.STATE.LOGGED_IN);
    }

    release(): void {
        // A broken one stays free until the next acquire, where the pool validates it, destroys it
        // and opens another.
        this.pool.release(this.connection);
    }

    /** A Request parent (the pool's interface as mssql's Request uses it) bound to this connection. */
    asPool(): sql.ConnectionPool {
        const pool = this.pool;
        const pinned = {
            get config() {
                return pool.config;
            },
            get connected() {
                return pool.connected;
            },
            get collation() {
                return pool.collation;
            },
            acquire: (
                _request: unknown,
                callback: (error: Error | null, connection?: unknown, config?: unknown) => void,
            ) => {
                if (!this.isUsable()) {
                    setImmediate(
                        callback,
                        new sql.ConnectionError(PLAN_CONNECTION_LOST_MESSAGE, "ECONNCLOSED"),
                    );
                } else {
                    setImmediate(callback, null, this.connection, pool.config);
                }
                return pinned;
            },
            release: () => pinned,
        };
        return pinned as unknown as sql.ConnectionPool;
    }
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
