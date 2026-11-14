import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { QueryRunner } from "../../src/queries/queryRunner";
import { registerQueryCommands } from "../../src/queries/queryCommands";
import * as Constants from "../../src/constants/constants";
import { mssqlDriver } from "../../src/drivers/mssql";
import { spHelpBatch } from "../../src/drivers/mssql/sqlText";
import { parseObjectName } from "../../src/drivers/pg/objectInfo";
import type { DriverConnection, ExecuteEvent } from "../../src/drivers/types";
import type { IMessage, ResultSetSummary } from "../../src/sharedInterfaces/queryResult";

describe("spHelpBatch", () => {
    it("runs sp_help without argument for the list of objects", () => {
        expect(spHelpBatch(undefined)).toBe("EXEC sp_help");
    });

    it("passes the selection as a unicode string, brackets and schema as typed", () => {
        expect(spHelpBatch("customers")).toBe("EXEC sp_help N'customers'");
        expect(spHelpBatch("[dbo].[Order Lines]")).toBe("EXEC sp_help N'[dbo].[Order Lines]'");
    });

    it("doubles quotes so the selection cannot end the literal", () => {
        expect(spHelpBatch("it's")).toBe("EXEC sp_help N'it''s'");
        expect(spHelpBatch("x'; DROP TABLE t; --")).toBe("EXEC sp_help N'x''; DROP TABLE t; --'");
    });
});

describe("parseObjectName", () => {
    const names = (text: string) => parseObjectName(text)?.map((p) => p.name);

    it("folds unquoted names to lower case and keeps quoted ones", () => {
        expect(names("Customers")).toEqual(["customers"]);
        expect(names('Sales."Order Lines"')).toEqual(["sales", "Order Lines"]);
        expect(names(' public . "A""B" ')).toEqual(["public", 'A"B']);
    });

    it("rebuilds text that the server parses back to the same names", () => {
        const parts = parseObjectName('Sales."Order Lines"')!;
        expect(parts.map((p) => p.text).join(".")).toBe('Sales."Order Lines"');
    });

    it("ignores an argument list and a trailing semicolon", () => {
        expect(names("add(int, int);")).toEqual(["add"]);
        expect(names("public.add (a int)")).toEqual(["public", "add"]);
    });

    it("rejects what is not a name", () => {
        for (const text of [
            "",
            " ",
            "1abc",
            "a.",
            ".a",
            '"',
            '""',
            "a b",
            "a;b",
            "a(",
            "x; DROP",
        ]) {
            expect(parseObjectName(text), text).toBeUndefined();
        }
    });
});

/** A connection whose describeObject plays the given events. */
function fakeConnection(play: (signal: AbortSignal) => Promise<ExecuteEvent[]>): {
    connection: DriverConnection;
    calls: (string | undefined)[];
} {
    const calls: (string | undefined)[] = [];
    const connection = {
        async describeObject(
            name: string | undefined,
            onEvent: (event: ExecuteEvent) => void,
            signal: AbortSignal,
        ) {
            calls.push(name);
            for (const event of await play(signal)) onEvent(event);
        },
    } as unknown as DriverConnection;
    return { connection, calls };
}

const column = { columnName: "Name", dataTypeName: "text", kind: "string" as const };
const cell = (displayValue: string) => ({ displayValue, isNull: false });

function watch(runner: QueryRunner) {
    const run = {
        messages: [] as IMessage[],
        resultSets: [] as ResultSetSummary[],
        batchStarts: [] as unknown[],
        started: 0,
        complete: undefined as { hasError: boolean; isCanceled: boolean } | undefined,
    };
    runner.onStart(() => run.started++);
    runner.onMessage((m) => run.messages.push(m));
    runner.onResultSetComplete((r) => run.resultSets.push({ ...r }));
    runner.onBatchStart((b) => run.batchStarts.push(b.selection));
    runner.onComplete((e) => (run.complete = e));
    return run;
}

