import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { runInNewContext } from "vm";
import { setFlagsFromString } from "v8";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import type { Driver, DriverConnection } from "../../src/drivers/types";
import { QueryRunner } from "../../src/queries/queryRunner";
import { ResultFiles } from "../../src/queries/resultFiles";
import { createRowStore, type RowStore } from "../../src/queries/rowStore";
import { writeResultsFile } from "../../src/queryResult/export/resultExporter";
import type { ResultSetSummary } from "../../src/sharedInterfaces/queryResult";
import { connectToDocker } from "../drivers/mssql/helpers";
import { pgOptions } from "../support/databases";

// Large results: rows go to a file, memory stays bounded, the grid can read any page while the
// query streams, a cancel leaves a readable partial result, and a slow store makes the driver wait.

const ROWS = 2_000_000;
/** Bound on the heap kept by a 2-million-row result. Held in memory, the same rows take ~400 MB. */
const MAX_HEAP_GROWTH = 96 * 1024 * 1024;

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** JavaScript heap plus Buffers (blocks waiting for the disk, read cache), after a full GC. */
function heapUsed(): number {
    gc();
    gc();
    const usage = process.memoryUsage();
    return usage.heapUsed + usage.external;
}

/** Row `i` (0-based) of the test query: n = i + 1, s = 'row ' || n. */
const expectedRow = (i: number) => [String(i + 1), `row ${i + 1}`];

const engines: {
    name: string;
    driver: Driver;
    connect: () => Promise<DriverConnection>;
    query: (rows: number) => string;
}[] = [
    {
        name: "SQL Server",
        driver: mssqlDriver,
        connect: () => connectToDocker(),
        query: (rows) =>
            `SELECT n, CONCAT('row ', n) AS s FROM (
                SELECT TOP (${rows}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
                FROM sys.all_columns a CROSS JOIN sys.all_columns b
            ) t ORDER BY n`,
    },
    {
        name: "PostgreSQL",
        driver: pgDriver,
        connect: () => pgDriver.connect({ options: pgOptions() }),
        query: (rows) => `SELECT n, 'row ' || n AS s FROM generate_series(1, ${rows}) AS n`,
    },
];

async function expectRows(runner: QueryRunner, start: number, count: number): Promise<void> {
    const page = await runner.getRows(0, 0, start, count);
    expect(page.rows.map((r) => r.map((c) => c.displayValue))).toEqual(
        Array.from({ length: count }, (_, i) => expectedRow(start + i)),
    );
}

