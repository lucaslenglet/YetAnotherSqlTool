import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { SHOWPLAN_COLUMN } from "../../../src/drivers/mssql/execute";
import {
    QUERY_CANCELED_MESSAGE,
    type DriverConnection,
    type ExecuteEvent,
    type ExecutionPlanKind,
} from "../../../src/drivers/types";
import { connectToDocker, runBatch } from "./helpers";

// executeForPlan against the SQL Server test container. Objects created in the yast database are
// named yast_oi_* (see CLAUDE.md).

const TABLE = "dbo.yast_oi_plan_target";

async function runForPlan(
    connection: DriverConnection,
    text: string,
    kind: ExecutionPlanKind,
    signal = new AbortController().signal,
): Promise<ExecuteEvent[]> {
    const events: ExecuteEvent[] = [];
    await connection.executeForPlan!(
        { text, startLine: 0 },
        kind,
        (e) => void events.push(e),
        signal,
    );
    return events;
}

const plans = (events: ExecuteEvent[]) =>
    events.flatMap((e) => (e.type === "executionPlan" ? [e.content] : []));
const errors = (events: ExecuteEvent[]) =>
    events.flatMap((e) => (e.type === "message" && e.isError ? [e.text] : []));
const firstCells = (events: ExecuteEvent[]) =>
    events.flatMap((e) => (e.type === "rows" ? e.rows.map((row) => row[0].displayValue) : []));

/** True when the session runs statements normally: no plan option left on. */
async function expectPlainSession(connection: DriverConnection) {
    const events = await runBatch(connection, "SELECT 42 AS answer");
    expect(events.map((e) => e.type)).toEqual([
        "resultSetStart",
        "rows",
        "resultSetEnd",
        "message",
    ]);
    expect(firstCells(events)).toEqual(["42"]);
}

async function noteOf(connection: DriverConnection, id: number): Promise<string> {
    return firstCells(await runBatch(connection, `SELECT note FROM ${TABLE} WHERE id = ${id}`))[0];
}