describe("QueryRunner.runObjectInformation", () => {
    it("stores the result sets of the driver's events like a normal run", async () => {
        const { connection, calls } = fakeConnection(async () => [
            { type: "resultSetStart", columns: [column] },
            { type: "rows", rows: [[cell("a")], [cell("b")]] },
            { type: "resultSetEnd", rowCount: 2 },
            { type: "message", text: "No constraints.", isError: false },
            { type: "resultSetStart", columns: [column] },
            { type: "rows", rows: [[cell("c")]] },
            { type: "resultSetEnd", rowCount: 1 },
        ]);
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        const run = watch(runner);
        await runner.runObjectInformation(mssqlDriver, connection, "customers");

        expect(calls).toEqual(["customers"]);
        expect(run.started).toBe(1);
        expect(run.resultSets.map((r) => [r.batchId, r.id, r.rowCount, r.complete])).toEqual([
            [0, 0, 2, true],
            [0, 1, 1, true],
        ]);
        expect((await runner.getRows(0, 0, 0, 10)).rows.map((r) => r[0].displayValue)).toEqual([
            "a",
            "b",
        ]);
        expect((await runner.getRows(0, 1, 0, 10)).rows.map((r) => r[0].displayValue)).toEqual([
            "c",
        ]);
        expect(run.complete).toEqual(
            expect.objectContaining({ hasError: false, isCanceled: false }),
        );
        expect(runner.isExecuting).toBe(false);
    });

    it("has no editor position: no selection on the batch, no line link on errors", async () => {
        const { connection } = fakeConnection(async () => [
            {
                type: "message",
                text: "Msg 15009, Level 16, State 1, Procedure sp_help, Line 79\nThe object 'x' does not exist",
                isError: true,
                // Even a driver that reports a position must not produce a link: it is not editor text.
                position: { line: 0, column: 0 },
            },
        ]);
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        const run = watch(runner);
        await runner.runObjectInformation(mssqlDriver, connection, undefined);

        expect(run.batchStarts).toEqual([undefined]);
        expect(run.messages).toHaveLength(1);
        expect(run.messages[0].isError).toBe(true);
        expect(run.messages[0].link).toBeUndefined();
        expect(run.messages[0].selection).toBeUndefined();
        expect(run.complete?.hasError).toBe(true);
    });

    it("reports a failing connection as an error message", async () => {
        const { connection } = fakeConnection(async () => {
            throw new Error("connection lost");
        });
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        const run = watch(runner);
        await runner.runObjectInformation(mssqlDriver, connection, "t");
        expect(run.messages.map((m) => [m.message, m.isError])).toEqual([
            ["connection lost", true],
        ]);
        expect(run.complete?.hasError).toBe(true);
    });

    it("can be canceled, and ignores a second run while executing", async () => {
        let aborted: Promise<void> | undefined;
        const { connection, calls } = fakeConnection((signal) => {
            aborted = new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve()),
            );
            return aborted.then(() => [
                { type: "message", text: "Query was canceled by user.", isError: true },
            ]);
        });
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        const run = watch(runner);
        const first = runner.runObjectInformation(mssqlDriver, connection, "t");
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(runner.isExecuting).toBe(true);
        await runner.runObjectInformation(mssqlDriver, connection, "other");
        expect(calls).toHaveLength(1);

        runner.cancel();
        await first;
        expect(run.complete).toEqual(expect.objectContaining({ isCanceled: true }));
        expect(runner.isExecuting).toBe(false);
    });

    it("replaces the results of the previous run", async () => {
        const one = fakeConnection(async () => [
            { type: "resultSetStart", columns: [column] },
            { type: "rows", rows: [[cell("old")]] },
            { type: "resultSetEnd", rowCount: 1 },
        ]);
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        await runner.runObjectInformation(mssqlDriver, one.connection, "a");
        const two = fakeConnection(async () => []);
        await runner.runObjectInformation(mssqlDriver, two.connection, "b");
        expect(runner.getResultSet(0, 0)).toBeUndefined();
    });
});

describe("yast.showObjectInformation", () => {
    function setup(selections: { text: string; empty: boolean }[], languageId = "sql") {
        const handlers = new Map<string, (...args: any[]) => unknown>();
        vi.spyOn(vscode.commands, "registerCommand").mockImplementation(((
            command: string,
            handler: (...args: any[]) => unknown,
        ) => {
            handlers.set(command, handler);
            return { dispose: () => undefined };
        }) as any);
        const [primary] = selections;
        const editor = {
            selection: primary,
            selections,
            document: {
                languageId,
                uri: { toString: () => "file:///a.sql" },
                // The selection object stands for its own range in this fake.
                getText: (range: { text: string }) => range.text,
            },
        };
        (vscode.window as any).activeTextEditor = editor;
        const showObjectInformation = vi.fn(async () => undefined);
        registerQueryCommands(
            { subscriptions: [] } as any,
            {} as any,
            {} as any,
            { showObjectInformation } as any,
        );
        return {
            run: () => handlers.get(Constants.cmdShowObjectInformation)!(),
            showObjectInformation,
        };
    }

    it("describes the trimmed selected text", async () => {
        const { run, showObjectInformation } = setup([
            { text: "  dbo.customers \n", empty: false },
        ]);
        await run();
        expect(showObjectInformation).toHaveBeenCalledWith(
            expect.anything(),
            "dbo.customers",
            expect.any(Function),
        );
    });

    it("lists the database's objects when nothing, or only blanks, is selected", async () => {
        for (const text of ["", "   "]) {
            const { run, showObjectInformation } = setup([{ text, empty: text === "" }]);
            await run();
            expect(showObjectInformation).toHaveBeenCalledWith(
                expect.anything(),
                undefined,
                expect.any(Function),
            );
        }
    });

    it("uses the primary selection when there are several", async () => {
        const { run, showObjectInformation } = setup([
            { text: "first", empty: false },
            { text: "second", empty: false },
        ]);
        await run();
        expect(showObjectInformation.mock.calls[0][1]).toBe("first");
    });

    it("does nothing outside a SQL editor", async () => {
        const { run, showObjectInformation } = setup([{ text: "x", empty: false }], "plaintext");
        await run();
        expect(showObjectInformation).not.toHaveBeenCalled();
    });
});
