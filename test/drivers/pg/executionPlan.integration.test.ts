import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDriver } from "../../../src/drivers/pg";
import type { DriverConnection, ExecuteEvent, ExecutionPlanKind } from "../../../src/drivers/types";
import type {
    ExecutionPlanGraph,
    ExecutionPlanNode,
} from "../../../src/sharedInterfaces/executionPlan";
import { pgOptions } from "../../support/databases";

// Own schema: the integration test files run in parallel against the same server.
const SCHEMA = "yast_ep_test";

let connection: DriverConnection;

beforeAll(async () => {
    connection = await pgDriver.connect({ options: pgOptions() });
    await run(
        `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
         CREATE TABLE ${SCHEMA}.t (id int PRIMARY KEY, label text);
         INSERT INTO ${SCHEMA}.t SELECT g, 'row ' || g FROM generate_series(1, 100) g;
         ANALYZE ${SCHEMA}.t;`,
    );
});

afterAll(async () => {
    await run(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await connection.close();
});

/** Runs a script with `execute` (setup, checks). */
async function run(script: string): Promise<ExecuteEvent[]> {
    const events: ExecuteEvent[] = [];
    for (const batch of pgDriver.splitBatches(script)) {
        await connection.execute(batch, (e) => events.push(e), new AbortController().signal);
    }
    return events;
}

/** Runs a script with `executeForPlan`. */
async function plan(
    kind: ExecutionPlanKind,
    script: string,
    signal = new AbortController().signal,
): Promise<ExecuteEvent[]> {
    const events: ExecuteEvent[] = [];
    for (const batch of pgDriver.splitBatches(script)) {
        await connection.executeForPlan!(batch, kind, (e) => events.push(e), signal);
    }
    return events;
}

async function count(where = "true"): Promise<number> {
    const events = await run(`SELECT count(*) FROM ${SCHEMA}.t WHERE ${where}`);
    const rows = events.flatMap((e) => (e.type === "rows" ? e.rows : []));
    return Number(rows[0][0].displayValue);
}

const messages = (events: ExecuteEvent[]) =>
    events.flatMap((e) => (e.type === "message" ? [e] : []));
const errors = (events: ExecuteEvent[]) => messages(events).filter((m) => m.isError);
const planContents = (events: ExecuteEvent[]) =>
    events.flatMap((e) => (e.type === "executionPlan" ? [e.content] : []));
const graphsOf = (events: ExecuteEvent[]) =>
    planContents(events).flatMap((content) => pgDriver.executionPlan!.parse(content));
/** The plan's top operator: the root of a graph is its statement node. */
const top = (graph: ExecutionPlanGraph) => graph.root.children[0];
const property = (node: ExecutionPlanNode, name: string) =>
    node.properties.find((p) => p.name === name);

describe("driver", () => {
    it("has execution plans and a connection that runs them", () => {
        expect(pgDriver.executionPlan).toBeDefined();
        expect(connection.executeForPlan).toBeDefined();
    });
});

describe("estimated plan", () => {
    it("shows the plan as a result set, then reports the document", async () => {
        const events = await plan("estimated", `SELECT * FROM ${SCHEMA}.t WHERE id < 10`);
        expect(errors(events)).toEqual([]);
        const types = events.map((e) => e.type);
        // The result set first, the document right after its end.
        expect(types.slice(0, 4)).toEqual([
            "resultSetStart",
            "rows",
            "resultSetEnd",
            "executionPlan",
        ]);
        const start = events[0];
        if (start.type !== "resultSetStart") throw new Error("no result set");
        expect(start.columns).toHaveLength(1);
        expect(start.columns[0]).toMatchObject({ columnName: "QUERY PLAN", isJson: true });
        const rows = events[1];
        if (rows.type !== "rows") throw new Error("no rows");
        expect(rows.rows).toHaveLength(1);
        // The cell is the JSON text the server returned.
        const cell = JSON.parse(rows.rows[0][0].displayValue);
        expect(cell[0].Plan["Node Type"]).toBeDefined();
        expect(cell[0]["Query Text"]).toBeUndefined();

        const [graph] = graphsOf(events);
        expect(graph.query).toBe(`SELECT * FROM ${SCHEMA}.t WHERE id < 10`);
        expect(top(graph).name).toContain(`${SCHEMA}.t`);
        expect(property(top(graph), "Actual Loops")).toBeUndefined();
        expect(top(graph)).not.toHaveProperty("liveQueryStatistics");
        expect(graph).not.toHaveProperty("liveQueryStatistics");
        // The root is the statement node, named after the statement's kind.
        expect(graph.root).toMatchObject({ name: "SELECT", type: "result", cost: 0 });
        expect(property(graph.root, "Statement")!.value).toBe(graph.query);
    });

    it("does not run the statement", async () => {
        const before = await count();
        const events = await plan(
            "estimated",
            `INSERT INTO ${SCHEMA}.t SELECT g + 1000, 'x' FROM generate_series(1, 5) g`,
        );
        expect(errors(events)).toEqual([]);
        expect(await count()).toBe(before);
        const [graph] = graphsOf(events);
        expect(top(graph).name).toBe(`Insert\n${SCHEMA}.t`);
        expect(top(graph).type).toBe("table_insert");
    });

    it("does not send a statement EXPLAIN does not apply to, and says so", async () => {
        const events = await plan(
            "estimated",
            `CREATE TABLE ${SCHEMA}.never_created (a int); SELECT 1; SET search_path = ${SCHEMA}`,
        );
        expect(errors(events)).toEqual([]);
        expect(planContents(events)).toHaveLength(1);
        const texts = messages(events).map((m) => m.text);
        expect(texts.some((t) => t.includes("(CREATE TABLE)") && t.includes("not run"))).toBe(true);
        expect(texts.some((t) => t.includes("(SET)"))).toBe(true);
        // Nothing ran: the table does not exist and the setting is unchanged.
        expect(
            errors(await run(`SELECT * FROM ${SCHEMA}.never_created`)).map((m) => m.text),
        ).toEqual([expect.stringContaining("does not exist")]);
        const path = await run("SHOW search_path");
        const shown = path.flatMap((e) => (e.type === "rows" ? e.rows : []));
        expect(shown[0][0].displayValue).not.toContain(SCHEMA);
    });

    it("does not run an EXPLAIN ANALYZE the user wrote, but runs a plain EXPLAIN", async () => {
        const before = await count();
        const analyzed = await plan(
            "estimated",
            `EXPLAIN ANALYZE INSERT INTO ${SCHEMA}.t VALUES (5000, 'a')`,
        );
        expect(errors(analyzed)).toEqual([]);
        expect(await count()).toBe(before);
        expect(messages(analyzed).map((m) => m.text)).toEqual([
            expect.stringContaining("was not run"),
        ]);

        const plain = await plan("estimated", `EXPLAIN SELECT * FROM ${SCHEMA}.t`);
        expect(errors(plain)).toEqual([]);
        // Run as written: its text result set, and no plan document.
        expect(planContents(plain)).toEqual([]);
        expect(plain.map((e) => e.type)).toContain("rows");
    });

    it("reports one document per statement, with the statement text of each", async () => {
        const script = [
            `-- first`,
            `SELECT 1 AS one; /* second */ SELECT ';' AS "semi;colon", $$a;b$$`,
            `;`,
            `(SELECT 3) UNION (SELECT 4)`,
        ].join("\n");
        const events = await plan("estimated", script);
        expect(errors(events)).toEqual([]);
        const graphs = graphsOf(events);
        expect(graphs.map((g) => g.query)).toEqual([
            "-- first\nSELECT 1 AS one",
            `/* second */ SELECT ';' AS "semi;colon", $$a;b$$`,
            "(SELECT 3) UNION (SELECT 4)",
        ]);
    });

    it("produces a document that parses without any connection", async () => {
        const [content] = planContents(
            await plan("estimated", `SELECT * FROM ${SCHEMA}.t WHERE id = 5`),
        );
        const parsed = JSON.parse(content);
        expect(parsed[0]["Query Text"]).toBe(`SELECT * FROM ${SCHEMA}.t WHERE id = 5`);
        // A table of 100 rows may be scanned or seeked: both are table or index operators.
        expect(["table_scan", "index_seek"]).toContain(
            top(pgDriver.executionPlan!.parse(content)[0]).type,
        );
    });
});

describe("actual plan", () => {
    it("runs the statement, keeps its effects and returns the plan, not the rows", async () => {
        const before = await count("id >= 2000");
        const events = await plan(
            "actual",
            `INSERT INTO ${SCHEMA}.t SELECT g + 2000, 'y' FROM generate_series(1, 7) g RETURNING id`,
        );
        expect(errors(events)).toEqual([]);
        expect(await count("id >= 2000")).toBe(before + 7);
        // The only result set is the plan: RETURNING rows are not sent.
        const sets = events.filter((e) => e.type === "resultSetStart");
        expect(sets).toHaveLength(1);
        expect(sets[0]).toMatchObject({ columns: [{ columnName: "QUERY PLAN" }] });
        const [graph] = graphsOf(events);
        expect(top(graph).name).toBe(`Insert\n${SCHEMA}.t`);
        expect(property(top(graph), "Actual Loops")!.value).toBe("1");
        expect(property(graph.root, "Execution Time")).toBeDefined();
        expect(messages(events).map((m) => m.text)).toEqual([
            expect.stringContaining("the statement was run"),
        ]);
    });

    it("updates for real, and reports counters", async () => {
        await plan("actual", `UPDATE ${SCHEMA}.t SET label = 'updated' WHERE id <= 10`);
        expect(await count("label = 'updated'")).toBe(10);
        const events = await plan("actual", `SELECT * FROM ${SCHEMA}.t WHERE id <= 40`);
        const [graph] = graphsOf(events);
        const scan = top(graph);
        expect(property(scan, "Actual Number of Rows for All Executions")!.value).toBe("40");
        expect(scan.rowCountDisplayString).toBe("40");
        // The counters of the page ("Rows: 40 of N", "Elapsed"), on the operator, statement, graph.
        expect(scan.liveQueryStatistics).toMatchObject({ actualRows: "40" });
        expect(scan.liveQueryStatistics!.estimatedRows).toBeGreaterThan(0);
        expect(scan.liveQueryStatistics!.elapsedTimeInMs).toBeGreaterThanOrEqual(0);
        expect(graph.root.liveQueryStatistics!.elapsedTimeInMs).toBeGreaterThan(0);
        expect(graph.liveQueryStatistics).toEqual(graph.root.liveQueryStatistics);
        expect(top(graph).elapsedTimeInMs).toBeGreaterThanOrEqual(0);
        expect(property(top(graph), "Shared Hit Blocks")).toBeDefined();
    });

    it("runs statements EXPLAIN does not apply to as execute does", async () => {
        const events = await plan(
            "actual",
            `CREATE TABLE ${SCHEMA}.made (a int); INSERT INTO ${SCHEMA}.made VALUES (1); SELECT a FROM ${SCHEMA}.made`,
        );
        expect(errors(events)).toEqual([]);
        expect(messages(events).map((m) => m.text)).toContain("CREATE TABLE");
        // The table exists and holds the row.
        expect(
            (await run(`SELECT count(*) FROM ${SCHEMA}.made`)).flatMap((e) =>
                e.type === "rows" ? e.rows : [],
            )[0][0].displayValue,
        ).toBe("1");
        expect(graphsOf(events)).toHaveLength(2);
    });

    it("lets the user wrap statements in a transaction of their own", async () => {
        const before = await count();
        const events = await plan(
            "actual",
            `BEGIN; DELETE FROM ${SCHEMA}.t WHERE id < 50; ROLLBACK`,
        );
        expect(errors(events)).toEqual([]);
        expect(graphsOf(events)).toHaveLength(1);
        expect(await count()).toBe(before);
    });

    it("declares a cursor for real, which EXPLAIN ANALYZE DECLARE would not", async () => {
        const events = await plan(
            "actual",
            `BEGIN; DECLARE c CURSOR FOR SELECT id FROM ${SCHEMA}.t ORDER BY id; FETCH 3 FROM c; COMMIT`,
        );
        expect(errors(events)).toEqual([]);
        const rows = events.flatMap((e) => (e.type === "rows" ? e.rows : []));
        expect(rows.map((r) => r[0].displayValue)).toEqual(["1", "2", "3"]);
    });

    it("runs a statement that is already an EXPLAIN as written", async () => {
        const events = await plan("actual", `EXPLAIN (COSTS off) SELECT * FROM ${SCHEMA}.t`);
        expect(errors(events)).toEqual([]);
        expect(planContents(events)).toEqual([]);
        const rows = events.flatMap((e) => (e.type === "rows" ? e.rows : []));
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0][0].displayValue).toContain("Scan");
    });
});

