/**
 * Runs the SQL of one editor on its connection and keeps the results.
 *
 * Plays the part that sqltoolsservice plays for vscode-mssql's QueryRunner: the
 * script is split into batches by the driver, each batch is executed with the
 * driver's streaming `execute`, and the rows are kept here so the grid can page
 * through them (`getRows`), copy them and summarize a selection. Rows go to a RowStore, which
 * moves large results to a file as sqltoolsservice does. Events carry the
 * same shapes as sqltoolsservice's notifications (ResultSetSummary, IMessage), so
 * the code driving the webview stays close to vscode-mssql's.
 */

import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import type {
    Batch,
    CellValue,
    ColumnInfo,
    Driver,
    DriverConnection,
    DriverId,
    ExecuteEvent,
    ExecutionPlanKind,
    TextPosition,
} from "../drivers/types";
import { QUERY_CANCELED_MESSAGE } from "../drivers/types";
import type { ExportSource } from "../queryResult/export/types";
import {
    DbCellValue,
    IDbColumn,
    IMessage,
    ISelectionData,
    ISlickRange,
    ResultSetSubset,
    ResultSetSummary,
    SelectionSummaryMetrics,
} from "../sharedInterfaces/queryResult";
import { createErrorMessageNavigation } from "../queryResult/messageLinks";
import { getErrorMessage } from "../utils/utils";
import { createRowStore, type RowStore } from "./rowStore";

export interface QueryCompleteEvent {
    totalElapsedMilliseconds: number;
    hasError: boolean;
    isCanceled: boolean;
}

/** A plan document reported by the driver during a run for plans (`executeForPlan`). */
export interface ExecutionPlanEvent {
    batchId: number;
    /** Result set the driver also showed the document in (the event follows its end), if any. */
    resultId?: number;
    /** Plans of the batch so far, this one included: tells apart plans without result set. */
    planIndex: number;
    /** The document, as `Driver.executionPlan.parse` reads it. */
    content: string;
}

export interface BatchStartEvent {
    batchId: number;
    /** Position of the batch in the editor; absent for a run that is not text of the editor. */
    selection?: ISelectionData;
}

interface StoredResultSet {
    summary: ResultSetSummary;
    columns: ColumnInfo[];
    rows: RowStore;
}

/**
 * Upper bound of the text a copy may build for the clipboard. sqltoolsservice has none, but the
 * text is held whole in memory and sent to VS Code's clipboard; above this, Save as streams to a file.
 */
export const MAX_COPY_CHARACTERS = 50_000_000;

/** Thrown when a copy would exceed `MAX_COPY_CHARACTERS`. */
export class CopyTooLargeError extends Error {
    constructor(public readonly limit: number) {
        super(LocalizedConstants.copyResultsTooLarge(Math.round(limit / 1_000_000)));
    }
}

/** Thrown when a long copy or summary was canceled or superseded. */
export class OperationCanceledError extends Error {}

export interface ChunkedOperationOptions {
    /** Checked between chunks; returning true stops the operation with OperationCanceledError. */
    isCanceled?: () => boolean;
}

export class QueryRunner implements vscode.Disposable {
    private _resultSets: StoredResultSet[][] = [];
    private _isExecuting = false;
    private _isCanceled = false;
    private _abort: AbortController | undefined;
    private _storageError: unknown;
    /** Engine of the last run: INSERT and IN exports follow its SQL syntax. */
    public dialect: DriverId = "mssql";
    /** Plans the last run asked for (vscode-mssql's QueryRunner.executionPlanOptions). */
    public executionPlanKind: ExecutionPlanKind | undefined;

