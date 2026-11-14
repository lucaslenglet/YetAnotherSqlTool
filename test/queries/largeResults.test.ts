import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mssqlDriver } from "../../src/drivers/mssql";
import {
    QUERY_CANCELED_MESSAGE,
    type CellValue,
    type ColumnInfo,
    type DriverConnection,
    type ExecuteEventHandler,
} from "../../src/drivers/types";
import { QueryManager } from "../../src/queries/queryManager";
import {
    CopyTooLargeError,
    OperationCanceledError,
    QueryRunner,
} from "../../src/queries/queryRunner";
import { ResultFiles } from "../../src/queries/resultFiles";
import { createRowStore, type RowStore } from "../../src/queries/rowStore";
import { formatCsv } from "../../src/queryResult/export/csv";
import { formatExcel } from "../../src/queryResult/export/excel";
import { formatJson } from "../../src/queryResult/export/json";
import { buildText, encode, writeResultsFile } from "../../src/queryResult/export/resultExporter";
import { csvWriter } from "../../src/queryResult/export/csv";
import { formatInsert } from "../../src/queryResult/export/sql";
import type { ExcelOptions, ExportSource, ExportTable } from "../../src/queryResult/export/types";
import type { IMessage, QueryResultWebviewState } from "../../src/sharedInterfaces/queryResult";

const columns: ColumnInfo[] = [
    { columnName: "n", dataTypeName: "int", kind: "number" },
    { columnName: "s", dataTypeName: "nvarchar", kind: "string" },
];
const cell = (displayValue: string): CellValue => ({ displayValue, isNull: false });
const NULL: CellValue = { displayValue: "NULL", isNull: true };
const row = (n: number): CellValue[] => [cell(String(n)), n % 10 === 0 ? NULL : cell(`text ${n}`)];

/** A connection whose execute streams `total` rows in chunks, waiting when asked to. */
function streamingConnection(
    total: number,
    chunk = 500,
): { connection: DriverConnection; maxAhead: () => number; aborted: () => boolean } {
    let maxAhead = 0;
    let aborted = false;
    const connection = {
        async execute(_batch: unknown, onEvent: ExecuteEventHandler, signal: AbortSignal) {
            await onEvent({ type: "resultSetStart", columns });
            for (let start = 0; start < total; start += chunk) {
                if (signal.aborted) {
                    aborted = true;
                    await onEvent({ type: "resultSetEnd", rowCount: start });
                    await onEvent({ type: "message", text: QUERY_CANCELED_MESSAGE, isError: true });
                    return;
                }
                const rows = Array.from({ length: Math.min(chunk, total - start) }, (_, i) =>
                    row(start + i),
                );
                const wait = onEvent({ type: "rows", rows });
                if (wait) {
                    maxAhead = Math.max(maxAhead, 1);
                    await wait;
                }
            }
            await onEvent({ type: "resultSetEnd", rowCount: total });
        },
    } as unknown as DriverConnection;
    return { connection, maxAhead: () => maxAhead, aborted: () => aborted };
}

let root: string;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "yast-large-"));
});
afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function spillingFiles(): ResultFiles {
    return new ResultFiles(path.join(root, "results"), {
        store: { memoryLimit: 10_000, blockMaxRows: 64, writeHighWater: 20_000 },
    });
}

function watch(runner: QueryRunner) {
    const run = {
        messages: [] as IMessage[],
        complete: undefined as { hasError: boolean; isCanceled: boolean } | undefined,
    };
    runner.onMessage((m) => run.messages.push(m));
    runner.onComplete((e) => (run.complete = e));
    return run;
}

const ALL = (rows: number) => [{ fromRow: 0, toRow: rows - 1, fromCell: 0, toCell: 1 }];

