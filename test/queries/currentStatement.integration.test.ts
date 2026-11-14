// "Execute Current Statement" against real servers: the driver finds the statement at the
// cursor, and QueryRunner runs only that text, at its position in the editor (what QueryManager
// does), so that message links and error lines point at the editor's lines.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueryRunner } from "../../src/queries/queryRunner";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import type { Driver, DriverConnection } from "../../src/drivers/types";
import type { IMessage } from "../../src/sharedInterfaces/queryResult";
import { connectToDocker } from "../drivers/mssql/helpers";
import { pgOptions } from "../support/databases";
import { textOf, withCursor } from "../sql/statementCases";

/** Runs the statement at the cursor of a marked script, like QueryManager.runCurrentStatement. */
async function runCurrentStatement(driver: Driver, connection: DriverConnection, marked: string) {
    const { script, position } = withCursor(marked);
    const range = driver.getStatementAt(script, position);
    expect(range).toBeDefined();
    const runner = new QueryRunner("file:///current.sql", "current.sql");
    const messages: IMessage[] = [];
    const batchStarts: number[] = [];
    runner.onMessage((m) => messages.push(m));
    runner.onBatchStart((b) => batchStarts.push(b.selection.startLine));
    await runner.run(driver, connection, textOf(script, range)!, range!.start);
    const cells = async (resultId: number) =>
        (await runner.getRows(0, resultId, 0, 100)).rows.map((row) =>
            row.map((c) => c.displayValue),
        );
    return { runner, messages, batchStarts, cells };
}

describe("Execute Current Statement on SQL Server", () => {
    let connection: DriverConnection;
    beforeAll(async () => {
        connection = await connectToDocker();
    });
    afterAll(async () => {
        await connection.close();
    });

    it("runs only the statement at the cursor of a script without semicolons", async () => {
        const run = await runCurrentStatement(
            mssqlDriver,
            connection,
            "SELECT 1 AS a\nSELECT 2 AS b\nUNION ALL\nSELECT |3\nSELECT 4 AS c",
        );
        expect(run.batchStarts).toEqual([1]);
        expect(run.runner.getResultSet(0, 1)).toBeUndefined();
        expect(await run.cells(0)).toEqual([["2"], ["3"]]);
    });

    it("reports an error at the editor line of its statement", async () => {
        // SQL Server gives the line where the failing statement starts.
        const run = await runCurrentStatement(
            mssqlDriver,
            connection,
            "SELECT 1\nGO\nPRINT 'x'\nSELECT *\n  FROM no_such|_table\nSELECT 3",
        );
        expect(run.batchStarts).toEqual([3]);
        const error = run.messages.find((m) => m.isError)!;
        expect(error.message.split("\n")[0]).toBe("Msg 208, Level 16, State 1, Line 4");
        expect(error.link?.text).toBe("Line 4");
        expect(error.selection).toEqual(expect.objectContaining({ startLine: 3 }));
    });

    it("runs a MERGE with its required semicolon", async () => {
        const run = await runCurrentStatement(
            mssqlDriver,
            connection,
            [
                "DECLARE @t TABLE (id int)",
                "SELECT 0",
                "MERGE INTO #m AS t USING (SELECT 1 AS id) AS s ON t.id = s.id",
                "WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)|",
                "OUTPUT $action AS action;",
            ].join("\n"),
        );
        // #m does not exist: the point is that the server parsed the whole MERGE.
        const error = run.messages.find((m) => m.isError)!;
        expect(error.message).toMatch(/Invalid object name '#m'/);
    });
});

describe("Execute Current Statement on PostgreSQL", () => {
    let connection: DriverConnection;
    beforeAll(async () => {
        connection = await pgDriver.connect({ options: pgOptions() });
    });
    afterAll(async () => {
        await connection.close();
    });

    it("runs only the statement at the cursor", async () => {
        const run = await runCurrentStatement(
            pgDriver,
            connection,
            "SELECT 1 AS a;\nSELECT 2 AS b UNION ALL SELECT |3;\nSELECT 4 AS c;",
        );
        expect(run.batchStarts).toEqual([1]);
        expect(run.runner.getResultSet(0, 1)).toBeUndefined();
        expect(await run.cells(0)).toEqual([["2"], ["3"]]);
    });

    it("keeps a dollar-quoted body whole and reports errors at editor lines", async () => {
        const run = await runCurrentStatement(
            pgDriver,
            connection,
            ["SELECT 1;", "DO $$", "BEGIN", "  PERFORM 1;|", "END $$;", "SELECT 3;"].join("\n"),
        );
        expect(run.batchStarts).toEqual([1]);
        expect(run.messages.some((m) => m.isError)).toBe(false);

        const failing = await runCurrentStatement(
            pgDriver,
            connection,
            "SELECT 1;\n\nSELECT *\n  FROM no_such|_table;\nSELECT 3;",
        );
        const error = failing.messages.find((m) => m.isError)!;
        expect(error.message.split("\n")[0]).toBe(
            'ERROR:  relation "no_such_table" does not exist (Line 4)',
        );
        expect(error.selection?.startLine).toBe(3);
    });
});