    private readonly _onStart = new vscode.EventEmitter<void>();
    public readonly onStart = this._onStart.event;
    private readonly _onBatchStart = new vscode.EventEmitter<BatchStartEvent>();
    public readonly onBatchStart = this._onBatchStart.event;
    private readonly _onResultSetAvailable = new vscode.EventEmitter<ResultSetSummary>();
    public readonly onResultSetAvailable = this._onResultSetAvailable.event;
    private readonly _onResultSetUpdated = new vscode.EventEmitter<ResultSetSummary>();
    public readonly onResultSetUpdated = this._onResultSetUpdated.event;
    private readonly _onResultSetComplete = new vscode.EventEmitter<ResultSetSummary>();
    public readonly onResultSetComplete = this._onResultSetComplete.event;
    private readonly _onMessage = new vscode.EventEmitter<IMessage>();
    public readonly onMessage = this._onMessage.event;
    private readonly _onComplete = new vscode.EventEmitter<QueryCompleteEvent>();
    public readonly onComplete = this._onComplete.event;
    private readonly _onExecutionPlan = new vscode.EventEmitter<ExecutionPlanEvent>();
    public readonly onExecutionPlan = this._onExecutionPlan.event;

    /**
     * `newRowStore` gives each result set its store; the default one stays in memory (the
     * extension passes one that spills to the result files of the window).
     */
    constructor(
        public uri: string,
        public title: string,
        private readonly newRowStore: () => RowStore = () => createRowStore(),
    ) {}

    public get isExecuting(): boolean {
        return this._isExecuting;
    }

    public get isCanceled(): boolean {
        return this._isCanceled;
    }

    /**
     * Runs `text`, which starts at `start` in the editor (0-based line and column).
     * Resolves when every batch is done, failed or was canceled. With `executionPlan`, each batch
     * goes through the driver's `executeForPlan`, which also reports the plans (onExecutionPlan).
     */
    public run(
        driver: Driver,
        connection: DriverConnection,
        text: string,
        start: { line: number; column: number },
        executionPlan?: ExecutionPlanKind,
    ): Promise<void> {
        const executeForPlan = connection.executeForPlan?.bind(connection);
        if (executionPlan && !executeForPlan) {
            return Promise.reject(new Error(`${driver.id} has no execution plans`));
        }
        return this.runWith(driver, executionPlan, async (signal) => {
            let hasError = false;
            const batches = driver.splitBatches(text);
            if (batches.length === 0) {
                // Nothing to run (no statement at the cursor): sqltoolsservice says so all the same.
                this.fireMessage({
                    message: LocalizedConstants.commandsCompletedSuccessfully,
                    isError: false,
                    batchId: undefined,
                });
            }
            for (let batchId = 0; batchId < batches.length && !signal.aborted; batchId++) {
                const batch = batches[batchId];
                const batchHasError = await this.runBatch(batchId, batch, start, (onEvent) =>
                    executionPlan
                        ? executeForPlan!(batch, executionPlan, onEvent, signal)
                        : connection.execute(batch, onEvent, signal),
                );
                hasError ||= batchHasError;
            }
            return hasError;
        });
    }

    /**
     * Shows the information about an object (SSMS's Alt+F1). Same life cycle and storage as `run`, but
     * the output comes from one driver call, so it has no position in the editor.
     */
    public runObjectInformation(
        driver: Driver,
        connection: DriverConnection,
        objectName: string | undefined,
    ): Promise<void> {
        return this.runWith(driver, undefined, (signal) =>
            this.runCall(0, undefined, undefined, (onEvent) =>
                connection.describeObject(objectName, onEvent, signal),
            ),
        );
    }

    /** What every run has in common: state, events, timing, cancel. `body` returns whether an error occurred. */
    private async runWith(
        driver: Driver,
        executionPlan: ExecutionPlanKind | undefined,
        body: (signal: AbortSignal) => Promise<boolean>,
    ): Promise<void> {
        if (this._isExecuting) {
            return;
        }
        this._isExecuting = true;
        this._isCanceled = false;
        this._storageError = undefined;
        this.disposeResultSets();
        this.dialect = driver.id;
        this.executionPlanKind = executionPlan;
        this._abort = new AbortController();
        const signal = this._abort.signal;
        const startTime = Date.now();
        let hasError = false;

        this._onStart.fire();
        try {
            hasError = await body(signal);
        } catch (error) {
            // splitBatches or the connection itself failed.
            hasError = true;
            this.fireMessage({
                message: getErrorMessage(error),
                isError: true,
                batchId: undefined,
            });
        } finally {
            this._isExecuting = false;
            this._abort = undefined;
            this._onComplete.fire({
                totalElapsedMilliseconds: Date.now() - startTime,
                hasError,
                isCanceled: this._isCanceled,
            });
        }
    }

