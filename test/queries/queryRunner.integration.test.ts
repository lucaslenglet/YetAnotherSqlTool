import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueryRunner } from "../../src/queries/queryRunner";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import type { DriverConnection } from "../../src/drivers/types";
import type { IMessage, ResultSetSummary } from "../../src/sharedInterfaces/queryResult";
import { connectToDocker } from "../drivers/mssql/helpers";
import { pgOptions } from "../support/databases";

interface Run {
    runner: QueryRunner;
    messages: IMessage[];
    resultSets: ResultSetSummary[];
    batchStarts: (number | undefined)[];
    complete?: { hasError: boolean; isCanceled: boolean };
}

function watch(runner: QueryRunner): Run {
    const run: Run = { runner, messages: [], resultSets: [], batchStarts: [] };
    runner.onMessage((m) => run.messages.push(m));
    runner.onResultSetComplete((r) => run.resultSets.push({ ...r }));
    runner.onBatchStart((b) => run.batchStarts.push(b.selection?.startLine));
    runner.onComplete((e) => (run.complete = e));
    return run;
}

describe("QueryRunner on SQL Server", () => {
    let connection: DriverConnection;
    beforeAll(async () => {
        connection = await connectToDocker();
    });
    afterAll(async () => {
        await connection.close();
    });

    it("runs every batch, keeps the rows and pages through them", async () => {
        const run = watch(new QueryRunner("file:///a.sql", "a.sql"));
        const script = [
            "SELECT TOP 3 name FROM sys.objects ORDER BY object_id",
            "GO",
            "SELECT 1 AS a, NULL AS b; SELECT 2 AS c",
        ].join("\n");
        await run.runner.run(mssqlDriver, connection, script, { line: 0, column: 0 });

        expect(run.batchStarts).toEqual([0, 2]);
        expect(run.resultSets.map((r) => [r.batchId, r.id, r.rowCount, r.complete])).toEqual([
            [0, 0, 3, true],
            [1, 0, 1, true],
            [1, 1, 1, true],
        ]);
        expect(run.complete).toEqual(
            expect.objectContaining({ hasError: false, isCanceled: false }),
        );

        const page = await run.runner.getRows(0, 0, 1, 10);
        expect(page.rowCount).toBe(2);
        expect(page.rows[0][0].rowId).toBe(1);
        expect((await run.runner.getRows(1, 0, 0, 1)).rows[0].map((c) => c.displayValue)).toEqual([
            "1",
            "NULL",
        ]);
    });

    it("links an error to its line in the editor, not in the batch", async () => {
        const run = watch(new QueryRunner("file:///b.sql", "b.sql"));
        // The selection starts on editor line 10; the error is on the 2nd line of the 2nd batch.
        const script = ["SELECT 1", "GO", "SELECT 1", "SELECT * FROM no_such_table"].join("\n");
        await run.runner.run(mssqlDriver, connection, script, { line: 10, column: 4 });

        const error = run.messages.find((m) => m.isError)!;
        expect(error.message.split("\n")[0]).toMatch(/^Msg 208, Level 16, State 1, Line 14$/);
        expect(error.link?.text).toBe("Line 14");
        expect(error.selection).toEqual(expect.objectContaining({ startLine: 13, endLine: 13 }));
        expect(run.complete?.hasError).toBe(true);
    });

    it("says 'Commands completed successfully.' for a batch without output", async () => {
        const run = watch(new QueryRunner("file:///c.sql", "c.sql"));
        await run.runner.run(mssqlDriver, connection, "SET NOCOUNT ON", { line: 0, column: 0 });
        expect(run.messages.map((m) => m.message)).toEqual(["Commands completed successfully."]);
    });

    it("copies a selection as text and summarizes it", async () => {
        const run = watch(new QueryRunner("file:///d.sql", "d.sql"));
        await run.runner.run(
            mssqlDriver,
            connection,
            "SELECT * FROM (VALUES (1, 'a'), (2, NULL), (4, 'a')) v(n, s)",
            { line: 0, column: 0 },
        );
        const all = [{ fromRow: 0, toRow: 2, fromCell: 0, toCell: 1 }];
        expect(await run.runner.getSelectionAsText(0, 0, all, true, true, "\n")).toBe(
            "n\ts\n1\ta\n2\tNULL\n4\ta",
        );
        expect(run.runner.getSelectionHeaders(0, 0, all)).toBe("n\ts");
        expect(await run.runner.getSelectionSummary(0, 0, all)).toEqual({
            count: 6,
            distinctCount: 4,
            nullCount: 1,
            sum: 7,
            average: 7 / 3,
            min: 1,
            max: 4,
        });
    });

    it("stops after a cancel", async () => {
        const run = watch(new QueryRunner("file:///e.sql", "e.sql"));
        const done = run.runner.run(
            mssqlDriver,
            connection,
            "WAITFOR DELAY '00:00:10'\nGO\nSELECT 1",
            {
                line: 0,
                column: 0,
            },
        );
        await new Promise((r) => setTimeout(r, 500));
        run.runner.cancel();
        await done;
        expect(run.complete?.isCanceled).toBe(true);
        expect(run.batchStarts).toEqual([0]);
        expect(run.resultSets).toEqual([]);
    });
});