describe.each(["estimated", "actual"] as const)("errors in a batch (%s)", (kind) => {
    it("stops at the failing statement and positions the error in the script", async () => {
        const script = "SELECT 1;\nSELECT *\n  FROM yast_ep_missing_table;\nSELECT 3";
        const events = await plan(kind, script);
        expect(planContents(events)).toHaveLength(1);
        const [error] = errors(events);
        expect(error.text).toContain('relation "yast_ep_missing_table" does not exist');
        // "yast_ep_missing_table" starts on the third line, column 7 (0-based).
        expect(error.type === "message" && error.position).toEqual({ line: 2, column: 7 });
        // The third statement did not run: a single failing message, no further plan.
        expect(events[events.length - 1]).toBe(error);
    });

    it("reports a plan error of the first statement without any plan", async () => {
        const events = await plan(kind, "SELECT 1/0::int FROM nope");
        expect(planContents(events)).toEqual([]);
        expect(errors(events)).toHaveLength(1);
    });
});

describe("cancellation", () => {
    it("cancels a slow EXPLAIN ANALYZE on the server and leaves the session usable", async () => {
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(), 300);
        const events = await plan(
            "actual",
            "SELECT pg_sleep(30); SELECT 'never'",
            controller.signal,
        );
        expect(Date.now() - started).toBeLessThan(10000);
        expect(planContents(events)).toEqual([]);
        expect(messages(events)).toEqual([
            { type: "message", text: "Query was canceled by user.", isError: true },
        ]);
        const after = await run("SELECT 5");
        expect(after.flatMap((e) => (e.type === "rows" ? e.rows : []))[0][0].displayValue).toBe(
            "5",
        );
    });

    it("runs nothing when already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const events = await plan("actual", `DELETE FROM ${SCHEMA}.t`, controller.signal);
        expect(messages(events).map((m) => m.text)).toEqual(["Query was canceled by user."]);
        expect(await count()).toBeGreaterThan(0);
    });
});