    /** Releases the rows (and files) of the previous results. */
    private disposeResultSets(): void {
        for (const batch of this._resultSets) {
            for (const resultSet of batch ?? []) {
                void resultSet.rows.dispose();
            }
        }
        this._resultSets = [];
    }

    /**
     * The rows could not be stored (disk full, no permission...): reports it, and stops the run
     * like a cancel. The rows stored so far stay readable.
     */
    private onStorageError(batchId: number, error: unknown): void {
        if (this._storageError) {
            return;
        }
        this._storageError = error;
        this.fireMessage({
            batchId,
            message: LocalizedConstants.resultsStorageFailed(getErrorMessage(error)),
            isError: true,
        });
        this._abort?.abort();
    }

    /** Asks the driver to cancel the running statement; `run` resolves soon after. */
    public cancel(): void {
        if (this._isExecuting && this._abort) {
            this._isCanceled = true;
            this._abort.abort();
        }
    }

    private async runBatch(
        batchId: number,
        batch: Batch,
        start: { line: number; column: number },
        execute: (onEvent: (event: ExecuteEvent) => void | Promise<void>) => Promise<void>,
    ): Promise<boolean> {
        const batchLines = batch.text.split("\n");
        const firstLine = start.line + batch.startLine;
        const firstColumn = batch.startLine === 0 ? start.column : 0;
        const lastLine = firstLine + batchLines.length - 1;
        const selection: ISelectionData = {
            startLine: firstLine,
            startColumn: firstColumn,
            endLine: lastLine,
            endColumn:
                batchLines[batchLines.length - 1].length +
                (lastLine === firstLine ? firstColumn : 0),
        };
        const toAbsolute = (position: TextPosition): ISelectionData => {
            const line = firstLine + position.line;
            const column = position.line === 0 ? firstColumn + position.column : position.column;
            const lineText = batchLines[position.line] ?? "";
            return {
                startLine: line,
                startColumn: column,
                endLine: line,
                endColumn:
                    (position.line === 0 ? firstColumn : 0) + lineText.replace(/\r$/, "").length,
            };
        };
        return this.runCall(batchId, selection, toAbsolute, execute);
    }