describe("QueryRunner on PostgreSQL", () => {
    let connection: DriverConnection;
    beforeAll(async () => {
        connection = await pgDriver.connect({ options: pgOptions() });
    });
    afterAll(async () => {
        await connection.close();
    });

    it("gives one result set per statement and a clickable error line", async () => {
        const run = watch(new QueryRunner("file:///f.sql", "f.sql"));
        const script = "SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT * FROM no_such_table;";
        await run.runner.run(pgDriver, connection, script, { line: 5, column: 0 });

        expect(run.resultSets.map((r) => [r.batchId, r.id, r.rowCount])).toEqual([
            [0, 0, 1],
            [0, 1, 1],
        ]);
        const error = run.messages.find((m) => m.isError)!;
        expect(error.message.split("\n")[0]).toBe(
            'ERROR:  relation "no_such_table" does not exist (Line 8)',
        );
        expect(error.link?.text).toBe("Line 8");
        expect(error.selection?.startLine).toBe(7);
    });
});

describe.each([
    ["SQL Server", mssqlDriver, () => connectToDocker()],
    ["PostgreSQL", pgDriver, () => pgDriver.connect({ options: pgOptions() })],
] as const)("QueryRunner.runObjectInformation on %s", (_label, driver, open) => {
    let connection: DriverConnection;
    beforeAll(async () => {
        connection = await open();
    });
    afterAll(async () => {
        await connection.close();
    });

    it("stores one result set per topic, without editor links", async () => {
        const run = watch(new QueryRunner("file:///oi.sql", "oi.sql"));
        await run.runner.runObjectInformation(driver, connection, "customers");

        expect(run.batchStarts).toEqual([undefined]);
        expect(run.resultSets.length).toBeGreaterThan(3);
        expect(run.messages.every((m) => !m.link && !m.selection)).toBe(true);
        expect(run.complete).toEqual(
            expect.objectContaining({ hasError: false, isCanceled: false }),
        );
        const columns = run.resultSets.find((r) => r.columnInfo[0].columnName === "Column_name");
        expect(columns).toBeDefined();
        const rows = (await run.runner.getRows(columns!.batchId, columns!.id, 0, 100)).rows;
        expect(rows.map((row) => row[0].displayValue)).toEqual([
            "id",
            "name",
            "email",
            "created_at",
        ]);
    });

    it("lists the objects of the database without a name", async () => {
        const run = watch(new QueryRunner("file:///oi2.sql", "oi2.sql"));
        await run.runner.runObjectInformation(driver, connection, undefined);
        const objects = run.resultSets.find((r) =>
            r.columnInfo.some((c) => c.columnName === "Name"),
        )!;
        const nameColumn = objects.columnInfo.findIndex((c) => c.columnName === "Name");
        const names = (await run.runner.getRows(objects.batchId, objects.id, 0, 5000)).rows.map(
            (row) => row[nameColumn].displayValue,
        );
        expect(names).toEqual(expect.arrayContaining(["customers", "orders"]));
    });

    it("reports an unknown object as an error", async () => {
        const run = watch(new QueryRunner("file:///oi3.sql", "oi3.sql"));
        await run.runner.runObjectInformation(driver, connection, "no_such_object");
        expect(run.resultSets).toEqual([]);
        expect(run.messages).toHaveLength(1);
        expect(run.messages[0].isError).toBe(true);
        expect(run.messages[0].message).toContain("The object 'no_such_object' does not exist");
        expect(run.complete?.hasError).toBe(true);
    });
});