describe("executeForPlan (SQL Server)", () => {
    let connection: DriverConnection;
    beforeAll(async () => {
        connection = await connectToDocker();
        await runBatch(
            connection,
            `IF OBJECT_ID('${TABLE}') IS NOT NULL DROP TABLE ${TABLE};
CREATE TABLE ${TABLE} (id INT PRIMARY KEY, note NVARCHAR(20) NOT NULL);
INSERT INTO ${TABLE} (id, note) VALUES (1, N'before');`,
        );
    });
    afterAll(async () => {
        await runBatch(connection, `DROP TABLE IF EXISTS ${TABLE}`);
        await connection.close();
    });

    it("is offered by the SQL Server driver", () => {
        expect(connection.executeForPlan).toBeTypeOf("function");
        expect(mssqlDriver.executionPlan).toBeDefined();
    });

    it("estimated: reports the plan result set, then the plan, without running anything", async () => {
        const events = await runForPlan(
            connection,
            `UPDATE ${TABLE} SET note = N'after' WHERE id = 1;\nSELECT id, note FROM ${TABLE};`,
            "estimated",
        );
        // One plan document for the batch, shown in the grid and then reported.
        expect(events.map((e) => e.type)).toEqual([
            "resultSetStart",
            "rows",
            "resultSetEnd",
            "executionPlan",
            "message",
        ]);
        const start = events[0];
        expect(start.type === "resultSetStart" && start.columns.map((c) => c.columnName)).toEqual([
            SHOWPLAN_COLUMN,
        ]);
        const [xml] = plans(events);
        expect(firstCells(events)).toEqual([xml]);
        // One graph per statement (SQL Server cuts the statement texts at its own boundaries).
        const graphs = mssqlDriver.executionPlan!.parse(xml);
        expect(graphs.map((g) => g.query.trim().replace(/^;\s*/, ""))).toEqual([
            `UPDATE ${TABLE} SET note = N'after' WHERE id = 1`,
            `SELECT id, note FROM ${TABLE}`,
        ]);
        // The UPDATE was compiled, not run.
        expect(await noteOf(connection, 1)).toBe("before");
        await expectPlainSession(connection);
    });

    it("actual: runs every statement, each followed by its plan", async () => {
        const events = await runForPlan(
            connection,
            `UPDATE ${TABLE} SET note = N'actual' WHERE id = 1;\nSELECT note FROM ${TABLE} WHERE id = 1;`,
            "actual",
        );
        expect(events.map((e) => e.type)).toEqual([
            "message", // (1 row affected) of the UPDATE
            "resultSetStart", // its plan
            "rows",
            "resultSetEnd",
            "executionPlan",
            "message",
            "resultSetStart", // the SELECT's rows
            "rows",
            "resultSetEnd",
            "message",
            "resultSetStart", // its plan
            "rows",
            "resultSetEnd",
            "executionPlan",
            "message",
        ]);
        expect(firstCells(events)[1]).toBe("actual");
        const [updatePlan, selectPlan] = plans(events).map((xml) =>
            mssqlDriver.executionPlan!.parse(xml),
        );
        // The actual plan holds the statement as SQL Server parameterized it.
        expect(updatePlan[0].query).toMatch(
            /^UPDATE \[dbo\]\.\[yast_oi_plan_target\] set \[note\] = @1/,
        );
        expect(updatePlan[0].root.children[0].type).toBe("clusteredIndexUpdate");
        // Actual plans carry run-time counters.
        const rowsProperty = selectPlan[0].root.children[0].properties.find(
            (p) => p.name === "Actual Number of Rows for All Executions",
        );
        expect(rowsProperty?.value).toBe("1");
        expect(await noteOf(connection, 1)).toBe("actual");
        await expectPlainSession(connection);
    });

    it("reports the whole XML of a large plan", async () => {
        const union = Array.from(
            { length: 400 },
            (_, i) => `SELECT name FROM sys.objects WHERE object_id = ${i}`,
        ).join("\nUNION ALL ");
        const events = await runForPlan(connection, union, "estimated");
        const [xml] = plans(events);
        expect(xml.length).toBeGreaterThan(500_000);
        expect(xml.endsWith("</ShowPlanXML>")).toBe(true);
        expect(firstCells(events)).toEqual([xml]);
        expect(mssqlDriver.executionPlan!.parse(xml)).toHaveLength(1);
    });

    it("estimated: a statement without a query plan (DDL) gets a plan document and no error", async () => {
        const events = await runForPlan(
            connection,
            "CREATE TABLE #yast_oi_never (id INT)",
            "estimated",
        );
        expect(errors(events)).toEqual([]);
        const [graph] = mssqlDriver.executionPlan!.parse(plans(events)[0]);
        expect(graph.query).toBe("CREATE TABLE #yast_oi_never (id INT)");
        // Not created.
        expect(errors(await runBatch(connection, "SELECT * FROM #yast_oi_never"))).toHaveLength(1);
    });

    for (const kind of ["estimated", "actual"] as const) {
        it(`${kind}: turns the option off when the batch does not compile`, async () => {
            const events = await runForPlan(
                connection,
                "SELECT * FROM dbo.yast_oi_no_such_table",
                kind,
            );
            expect(errors(events)).toEqual([
                "Msg 208, Level 16, State 1, Line 1\nInvalid object name 'dbo.yast_oi_no_such_table'.",
            ]);
            expect(plans(events)).toEqual([]);
            await expectPlainSession(connection);
        });

        it(`${kind}: turns the option off when the batch is canceled`, async () => {
            // Canceled as soon as the first result set starts (an estimated plan takes no time).
            const controller = new AbortController();
            const events: ExecuteEvent[] = [];
            await connection.executeForPlan!(
                { text: "SELECT 1 AS a;\nSELECT 2 AS b;", startLine: 0 },
                kind,
                (event) => {
                    events.push(event);
                    if (event.type === "resultSetStart") controller.abort();
                },
                controller.signal,
            );
            expect(errors(events)).toEqual([QUERY_CANCELED_MESSAGE]);
            await expectPlainSession(connection);
        });

        it(`${kind}: sends nothing when canceled before it starts`, async () => {
            const controller = new AbortController();
            controller.abort();
            const events = await runForPlan(
                connection,
                `UPDATE ${TABLE} SET note = N'never' WHERE id = 1`,
                kind,
                controller.signal,
            );
            expect(events).toEqual([
                { type: "message", text: QUERY_CANCELED_MESSAGE, isError: true },
            ]);
            expect(await noteOf(connection, 1)).not.toBe("never");
            await expectPlainSession(connection);
        });
    }

    it("actual: a long statement is canceled on the server, and the option is turned off", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 300);
        const started = Date.now();
        const events = await runForPlan(
            connection,
            `WAITFOR DELAY '00:00:20';\nUPDATE ${TABLE} SET note = N'too late' WHERE id = 1;`,
            "actual",
            controller.signal,
        );
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(errors(events)).toEqual([QUERY_CANCELED_MESSAGE]);
        expect(await noteOf(connection, 1)).not.toBe("too late");
        await expectPlainSession(connection);
    });

    it("actual: turns the option off after a run-time error", async () => {
        const events = await runForPlan(connection, "SELECT 1 / 0 AS boom;", "actual");
        expect(errors(events)).toEqual([
            "Msg 8134, Level 16, State 1, Line 1\nDivide by zero error encountered.",
        ]);
        await expectPlainSession(connection);
    });

    it("other session requests wait for the plan run: they never see the option on", async () => {
        const run = runForPlan(
            connection,
            "WAITFOR DELAY '00:00:01';\nSELECT id FROM dbo.customers;",
            "actual",
        );
        const [database, databases, plain] = await Promise.all([
            connection.getCurrentDatabase(),
            connection.listDatabases(),
            runBatch(connection, "SELECT 42 AS answer"),
            run,
        ]);
        expect(database).toBe("yast");
        expect(databases).toContain("yast");
        expect(plain.map((e) => e.type)).toEqual([
            "resultSetStart",
            "rows",
            "resultSetEnd",
            "message",
        ]);
        expect(plans(await run)).toHaveLength(1);
    });

    it("leaves execute unchanged: no plan, no option", async () => {
        const events = await runBatch(connection, "SELECT 7 AS seven");
        expect(events.some((e) => e.type === "executionPlan")).toBe(false);
        expect(firstCells(events)).toEqual(["7"]);
    });
});