describe("plans of the planner's own features", () => {
    it("shows the settings that differ from the default", async () => {
        const events = await plan(
            "estimated",
            `SET random_page_cost = 1.1; SELECT * FROM ${SCHEMA}.t`,
        );
        // SET is not sent in an estimated plan: the setting does not apply.
        const estimated = property(graphsOf(events)[0].root, "Settings")!;
        expect(JSON.stringify(estimated.value)).not.toContain("random_page_cost");
        const actual = await plan(
            "actual",
            `SET random_page_cost = 1.1; SELECT * FROM ${SCHEMA}.t`,
        );
        const settings = property(graphsOf(actual)[0].root, "Settings")!;
        expect(JSON.stringify(settings.value)).toContain("random_page_cost");
        await run("RESET random_page_cost");
    });

    it("reports a sort that spills with a small work_mem as a warning", async () => {
        const events = await plan(
            "actual",
            `SET work_mem = '64kB'; SELECT * FROM generate_series(1, 50000) g ORDER BY md5(g::text)`,
        );
        await run("RESET work_mem");
        const [graph] = graphsOf(events);
        const sort = [top(graph), ...top(graph).children].find((n) => n.name.startsWith("Sort"))!;
        expect(sort.badges.map((b) => b.tooltip).join()).toMatch(/spilled to disk/);
    });
});