describe("QueryRunner over a store on disk", () => {
    it("streams rows to the file, with backpressure, and reads them back anywhere", async () => {
        const files = spillingFiles();
        const runner = new QueryRunner("file:///a.sql", "a.sql", () => files.createRowStore());
        const { connection, maxAhead } = streamingConnection(20_000);
        const run = watch(runner);
        await runner.run(mssqlDriver, connection, "SELECT", { line: 0, column: 0 });

        expect(run.complete).toEqual(expect.objectContaining({ hasError: false }));
        expect(maxAhead()).toBe(1); // the driver was asked to wait at least once
        expect(fs.readdirSync(files.sessionDir)).toEqual(["1.rows"]);
        for (const start of [0, 9_975, 19_990]) {
            const page = await runner.getRows(0, 0, start, 50);
            expect(page.rows[0][0]).toEqual({ ...row(start)[0], rowId: start });
            expect(page.rowCount).toBe(Math.min(50, 20_000 - start));
        }

        const selection = [
            { fromRow: 19_998, toRow: 19_999, fromCell: 0, toCell: 1 },
            { fromRow: 19_999, toRow: 19_999, fromCell: 0, toCell: 0 },
        ];
        expect(await runner.getSelectionAsText(0, 0, selection, true, true, "\n")).toBe(
            "n\ts\n19998\ttext 19998\n19999\ttext 19999",
        );
        expect(await runner.getSelectionSummary(0, 0, ALL(20_000))).toEqual({
            count: 40_000,
            distinctCount: 20_000 + 18_000,
            nullCount: 2_000,
            sum: (19_999 * 20_000) / 2,
            average: 19_999 / 2,
            min: 0,
            max: 19_999,
        });

        // A new run releases the previous results and their file.
        await runner.run(mssqlDriver, streamingConnection(10).connection, "SELECT", {
            line: 0,
            column: 0,
        });
        await vi.waitFor(() => expect(fs.readdirSync(files.sessionDir)).toEqual([]));
        runner.dispose();
    });

    it("refuses a copy beyond the limit and stops when canceled", async () => {
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        await runner.run(mssqlDriver, streamingConnection(5000).connection, "SELECT", {
            line: 0,
            column: 0,
        });
        await expect(
            runner.getSelectionAsText(0, 0, ALL(5000), false, true, "\n", { maxLength: 1000 }),
        ).rejects.toBeInstanceOf(CopyTooLargeError);
        await expect(
            runner.getSelectionAsText(0, 0, ALL(5000), false, true, "\n", {
                isCanceled: () => true,
            }),
        ).rejects.toBeInstanceOf(OperationCanceledError);
        await expect(
            runner.getSelectionSummary(0, 0, ALL(5000), { isCanceled: () => true }),
        ).rejects.toBeInstanceOf(OperationCanceledError);

        const source = runner.getExportSource(0, 0, ALL(5000))!;
        await expect(
            buildText(source, csvWriter(source.columns, csvOptions), 1000),
        ).rejects.toThrow(/too large to copy/);
        expect(new CopyTooLargeError(50_000_000).message).toContain(
            "more than 50 million characters",
        );
    });

    it("stops the run on a disk error and keeps the rows already stored", async () => {
        let stores: RowStore[] = [];
        const failing = () => {
            const store = createRowStore();
            let appends = 0;
            const wrapped: RowStore = {
                get rowCount() {
                    return store.rowCount;
                },
                append(rows) {
                    if (++appends > 3) {
                        return Promise.reject(new Error("ENOSPC: no space left on device"));
                    }
                    return store.append(rows);
                },
                getRows: (start, count) => store.getRows(start, count),
                iterate: (start, end) => store.iterate(start, end),
                dispose: () => store.dispose(),
            };
            stores.push(wrapped);
            return wrapped;
        };
        const runner = new QueryRunner("file:///a.sql", "a.sql", failing);
        const { connection, aborted } = streamingConnection(10_000);
        const run = watch(runner);
        await runner.run(mssqlDriver, connection, "SELECT", { line: 0, column: 0 });

        expect(aborted()).toBe(true);
        expect(run.complete).toEqual(
            expect.objectContaining({ hasError: true, isCanceled: false }),
        );
        const errors = run.messages.filter((m) => m.isError).map((m) => m.message);
        expect(errors).toEqual([
            "Could not store the results on disk, the query was stopped: ENOSPC: no space left on device",
        ]);
        expect(stores[0].rowCount).toBe(1500);
        expect((await runner.getRows(0, 0, 1499, 10)).rows).toHaveLength(1);
        stores = [];
    });
});

const csvOptions = {
    includeHeaders: true,
    delimiter: ",",
    lineSeparator: "\r\n",
    textIdentifier: '"',
};
const excelOptions: ExcelOptions = {
    includeHeaders: true,
    freezeHeaderRow: true,
    boldHeaderRow: true,
    autoFilterHeaderRow: true,
    autoSizeColumns: true,
};

/** The table as a source yielding chunks of `chunkSize` rows. */
function sourceOf(table: ExportTable, chunkSize: number): ExportSource {
    return {
        columns: table.columns,
        rowCount: table.rows.length,
        async *chunks() {
            for (let i = 0; i < table.rows.length; i += chunkSize) {
                yield table.rows.slice(i, i + chunkSize);
            }
        },
    };
}