    /**
     * Runs one call that reports `ExecuteEvent`s (a batch, or the driver's object information) as
     * batch `batchId`. Without `toAbsolute`, messages are not tied to lines of the editor.
     */
    private async runCall(
        batchId: number,
        selection: ISelectionData | undefined,
        toAbsolute: ((position: TextPosition) => ISelectionData) | undefined,
        call: (onEvent: (event: ExecuteEvent) => void | Promise<void>) => Promise<void>,
    ): Promise<boolean> {
        this._onBatchStart.fire({ batchId, selection });

        const batchStartTime = Date.now();
        const resultSets: StoredResultSet[] = [];
        this._resultSets[batchId] = resultSets;
        let current: StoredResultSet | undefined;
        /** The result set that just ended, which a plan event right after belongs to. */
        let ended: StoredResultSet | undefined;
        let planCount = 0;
        let hasError = false;
        let hasOutput = false;

        try {
            await call((event): void | Promise<void> => {
                const previous = ended;
                ended = undefined;
                switch (event.type) {
                    case "resultSetStart": {
                        hasOutput = true;
                        current = {
                            columns: event.columns,
                            rows: this.newRowStore(),
                            summary: {
                                id: resultSets.length,
                                batchId,
                                rowCount: 0,
                                columnInfo: event.columns.map(toDbColumn),
                                complete: false,
                            },
                        };
                        resultSets.push(current);
                        this._onResultSetAvailable.fire(current.summary);
                        break;
                    }
                    case "rows": {
                        if (!current || this._storageError) {
                            break;
                        }
                        let stored: void | Promise<void>;
                        try {
                            stored = current.rows.append(event.rows);
                        } catch (error) {
                            this.onStorageError(batchId, error);
                            hasError = true;
                            break;
                        }
                        current.summary.rowCount = current.rows.rowCount;
                        this._onResultSetUpdated.fire(current.summary);
                        // The driver waits for the store before reading more rows (backpressure).
                        if (!stored) {
                            break;
                        }
                        return stored.catch((error) => {
                            this.onStorageError(batchId, error);
                            hasError = true;
                        });
                    }
                    case "resultSetEnd": {
                        if (!current) {
                            break;
                        }
                        current.summary.rowCount = current.rows.rowCount;
                        current.summary.complete = true;
                        this._onResultSetComplete.fire(current.summary);
                        ended = current;
                        current = undefined;
                        break;
                    }
                    case "executionPlan": {
                        hasOutput = true;
                        this._onExecutionPlan.fire({
                            batchId,
                            resultId: previous?.summary.id,
                            planIndex: planCount++,
                            content: event.content,
                        });
                        break;
                    }
                    case "message": {
                        // After a storage error the driver reports the stop as a cancel by the user: it was not.
                        if (this._storageError && event.text === QUERY_CANCELED_MESSAGE) {
                            break;
                        }
                        hasOutput = true;
                        hasError ||= event.isError;
                        const errorSelection =
                            event.position && toAbsolute ? toAbsolute(event.position) : undefined;
                        this.fireMessage({
                            batchId,
                            message: errorSelection
                                ? withAbsoluteLine(
                                      event.text,
                                      event.position!.line,
                                      errorSelection.startLine,
                                  )
                                : event.text,
                            isError: event.isError,
                            rowsAffected: event.rowsAffected,
                            selection: errorSelection,
                        });
                        break;
                    }
                }
            });
        } catch (error) {
            // The connection failed (network, server shutdown...): stop here.
            hasError = true;
            this.fireMessage({ batchId, message: getErrorMessage(error), isError: true });
            this.cancel();
        }

        // A result set cut short by an error or a cancel never gets its end event.
        if (current) {
            current.summary.complete = true;
            this._onResultSetComplete.fire(current.summary);
        }

        const config = vscode.workspace.getConfiguration(Constants.extensionConfigSectionName);
        if (
            !hasOutput &&
            !hasError &&
            config.get<boolean>(Constants.configResultsShowBatchMessages, true)
        ) {
            this.fireMessage({
                batchId,
                message: LocalizedConstants.commandsCompletedSuccessfully,
                isError: false,
            });
        }
        if (config.get<boolean>(Constants.configShowBatchTime, false)) {
            this.fireMessage({
                batchId,
                message: LocalizedConstants.elapsedBatchTime(
                    formatClock(Date.now() - batchStartTime),
                ),
                isError: false,
            });
        }
        return hasError;
    }

    private fireMessage(message: Omit<IMessage, "time">): void {
        const full: IMessage = { ...message, time: new Date().toLocaleTimeString() };
        if (message.isError && message.selection) {
            const lineText = LocalizedConstants.runQueryBatchStartLine(
                message.selection.startLine + 1,
            );
            const navigation =
                createErrorMessageNavigation(full.message, message.selection, this.uri) ??
                (full.message.includes(lineText)
                    ? { link: { text: lineText, uri: this.uri }, selection: message.selection }
                    : undefined);
            full.link = navigation?.link;
            full.selection = navigation?.selection;
        }
        this._onMessage.fire(full);
    }

