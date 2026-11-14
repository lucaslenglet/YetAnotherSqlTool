import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { buildConnectionString } from "../../../src/drivers/mssql/connectionString";
import type { DriverConnection, ExecuteEvent } from "../../../src/drivers/types";
import { mssqlPort, mssqlServer } from "../../support/databases";
import { connectToDocker, dockerOptions, runBatch, runScript } from "./helpers";

const messages = (events: ExecuteEvent[]) =>
    events.flatMap((e) => (e.type === "message" ? [e] : []));
const eventTypes = (events: ExecuteEvent[]) => events.map((e) => e.type);

describe("execute", () => {
    let connection: DriverConnection;
    beforeAll(async () => {
        connection = await connectToDocker();
    });
    afterAll(() => connection.close());

    it("streams a result set: start, rows, end, then '(N rows affected)'", async () => {
        const events = await runBatch(connection, "SELECT id, name FROM dbo.customers ORDER BY id");
        expect(eventTypes(events)).toEqual(["resultSetStart", "rows", "resultSetEnd", "message"]);

        const start = events[0];
        if (start.type !== "resultSetStart") throw new Error("expected resultSetStart");
        expect(start.columns.map((c) => [c.columnName, c.dataTypeName, c.kind])).toEqual([
            ["id", "int", "number"],
            ["name", "nvarchar", "string"],
        ]);

        const end = events[2];
        const rowCount = end.type === "resultSetEnd" ? end.rowCount : -1;
        expect(messages(events)[0]).toMatchObject({
            text: `(${rowCount} ${rowCount === 1 ? "row" : "rows"} affected)`,
            isError: false,
            rowsAffected: rowCount,
        });
    });

    it("sends rows in chunks of 500", async () => {
        const events = await runBatch(
            connection,
            "SELECT TOP 1200 object_id FROM sys.all_objects a CROSS JOIN (SELECT 1 AS x UNION SELECT 2) b",
        );
        const chunkSizes = events.flatMap((e) => (e.type === "rows" ? [e.rows.length] : []));
        expect(chunkSizes).toEqual([500, 500, 200]);
        expect(messages(events)[0].text).toBe("(1200 rows affected)");
    });

    it("handles several result sets and statements in one batch", async () => {
        const events = await runBatch(
            connection,
            "SELECT 1 AS a; SELECT 'x' AS b, 2 AS c; PRINT 'hello';",
        );
        expect(eventTypes(events)).toEqual([
            "resultSetStart",
            "rows",
            "resultSetEnd",
            "message",
            "resultSetStart",
            "rows",
            "resultSetEnd",
            "message",
            "message",
        ]);
        expect(messages(events).map((m) => m.text)).toEqual([
            "(1 row affected)",
            "(1 row affected)",
            "hello",
        ]);
    });

    it("reports rows affected by DML (temp table)", async () => {
        const events = await runBatch(
            connection,
            "CREATE TABLE #t (i int); INSERT INTO #t VALUES (1), (2), (3); UPDATE #t SET i = i + 1 WHERE i > 1; DROP TABLE #t;",
        );
        expect(messages(events).map((m) => m.text)).toEqual([
            "(3 rows affected)",
            "(2 rows affected)",
        ]);
    });

    it("reports PRINT and low severity RAISERROR as info messages", async () => {
        const events = await runBatch(
            connection,
            "PRINT 'a message'; RAISERROR('low severity %d', 10, 1, 7) WITH NOWAIT;",
        );
        expect(messages(events)).toEqual([
            { type: "message", text: "a message", isError: false },
            { type: "message", text: "low severity 7", isError: false },
        ]);
    });

    it("reports server errors like SSMS, with a 0-based line relative to the batch", async () => {
        const events = await runBatch(connection, "SELECT 1;\nSELECT * FROM dbo.does_not_exist;");
        const error = messages(events).find((m) => m.isError);
        expect(error).toEqual({
            type: "message",
            text: "Msg 208, Level 16, State 1, Line 2\nInvalid object name 'dbo.does_not_exist'.",
            isError: true,
            position: { line: 1, column: 0 },
        });
    });

    it("does not reject on a server error, and keeps the session usable", async () => {
        await expect(runBatch(connection, "SELECT 1/0")).resolves.toBeDefined();
        const events = await runBatch(connection, "RAISERROR('boom', 16, 1)");
        expect(messages(events)[0]).toMatchObject({
            text: "Msg 50000, Level 16, State 1, Line 1\nboom",
            isError: true,
        });
        expect(eventTypes(await runBatch(connection, "SELECT 1"))).toContain("rows");
    });

    it("mentions the procedure name for errors raised inside a procedure", async () => {
        const events = await runScript(
            connection,
            "CREATE PROCEDURE #boom AS RAISERROR('inside', 16, 1);\nGO\nEXEC #boom;",
        );
        const error = messages(events).find((m) => m.isError);
        expect(error?.text).toMatch(/^Msg 50000, Level 16, State 1, Procedure #boom/);
        expect(error?.position).toBeUndefined();
    });

    it("formats FOR XML and FOR JSON results", async () => {
        const events = await runBatch(connection, "SELECT 1 AS a FOR XML PATH('r')");
        expect(eventTypes(events)).toEqual(["resultSetStart", "rows", "resultSetEnd", "message"]);
        const rows = events.flatMap((e) => (e.type === "rows" ? e.rows : []));
        expect(rows[0][0].displayValue).toBe("<r><a>1</a></r>");
    });

    it("keeps the session state between batches: USE, SET and #temp tables", async () => {
        await runScript(
            connection,
            "CREATE TABLE #session_test (i int);\nGO\nINSERT #session_test VALUES (42);\nGO\nSET LANGUAGE French;",
        );
        const events = await runScript(
            connection,
            "SELECT i FROM #session_test;\nGO\nSELECT @@LANGUAGE;",
        );
        const values = events.flatMap((e) =>
            e.type === "rows" ? e.rows.map((r) => r[0].displayValue) : [],
        );
        expect(values).toEqual(["42", "Français"]);
        await runBatch(connection, "SET LANGUAGE us_english; DROP TABLE #session_test;");
    });

    it("changeDatabase and getCurrentDatabase act on the session", async () => {
        expect(await connection.getCurrentDatabase()).toBe("yast");
        await connection.changeDatabase("master");
        expect(await connection.getCurrentDatabase()).toBe("master");
        const events = await runBatch(connection, "SELECT DB_NAME()");
        expect(events.flatMap((e) => (e.type === "rows" ? e.rows[0][0].displayValue : []))).toEqual(
            ["master"],
        );
        await connection.changeDatabase("yast");
        expect(await connection.getCurrentDatabase()).toBe("yast");
    });

    it("cancels a running statement when the signal is aborted, then resolves", async () => {
        const controller = new AbortController();
        const events: ExecuteEvent[] = [];
        const running = connection.execute(
            { text: "WAITFOR DELAY '00:00:30'", startLine: 0 },
            (e) => events.push(e),
            controller.signal,
        );
        setTimeout(() => controller.abort(), 300);
        const started = Date.now();
        await running;
        expect(Date.now() - started).toBeLessThan(10000);
        expect(messages(events)).toEqual([
            { type: "message", text: "Query was canceled by user.", isError: true },
        ]);
        // The session still works afterwards.
        expect(eventTypes(await runBatch(connection, "SELECT 1"))).toContain("rows");
    });

    it("does nothing but report the cancellation when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const events = await runBatch(connection, "SELECT 1", controller.signal);
        expect(eventTypes(events)).toEqual(["message"]);
    });
});