describe.each(engines)("large results on $name", ({ driver, connect, query }) => {
    let connection: DriverConnection;
    let root: string;
    beforeAll(async () => {
        connection = await connect();
        root = fs.mkdtempSync(path.join(os.tmpdir(), "yast-large-it-"));
    });
    afterAll(async () => {
        await connection.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it(
        `streams ${ROWS} rows to disk with bounded memory, pages anywhere and saves them as CSV`,
        { timeout: 120_000 },
        async () => {
            const files = new ResultFiles(path.join(root, "results"));
            const runner = new QueryRunner("file:///big.sql", "big.sql", () =>
                files.createRowStore(),
            );
            const before = heapUsed();
            let peak = 0;
            const sampler = setInterval(() => {
                peak = Math.max(peak, heapUsed() - before);
            }, 500);

            // While the query streams: the start, the middle and the last row received so far.
            const checks: Promise<void>[] = [];
            let nextCheck = 100_000;
            runner.onResultSetUpdated((summary: ResultSetSummary) => {
                if (summary.rowCount < nextCheck) return;
                nextCheck += 500_000;
                const count = summary.rowCount;
                checks.push(
                    (async () => {
                        await expectRows(runner, 0, 3);
                        await expectRows(runner, Math.floor(count / 2), 50);
                        await expectRows(runner, count - 1, 1);
                    })(),
                );
            });
            let complete: { hasError: boolean } | undefined;
            runner.onComplete((e) => (complete = e));
            await runner.run(driver, connection, query(ROWS), { line: 0, column: 0 });
            clearInterval(sampler);
            await Promise.all(checks);
            expect(checks.length).toBeGreaterThanOrEqual(2);
            expect(complete?.hasError).toBe(false);
            expect(runner.getResultSet(0, 0)?.summary.rowCount).toBe(ROWS);

            const retained = heapUsed() - before;
            peak = Math.max(peak, retained);
            console.log(
                `heap: peak +${Math.round(peak / 1e6)} MB, retained +${Math.round(retained / 1e6)} MB, ` +
                    `file ${Math.round(fs.statSync(path.join(files.sessionDir, "1.rows")).size / 1e6)} MB`,
            );
            expect(peak).toBeLessThan(MAX_HEAP_GROWTH);

            await expectRows(runner, 0, 50);
            await expectRows(runner, ROWS / 2 - 25, 50);
            await expectRows(runner, ROWS - 50, 50);
            expect((await runner.getRows(0, 0, ROWS - 1, 50)).rowCount).toBe(1);

            // Save as CSV streams the whole result to the file.
            const csv = path.join(root, "big.csv");
            await writeResultsFile(csv, runner.getExportSource(0, 0)!, "csv", {
                dialect: driver.id,
                csv: {
                    includeHeaders: true,
                    delimiter: ",",
                    lineSeparator: "\n",
                    textIdentifier: '"',
                },
                includeHeaders: true,
                excel: {} as never,
                eol: "\n",
            });
            let lines = 0;
            let first = "";
            let last = "";
            for await (const line of readline.createInterface(fs.createReadStream(csv))) {
                if (lines === 1) first = line;
                last = line;
                lines++;
            }
            expect(lines).toBe(ROWS + 1);
            expect(first).toBe("1,row 1");
            expect(last).toBe(`${ROWS},row ${ROWS}`);
            expect(heapUsed() - before).toBeLessThan(MAX_HEAP_GROWTH);

            runner.dispose();
            await waitFor(() => fs.readdirSync(files.sessionDir).length === 0);
        },
    );

    it("cancels mid-stream and leaves a readable partial result, then no file", async () => {
        const files = new ResultFiles(path.join(root, "cancel"), {
            store: { memoryLimit: 1024 * 1024 },
        });
        const runner = new QueryRunner("file:///cancel.sql", "cancel.sql", () =>
            files.createRowStore(),
        );
        runner.onResultSetUpdated((summary) => {
            if (summary.rowCount >= 200_000) runner.cancel();
        });
        let complete: { isCanceled: boolean } | undefined;
        runner.onComplete((e) => (complete = e));
        const messages: string[] = [];
        runner.onMessage((m) => messages.push(m.message));
        await runner.run(driver, connection, query(ROWS), { line: 0, column: 0 });

        expect(complete?.isCanceled).toBe(true);
        expect(messages).toContain("Query was canceled by user.");
        const count = runner.getResultSet(0, 0)!.summary.rowCount;
        expect(count).toBeGreaterThanOrEqual(200_000);
        expect(count).toBeLessThan(ROWS);
        await expectRows(runner, 0, 10);
        await expectRows(runner, count - 10, 10);
        expect(fs.readdirSync(files.sessionDir)).toEqual(["1.rows"]);

        // The session is still usable.
        const next = new QueryRunner("file:///next.sql", "next.sql");
        await next.run(driver, connection, query(3), { line: 0, column: 0 });
        await expectRows(next, 0, 3);

        runner.dispose();
        await waitFor(() => fs.readdirSync(files.sessionDir).length === 0);
    });

    it("stops reading from the server while the store is busy", async () => {
        // A store that takes 2 ms per chunk and counts the rows handed over while it is busy.
        let busy = false;
        let rowsWhileBusy = 0;
        const slowStore = (): RowStore => {
            const store = createRowStore();
            return {
                get rowCount() {
                    return store.rowCount;
                },
                append(rows) {
                    if (busy) rowsWhileBusy += rows.length;
                    void store.append(rows);
                    busy = true;
                    return new Promise((resolve) =>
                        setTimeout(() => {
                            busy = false;
                            resolve();
                        }, 2),
                    );
                },
                getRows: (start, count) => store.getRows(start, count),
                iterate: (start, end) => store.iterate(start, end),
                dispose: () => store.dispose(),
            };
        };
        const runner = new QueryRunner("file:///slow.sql", "slow.sql", slowStore);
        await runner.run(driver, connection, query(100_000), { line: 0, column: 0 });
        expect(runner.getResultSet(0, 0)!.summary.rowCount).toBe(100_000);
        await expectRows(runner, 99_990, 10);
        expect(rowsWhileBusy).toBe(0);
        runner.dispose();
    });
});

async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !condition(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(condition()).toBe(true);
}