    // -- stored results ---------------------------------------------------------

    public getResultSet(batchId: number, resultId: number): StoredResultSet | undefined {
        return this._resultSets[batchId]?.[resultId];
    }

    public async getRows(
        batchId: number,
        resultId: number,
        rowStart: number,
        numberOfRows: number,
    ): Promise<ResultSetSubset> {
        const resultSet = this.getResultSet(batchId, resultId);
        if (!resultSet) {
            return { rowCount: 0, rows: [] };
        }
        const rows: DbCellValue[][] = (await resultSet.rows.getRows(rowStart, numberOfRows)).map(
            (row, i) => row.map((cell) => ({ ...cell, rowId: rowStart + i })),
        );
        return { rowCount: rows.length, rows };
    }

    /**
     * Text copy of a selection: tab-separated cells, one line per row. Rows are
     * copied once even when ranges overlap; cells of a copied row that are outside
     * every range stay empty (vscode-mssql's copyResultsPreservingSelectionLayout).
     * Throws CopyTooLargeError beyond `maxLength` characters.
     */
    public async getSelectionAsText(
        batchId: number,
        resultId: number,
        selection: ISlickRange[],
        includeHeaders: boolean,
        removeNewLines: boolean,
        eol: string,
        options: ChunkedOperationOptions & { maxLength?: number } = {},
    ): Promise<string> {
        const resultSet = this.getResultSet(batchId, resultId);
        if (!resultSet || selection.length === 0) {
            return "";
        }
        const maxLength = options.maxLength ?? MAX_COPY_CHARACTERS;
        const columns = selectedColumns(selection, Number.POSITIVE_INFINITY);
        const parts: string[] = [];
        let length = 0;
        const add = (line: string) => {
            length += line.length + eol.length;
            if (length > maxLength) {
                throw new CopyTooLargeError(maxLength);
            }
            parts.push(line);
        };
        if (includeHeaders) {
            add(columns.map((c) => resultSet.columns[c]?.columnName ?? "").join("\t"));
        }
        for await (const { row, cells } of projectRows(resultSet.rows, selection, options)) {
            add(
                columns
                    .map((column) => {
                        if (!isSelected(selection, row, column)) {
                            return "";
                        }
                        const value = cells[column]?.displayValue ?? "";
                        return removeNewLines ? value.replace(/\r\n|\r|\n/g, " ") : value;
                    })
                    .join("\t"),
            );
        }
        return parts.join(eol);
    }

    /**
     * Cells to export (copy as / save as), read from the store as they are written. Without a
     * selection, the whole result set. With one, the rows and columns any range covers, in grid
     * order; cells of that rectangle outside every range are `undefined` (sqltoolsservice's
     * BuildRowProjection).
     */
    public getExportSource(
        batchId: number,
        resultId: number,
        selection?: ISlickRange[],
        options: ChunkedOperationOptions = {},
    ): ExportSource | undefined {
        const resultSet = this.getResultSet(batchId, resultId);
        if (!resultSet) {
            return undefined;
        }
        const store = resultSet.rows;
        if (!selection || selection.length === 0) {
            return {
                columns: resultSet.columns,
                rowCount: store.rowCount,
                async *chunks() {
                    for await (const chunk of store.iterate()) {
                        throwIfCanceled(options);
                        yield chunk;
                    }
                },
            };
        }
        const columns = selectedColumns(selection, resultSet.columns.length);
        return {
            columns: columns.map((c) => resultSet.columns[c]),
            rowCount: selectedRowCount(selection, store.rowCount),
            async *chunks() {
                let chunk: (CellValue | undefined)[][] = [];
                for await (const { row, cells } of projectRows(store, selection, options)) {
                    chunk.push(
                        columns.map((column) =>
                            isSelected(selection, row, column) ? cells[column] : undefined,
                        ),
                    );
                    if (chunk.length >= 1000) {
                        yield chunk;
                        chunk = [];
                    }
                }
                if (chunk.length > 0) {
                    yield chunk;
                }
            },
        };
    }