describe("connect", () => {
    it("rejects with a readable message on a wrong password", async () => {
        await expect(connectToDocker({ password: "definitely-wrong" })).rejects.toThrow(
            /Login failed for user 'sa'/,
        );
    });

    it("rejects with a readable message when the server is unreachable", async () => {
        await expect(connectToDocker({ server: "localhost,1", connectTimeout: 3 })).rejects.toThrow(
            /localhost/,
        );
    });

    it("accepts the host and the port as separate options", async () => {
        const connection = await connectToDocker({ server: "localhost", port: mssqlPort() });
        expect(connection.getRootNode().nodePath).toBe(mssqlServer());
        await connection.close();
    });

    it("connects with a built then parsed connection string", async () => {
        const text = buildConnectionString(dockerOptions(), true);
        const connection = await mssqlDriver.connect({
            options: mssqlDriver.parseConnectionString(text),
        });
        try {
            const events = await runBatch(connection, "SELECT DB_NAME() AS name");
            const rows = events.flatMap((e) => (e.type === "rows" ? e.rows : []));
            expect(rows[0][0]).toMatchObject({ displayValue: "yast" });
        } finally {
            await connection.close();
        }
    });

    it("times out long commands with commandTimeout", async () => {
        const connection = await connectToDocker({ commandTimeout: 1 });
        const events = await runBatch(connection, "WAITFOR DELAY '00:00:10'");
        expect(messages(events).some((m) => m.isError)).toBe(true);
        await connection.close();
    });
});