describe("streamed save", () => {
    const table: ExportTable = {
        columns,
        rows: Array.from({ length: 2345 }, (_, i) => (i === 7 ? [undefined, NULL] : row(i))),
    };

    it("writes the same bytes as the whole-table formatters", async () => {
        const options = {
            dialect: "mssql" as const,
            csv: csvOptions,
            encoding: "utf-16le",
            includeHeaders: true,
            excel: excelOptions,
            eol: "\n",
        };
        const file = path.join(root, "out");
        const expected = {
            csv: encode(formatCsv(table, csvOptions), "utf-16le"),
            json: encode(formatJson(table, { lineSeparator: "\n" })),
            insert: encode(
                formatInsert(table, {
                    dialect: "mssql",
                    tableName: "TableName",
                    includeHeaders: true,
                    lineSeparator: "\n",
                }),
            ),
        };
        for (const [format, bytes] of Object.entries(expected)) {
            for (const chunkSize of [1, 999, 5000]) {
                await writeResultsFile(file, sourceOf(table, chunkSize), format as "csv", options);
                expect(
                    fs.readFileSync(file).equals(Buffer.from(bytes)),
                    `${format} ${chunkSize}`,
                ).toBe(true);
            }
        }
    });

    it("streams a workbook with the same parts as the in-memory one", async () => {
        const file = path.join(root, "out.xlsx");
        const options = {
            dialect: "mssql" as const,
            csv: csvOptions,
            includeHeaders: true,
            excel: excelOptions,
            eol: "\n",
        };
        await writeResultsFile(file, sourceOf(table, 100), "excel", options);
        const parts = (bytes: Uint8Array) =>
            Object.fromEntries(
                Object.entries(unzipSync(bytes)).map(([name, data]) => [name, strFromU8(data)]),
            );
        expect(parts(fs.readFileSync(file))).toEqual(parts(formatExcel(table, excelOptions)));
    });

    it("deletes a file left half written by an error", async () => {
        const file = path.join(root, "broken.csv");
        const broken: ExportSource = {
            columns,
            rowCount: 2,
            async *chunks() {
                yield [row(1)];
                throw new Error("read failed");
            },
        };
        await expect(
            writeResultsFile(file, broken, "csv", {
                dialect: "mssql",
                csv: csvOptions,
                includeHeaders: true,
                excel: excelOptions,
                eol: "\n",
            }),
        ).rejects.toThrow("read failed");
        expect(fs.existsSync(file)).toBe(false);
    });
});

describe("selection summary of a large selection", () => {
    function manager() {
        const state = {
            tabStates: {},
            messages: [],
            resultSetSummaries: {},
        } as unknown as QueryResultWebviewState;
        const pushes: QueryResultWebviewState["selectionSummary"][] = [];
        const results = {
            set queryManager(_: unknown) {},
            hasQueryResultState: () => true,
            hasPanel: () => false,
            getQueryResultState: () => state,
            pushState: (_uri: string, s: QueryResultWebviewState) =>
                pushes.push(s.selectionSummary),
        };
        const queries = new QueryManager({} as never, results as never);
        const runner: QueryRunner = (
            queries as unknown as { getOrCreateRunner(uri: string, title: string): QueryRunner }
        ).getOrCreateRunner("file:///a.sql", "a.sql");
        return { queries, runner, pushes, state };
    }

    it("waits for a click above the threshold, then loads; a new selection drops the old one", async () => {
        const { queries, runner, pushes } = manager();
        await runner.run(mssqlDriver, streamingConnection(8000).connection, "SELECT", {
            line: 0,
            column: 0,
        });
        pushes.length = 0;
        queries.updateSelectionSummary("file:///a.sql", 0, 0, ALL(8000));
        await vi.waitFor(() => expect(pushes).toHaveLength(1));
        expect(pushes[0]!.displayText).toBe("8000 rows selected, click to load summary");
        expect(pushes[0]!.stats).toBeUndefined();
        expect(pushes[0]!.command?.arguments).toEqual(["file:///a.sql"]);

        queries.handleSelectionSummary("file:///a.sql");
        await vi.waitFor(() => expect(pushes.at(-1)?.stats?.count).toBe(16_000));
        expect(
            pushes.some((p) => p?.displayText?.startsWith("Loading summary for 8000 rows")),
        ).toBe(true);

        // Small selection: computed at once.
        pushes.length = 0;
        queries.updateSelectionSummary("file:///a.sql", 0, 0, ALL(3));
        await vi.waitFor(() => expect(pushes.at(-1)?.stats?.count).toBe(6));

        // A large selection superseded before the click never reports.
        pushes.length = 0;
        queries.updateSelectionSummary("file:///a.sql", 0, 0, ALL(8000));
        queries.updateSelectionSummary("file:///a.sql", 0, 0, ALL(2));
        await vi.waitFor(() => expect(pushes.at(-1)?.stats?.count).toBe(4));
        queries.handleSelectionSummary("file:///a.sql");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(pushes.at(-1)?.stats?.count).toBe(4);
        queries.dispose();
    });
});