    /** Number of rows the selection covers (rows of overlapping ranges count once). */
    public getSelectedRowCount(
        batchId: number,
        resultId: number,
        selection: ISlickRange[],
    ): number {
        const resultSet = this.getResultSet(batchId, resultId);
        return resultSet ? selectedRowCount(selection, resultSet.rows.rowCount) : 0;
    }

    /** Names of the columns covered by the selection, tab-separated (vscode-mssql's copyHeaders). */
    public getSelectionHeaders(
        batchId: number,
        resultId: number,
        selection: ISlickRange[],
    ): string {
        const resultSet = this.getResultSet(batchId, resultId);
        if (!resultSet || selection.length === 0) {
            return "";
        }
        const first = Math.min(...selection.map((r) => r.fromCell));
        const last = Math.max(...selection.map((r) => r.toCell));
        return resultSet.columns
            .slice(first, last + 1)
            .map((c) => c.columnName)
            .join("\t");
    }

    /**
     * Statistics of the selected cells, as sqltoolsservice's GridSelectionSummary:
     * count, distinct and NULL counts, plus sum/average/min/max over the numeric cells.
     * Reads the rows in chunks and lets the extension host breathe between them; throws
     * OperationCanceledError when `isCanceled` says so (a newer selection, a click on cancel).
     */
    public async getSelectionSummary(
        batchId: number,
        resultId: number,
        selection: ISlickRange[],
        options: ChunkedOperationOptions = {},
    ): Promise<SelectionSummaryMetrics> {
        const resultSet = this.getResultSet(batchId, resultId);
        const metrics: SelectionSummaryMetrics = { count: 0, distinctCount: 0, nullCount: 0 };
        if (!resultSet) {
            return metrics;
        }
        const distinct = new Set<string>();
        let numericCount = 0;
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        for await (const { cells, ranges } of projectRows(resultSet.rows, selection, options)) {
            for (let column = 0; column < cells.length; column++) {
                if (!ranges.some((r) => column >= r.fromCell && column <= r.toCell)) continue;
                const cell = cells[column];
                metrics.count++;
                if (cell.isNull) {
                    metrics.nullCount++;
                    continue;
                }
                distinct.add(cell.displayValue);
                const value = cell.displayValue.trim() === "" ? NaN : Number(cell.displayValue);
                if (Number.isFinite(value)) {
                    numericCount++;
                    sum += value;
                    min = Math.min(min, value);
                    max = Math.max(max, value);
                }
            }
        }
        metrics.distinctCount = distinct.size;
        if (numericCount > 0) {
            metrics.sum = sum;
            metrics.average = sum / numericCount;
            metrics.min = min;
            metrics.max = max;
        }
        return metrics;
    }

    public dispose(): void {
        this.cancel();
        this.disposeResultSets();
        this._onStart.dispose();
        this._onBatchStart.dispose();
        this._onResultSetAvailable.dispose();
        this._onResultSetUpdated.dispose();
        this._onResultSetComplete.dispose();
        this._onMessage.dispose();
        this._onComplete.dispose();
        this._onExecutionPlan.dispose();
    }
}

// -- selections over a store -----------------------------------------------------

function isSelected(selection: ISlickRange[], row: number, column: number): boolean {
    return selection.some(
        (r) => row >= r.fromRow && row <= r.toRow && column >= r.fromCell && column <= r.toCell,
    );
}

/** Columns any range covers, sorted, below `columnCount`. */
function selectedColumns(selection: ISlickRange[], columnCount: number): number[] {
    const columns = new Set<number>();
    for (const range of selection) {
        for (let c = range.fromCell; c <= Math.min(range.toCell, columnCount - 1); c++) {
            columns.add(c);
        }
    }
    return [...columns].sort((a, b) => a - b);
}

/** Rows any range covers, as sorted, disjoint [start, end) intervals below `rowCount`. */
function selectedRowIntervals(selection: ISlickRange[], rowCount: number): [number, number][] {
    const intervals = selection
        .map((r): [number, number] => [Math.max(r.fromRow, 0), Math.min(r.toRow + 1, rowCount)])
        .filter(([start, end]) => start < end)
        .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const interval of intervals) {
        const last = merged[merged.length - 1];
        if (last && interval[0] <= last[1]) {
            last[1] = Math.max(last[1], interval[1]);
        } else {
            merged.push([...interval]);
        }
    }
    return merged;
}

function selectedRowCount(selection: ISlickRange[], rowCount: number): number {
    return selectedRowIntervals(selection, rowCount).reduce(
        (n, [start, end]) => n + end - start,
        0,
    );
}

function throwIfCanceled(options: ChunkedOperationOptions): void {
    if (options.isCanceled?.()) {
        throw new OperationCanceledError();
    }
}

/**
 * Every row the selection covers, once, in order, with the ranges that cover it. Reads the store
 * in chunks; between two chunks, checks for a cancel and yields to the event loop so that a
 * selection of millions of cells does not freeze the extension host.
 */
async function* projectRows(
    store: RowStore,
    selection: ISlickRange[],
    options: ChunkedOperationOptions,
): AsyncIterable<{ row: number; cells: CellValue[]; ranges: ISlickRange[] }> {
    for (const [start, end] of selectedRowIntervals(selection, store.rowCount)) {
        let row = start;
        for await (const chunk of store.iterate(start, end)) {
            throwIfCanceled(options);
            for (const cells of chunk) {
                const ranges = selection.filter((r) => row >= r.fromRow && row <= r.toRow);
                yield { row, cells, ranges };
                row++;
            }
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
}

/** IDbColumn as sqltoolsservice fills it, from what the driver knows. */
function toDbColumn(column: ColumnInfo, ordinal: number): IDbColumn {
    return {
        columnName: column.columnName,
        columnOrdinal: ordinal,
        dataType: column.dataTypeName,
        dataTypeName: column.dataTypeName,
        allowDBNull: column.allowDBNull,
        baseCatalogName: "",
        baseColumnName: column.columnName,
        baseSchemaName: column.baseSchemaName ?? "",
        baseServerName: "",
        baseTableName: column.baseTableName ?? "",
        udtAssemblyQualifiedName: "",
        isIdentity: column.isIdentity,
        isXml: column.isXml ?? column.kind === "xml",
        isJson: column.isJson ?? column.kind === "json",
        isBytes: column.isBytes ?? column.kind === "binary",
        isChars: column.kind === "string",
    };
}

/**
 * Makes the line of an error message refer to the editor instead of the batch.
 * SQL Server headers end with "Line N" (relative to the batch): N is replaced, as
 * sqltoolsservice does. Messages without a line number (PostgreSQL) get
 * " (Line N)" at the end of their first line, so the line can be clicked.
 */
function withAbsoluteLine(text: string, batchLine: number, absoluteLine: number): string {
    const newline = text.search(/\r?\n/);
    const header = newline === -1 ? text : text.slice(0, newline);
    const rest = newline === -1 ? "" : text.slice(newline);
    const match = /(\d+)$/.exec(header);
    const lastComma = header.lastIndexOf(",");
    if (match && lastComma !== -1 && Number(match[1]) === batchLine + 1) {
        return header.slice(0, match.index) + String(absoluteLine + 1) + rest;
    }
    return `${header} (${LocalizedConstants.runQueryBatchStartLine(absoluteLine + 1)})${rest}`;
}

/** "hh:mm:ss.fff", vscode-mssql's durationToDisplay(..., { format: "clock" }). */
export function formatClock(milliseconds: number): string {
    const pad = (n: number, width = 2) => String(n).padStart(width, "0");
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
    const seconds = Math.floor((milliseconds % 60_000) / 1000);
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds % 1000, 3)}`;
}
