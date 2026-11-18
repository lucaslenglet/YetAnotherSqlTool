import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { QueryManager, actualPlanContextKey } from "../../src/queries/queryManager";
import { QueryRunner, type ExecutionPlanEvent } from "../../src/queries/queryRunner";
import type { EditorConnections } from "../../src/queries/editorConnections";
import type { QueryResultWebviewController } from "../../src/queryResult/queryResultWebViewController";
import type {
    Batch,
    Driver,
    DriverConnection,
    DriverId,
    ExecuteEvent,
    ExecutionPlanKind,
} from "../../src/drivers/types";
import { getDriver } from "../../src/drivers";
import {
    QueryResultPaneTabs,
    type QueryResultWebviewState,
} from "../../src/sharedInterfaces/queryResult";
import type { ExecutionPlanGraph } from "../../src/sharedInterfaces/executionPlan";
import { ApiStatus } from "../../src/sharedInterfaces/webview";
import { ExecutionPlanService } from "../../src/services/executionPlanService";
import {
    planSupportContextKey,
    registerExecutionPlanContext,
    registerQueryCommands,
} from "../../src/queries/queryCommands";
import * as Constants from "../../src/constants/constants";
import { saveExecutionPlan, showPlanXml } from "../../src/controllers/sharedExecutionPlanUtils";

/** A graph as a converter returns it: a root operator, its cost, the statement. */
function graph(query: string, cost = 1): ExecutionPlanGraph {
    return {
        root: { name: "SELECT", cost: 0, subTreeCost: cost, children: [] },
        query,
        recommendations: [],
    } as unknown as ExecutionPlanGraph;
}

// Fake converters, whatever the real drivers do: "mssql" stands here for an engine with plans
// ("<plan:...>" documents, one graph per ";"-separated statement) and "pg" for one without.
vi.mock("../../src/drivers", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/drivers")>();
    const withPlans: Driver = {
        ...original.getDriver("mssql"),
        executionPlan: {
            fileExtension: "sqlplan",
            documentLanguage: "xml",
            parse: (content: string) => {
                const match = /^<plan:(.*)>$/.exec(content);
                if (!match) {
                    throw new Error("Not a plan document.");
                }
                return match[1].split(";").map((q) => graph(q));
            },
        },
    };
    const withoutPlans: Driver = { ...original.getDriver("pg"), executionPlan: undefined };
    return {
        ...original,
        getDriver: (provider: DriverId | undefined) =>
            (provider ?? "mssql") === "mssql" ? withPlans : withoutPlans,
    };
});

const resultSet = (value: string): ExecuteEvent[] => [
    { type: "resultSetStart", columns: [{ columnName: "c", dataTypeName: "int", kind: "number" }] },
    { type: "rows", rows: [[{ displayValue: value, isNull: false }]] },
    { type: "resultSetEnd", rowCount: 1 },
];

/** A connection that records how each batch was run and plays `events(batch, kind)`. */
function fakeConnection(
    events: (batch: Batch, kind?: ExecutionPlanKind) => ExecuteEvent[],
    withPlans = true,
) {
    const calls: { text: string; kind?: ExecutionPlanKind }[] = [];
    const play = async (
        batch: Batch,
        kind: ExecutionPlanKind | undefined,
        onEvent: (e: ExecuteEvent) => void | Promise<void>,
    ) => {
        calls.push({ text: batch.text, kind });
        for (const event of events(batch, kind)) {
            await onEvent(event);
        }
    };
    const connection = {
        execute: (batch: Batch, onEvent: (e: ExecuteEvent) => void) =>
            play(batch, undefined, onEvent),
        describeObject: async (_name: string, onEvent: (e: ExecuteEvent) => void) => {
            calls.push({ text: "<describe>" });
            for (const event of resultSet("info")) onEvent(event);
        },
        ...(withPlans && {
            executeForPlan: (
                batch: Batch,
                kind: ExecutionPlanKind,
                onEvent: (e: ExecuteEvent) => void,
            ) => play(batch, kind, onEvent),
        }),
    } as unknown as DriverConnection;
    return { connection, calls };
}

/** Plays a showplan-like run: the rows, then for a plan run the plan as a result set and an event. */
const planEvents =
    (document: (batch: Batch) => string) =>
    (batch: Batch, kind?: ExecutionPlanKind): ExecuteEvent[] => {
        const rows = kind === "estimated" ? [] : resultSet("row");
        if (!kind) {
            return rows;
        }
        return [
            ...rows,
            ...resultSet(document(batch)),
            { type: "executionPlan", content: document(batch) },
        ];
    };

describe("QueryRunner with execution plans", () => {
    it("runs each batch through executeForPlan and reports its plans", async () => {
        const { connection, calls } = fakeConnection(planEvents((b) => `<plan:${b.text}>`));
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        const plans: ExecutionPlanEvent[] = [];
        let output = "";
        runner.onExecutionPlan((e) => plans.push(e));
        runner.onMessage((m) => (output += m.message));

        await runner.run(
            getDriver("mssql"),
            connection,
            "SELECT 1\nGO\nSELECT 2",
            { line: 0, column: 0 },
            "actual",
        );

        expect(calls).toEqual([
            { text: "SELECT 1", kind: "actual" },
            { text: "SELECT 2", kind: "actual" },
        ]);
        expect(runner.executionPlanKind).toBe("actual");
        // Each plan follows the result set that shows its document: that is its result set.
        expect(plans).toEqual([
            { batchId: 0, resultId: 1, planIndex: 0, content: "<plan:SELECT 1>" },
            { batchId: 1, resultId: 1, planIndex: 0, content: "<plan:SELECT 2>" },
        ]);
        expect(output).not.toContain("Commands completed successfully.");
    });

    it("counts a plan without result set as output and numbers it in its batch", async () => {
        const { connection } = fakeConnection(() => [
            { type: "executionPlan", content: "<plan:a>" },
            { type: "message", text: "EXPLAIN", isError: false },
            { type: "executionPlan", content: "<plan:b>" },
        ]);
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        const plans: ExecutionPlanEvent[] = [];
        const messages: string[] = [];
        runner.onExecutionPlan((e) => plans.push(e));
        runner.onMessage((m) => messages.push(m.message));
        await runner.run(getDriver("mssql"), connection, "x", { line: 0, column: 0 }, "estimated");
        expect(plans.map((p) => [p.resultId, p.planIndex])).toEqual([
            [undefined, 0],
            [undefined, 1],
        ]);
        expect(messages).not.toContain("Commands completed successfully.");
    });

    it("runs through execute without a plan kind, and forgets the kind of the previous run", async () => {
        const { connection, calls } = fakeConnection(planEvents((b) => `<plan:${b.text}>`));
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        await runner.run(
            getDriver("mssql"),
            connection,
            "SELECT 1",
            { line: 0, column: 0 },
            "estimated",
        );
        await runner.run(getDriver("mssql"), connection, "SELECT 1", { line: 0, column: 0 });
        expect(calls.map((c) => c.kind)).toEqual(["estimated", undefined]);
        expect(runner.executionPlanKind).toBeUndefined();
    });

    it("refuses a plan run on a connection without executeForPlan", async () => {
        const { connection, calls } = fakeConnection(() => [], false);
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        await expect(
            runner.run(getDriver("pg"), connection, "SELECT 1", { line: 0, column: 0 }, "actual"),
        ).rejects.toThrow();
        expect(calls).toEqual([]);
        expect(runner.isExecuting).toBe(false);
    });

    it("can cancel a plan run", async () => {
        let aborted: (() => void) | undefined;
        const connection = {
            executeForPlan: (_b: Batch, _k: ExecutionPlanKind, _e: unknown, signal: AbortSignal) =>
                new Promise<void>((resolve) => {
                    aborted = resolve;
                    signal.addEventListener("abort", () => resolve());
                }),
        } as unknown as DriverConnection;
        const runner = new QueryRunner("file:///a.sql", "a.sql");
        let canceled: boolean | undefined;
        runner.onComplete((e) => (canceled = e.isCanceled));
        const run = runner.run(
            getDriver("mssql"),
            connection,
            "SELECT 1",
            { line: 0, column: 0 },
            "actual",
        );
        await vi.waitFor(() => expect(aborted).toBeDefined());
        runner.cancel();
        await run;
        expect(canceled).toBe(true);
    });
});

// -- QueryManager ---------------------------------------------------------------------------

/** An editor on `text` with the cursor at the start, or selecting `selected` when given. */
function editor(text: string, uri = "untitled:Untitled-1"): vscode.TextEditor {
    const lines = text.split("\n");
    const offset = (p: vscode.Position) =>
        p.line >= lines.length
            ? text.length
            : lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    const selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    return {
        document: {
            uri: vscode.Uri.parse(uri),
            languageId: "sql",
            lineCount: lines.length,
            getText: (range?: vscode.Range) =>
                range ? text.slice(offset(range.start), offset(range.end)) : text,
        },
        selection,
        selections: [selection],
    } as unknown as vscode.TextEditor;
}

function setup(
    provider: DriverId,
    events: (batch: Batch, kind?: ExecutionPlanKind) => ExecuteEvent[],
    withPlans = provider === "mssql",
) {
    const { connection, calls } = fakeConnection(events, withPlans);
    const connections = {
        isConnected: () => true,
        get: () => ({ profile: { provider }, connection, database: "db" }),
        setRunning: () => undefined,
        refreshDatabase: async () => undefined,
    } as unknown as EditorConnections;
    const states = new Map<string, QueryResultWebviewState>();
    const results = {
        set queryManager(_: unknown) {},
        isVisible: () => false,
        hasPanel: () => false,
        revealPanel: vi.fn(),
        addQueryResultState: vi.fn((uri: string, title: string, isExecutionPlan?: boolean) => {
            states.set(uri, {
                uri,
                title,
                messages: [],
                resultSetSummaries: {},
                tabStates: { resultPaneTab: QueryResultPaneTabs.Messages },
                isExecutionPlan,
                executionPlanState: isExecutionPlan
                    ? {
                          loadState: ApiStatus.Loading,
                          executionPlanGraphs: [],
                          totalCost: 0,
                          xmlPlans: {},
                      }
                    : {},
            } as unknown as QueryResultWebviewState);
        }),
        getQueryResultState: (uri: string) => states.get(uri)!,
        hasQueryResultState: (uri: string) => states.has(uri),
        deleteQueryResultState: (uri: string) => states.delete(uri),
        pushState: vi.fn(),
    };
    const manager = new QueryManager(
        connections,
        results as unknown as QueryResultWebviewController,
    );
    const state = (uri = "untitled:Untitled-1") => states.get(uri)!;
    return { manager, calls, results, state };
}

const noConnect = async () => false;
const document = (b: Batch) => `<plan:${b.text.replace(/;$/, "")}>`;

describe("QueryManager and execution plans", () => {
    beforeEach(() => {
        vi.mocked(vscode.window.showInformationMessage).mockClear();
        vi.mocked(vscode.commands.executeCommand).mockClear();
    });

    it("shows the estimated plan of the whole text in the Query Plan tab", async () => {
        const { manager, calls, results, state } = setup("mssql", planEvents(document));
        await manager.showEstimatedPlan(editor("SELECT 1;SELECT 2"), noConnect);

        expect(calls).toEqual([{ text: "SELECT 1;SELECT 2", kind: "estimated" }]);
        expect(results.addQueryResultState).toHaveBeenCalledWith(
            "untitled:Untitled-1",
            expect.any(String),
            true,
        );
        const s = state();
        expect(s.isExecutionPlan).toBe(true);
        expect(s.executionPlanState.loadState).toBe(ApiStatus.Loaded);
        expect(s.executionPlanState.executionPlanGraphs?.map((g) => g.query)).toEqual([
            "SELECT 1",
            "SELECT 2",
        ]);
        expect(s.executionPlanState.totalCost).toBe(2);
        // Every graph keeps its document, for "Open XML", "Save Plan" and links in the grid.
        expect(s.executionPlanState.executionPlanGraphs?.[1].graphFile).toEqual({
            graphFileContent: "<plan:SELECT 1;SELECT 2>",
            graphFileType: ".sqlplan",
            planIndexInFile: 1,
        });
        expect(Object.values(s.executionPlanState.xmlPlans ?? {})).toEqual([
            "<plan:SELECT 1;SELECT 2>",
        ]);
        // The showplan result set does not take the front: the plan does, when the run completes.
        expect(s.tabStates?.resultPaneTab).toBe(QueryResultPaneTabs.ExecutionPlan);
    });

    it("runs Execute Query and Execute Current Statement with the actual plan of that editor only", async () => {
        const { manager, calls, state } = setup("mssql", planEvents(document));
        manager.setActualPlanEnabled("untitled:Untitled-1", true);
        expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith(
            "setContext",
            actualPlanContextKey,
            ["untitled:Untitled-1"],
        );
        expect(manager.isActualPlanEnabled("untitled:Untitled-1")).toBe(true);

        await manager.runQuery(editor("SELECT 1"), noConnect);
        await manager.runCurrentStatement(editor("SELECT 2"), noConnect);
        await manager.runQuery(editor("SELECT 3", "untitled:Untitled-2"), noConnect);
        expect(calls).toEqual([
            { text: "SELECT 1", kind: "actual" },
            { text: "SELECT 2", kind: "actual" },
            { text: "SELECT 3", kind: undefined },
        ]);
        // An actual plan run shows its rows first, as SSMS does; the plan is in its tab.
        expect(state().tabStates?.resultPaneTab).toBe(QueryResultPaneTabs.Results);
        expect(state().executionPlanState.executionPlanGraphs?.map((g) => g.query)).toEqual([
            "SELECT 2",
        ]);
        expect(state("untitled:Untitled-2").isExecutionPlan).toBeFalsy();

        manager.setActualPlanEnabled("untitled:Untitled-1", false);
        expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith(
            "setContext",
            actualPlanContextKey,
            [],
        );
        await manager.runQuery(editor("SELECT 4"), noConnect);
        expect(calls[3]).toEqual({ text: "SELECT 4", kind: undefined });
    });

    it("keeps Alt+F1 (object information) away from the actual plan", async () => {
        const { manager, calls } = setup("mssql", planEvents(document));
        manager.setActualPlanEnabled("untitled:Untitled-1", true);
        await manager.showObjectInformation(editor("t"), "t", noConnect);
        expect(calls).toEqual([{ text: "<describe>" }]);
    });

    it("forgets the actual plan of an editor that closes", async () => {
        const { manager } = setup("mssql", planEvents(document));
        manager.setActualPlanEnabled("untitled:Untitled-1", true);
        manager.onDidCloseTextDocument(editor("").document);
        expect(manager.isActualPlanEnabled("untitled:Untitled-1")).toBe(false);
        expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith(
            "setContext",
            actualPlanContextKey,
            [],
        );
    });

    it("shows the converter's error in the Query Plan tab, and stops there", async () => {
        const { manager, state } = setup("mssql", () => [
            { type: "executionPlan", content: "not a plan" },
            { type: "executionPlan", content: "<plan:SELECT 1>" },
        ]);
        await manager.showEstimatedPlan(editor("SELECT 1"), noConnect);
        const s = state();
        expect(s.isExecutionPlan).toBe(true);
        expect(s.executionPlanState.loadState).toBe(ApiStatus.Error);
        expect(s.executionPlanState.errorMessage).toBe("Not a plan document.");
        expect(s.executionPlanState.executionPlanGraphs).toEqual([]);
        expect(s.tabStates?.resultPaneTab).toBe(QueryResultPaneTabs.ExecutionPlan);
    });

    it("shows Messages, not the plan, when the estimated run fails", async () => {
        const { manager, state } = setup("mssql", () => [
            { type: "message", text: "Invalid object name 'x'.", isError: true },
        ]);
        await manager.showEstimatedPlan(editor("SELECT * FROM x"), noConnect);
        expect(state().tabStates?.resultPaneTab).toBe(QueryResultPaneTabs.Messages);
    });

    it("offers no plan for an engine without them", async () => {
        const { manager, calls, results } = setup("pg", planEvents(document));
        await manager.showEstimatedPlan(editor("SELECT 1"), noConnect);
        expect(calls).toEqual([]);
        expect(results.addQueryResultState).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            "Execution plans are not available for PostgreSQL connections.",
        );

        // An actual plan turned on earlier (on another connection) does not apply here.
        manager.setActualPlanEnabled("untitled:Untitled-1", true);
        await manager.runQuery(editor("SELECT 1"), noConnect);
        expect(calls).toEqual([{ text: "SELECT 1", kind: undefined }]);
        expect(results.addQueryResultState).toHaveBeenCalledWith(
            "untitled:Untitled-1",
            expect.any(String),
            false,
        );
    });

    it("finds the plan a grid cell showed by its result set, even when the texts differ", async () => {
        // As PostgreSQL does: the cell shows the document without what the reported one adds.
        const { manager } = setup("mssql", (batch) => [
            ...resultSet(`cell of ${batch.text}`),
            { type: "executionPlan", content: `<plan:${batch.text}>` },
        ]);
        await manager.showEstimatedPlan(editor("SELECT 1;SELECT 2"), noConnect);
        const uri = "untitled:Untitled-1";
        await expect(
            manager.getExecutionPlanIndexOfCell(uri, "cell of SELECT 1;SELECT 2"),
        ).resolves.toBe(0);
        await expect(manager.getExecutionPlanIndexOfCell(uri, "<other/>")).resolves.toBe(-1);
        await expect(
            manager.getExecutionPlanIndexOfCell("untitled:Untitled-9", "cell of SELECT 1"),
        ).resolves.toBe(-1);
    });

    it("still records the documents that come after one in error", async () => {
        const { manager, state } = setup("mssql", () => [
            ...resultSet("a"),
            { type: "executionPlan", content: "bad" },
            ...resultSet("b"),
            { type: "executionPlan", content: "<plan:SELECT 2>" },
        ]);
        await manager.showEstimatedPlan(editor("SELECT 1"), noConnect);
        expect(state().executionPlanState.loadState).toBe(ApiStatus.Error);
        expect(Object.keys(state().executionPlanState.xmlPlans ?? {})).toEqual(["0,0", "0,1"]);
    });

    it("reads the plan documents of a result with the engine of its run", async () => {
        const { manager } = setup("mssql", planEvents(document));
        await manager.runQuery(editor("SELECT 1"), noConnect);
        expect(manager.getExecutionPlanSupport("untitled:Untitled-1")?.fileExtension).toBe(
            "sqlplan",
        );
        expect(manager.getExecutionPlanSupport(undefined)).toBeUndefined();
    });
});

describe("ExecutionPlanService", () => {
    it("rethrows the converter's error", async () => {
        const service = new ExecutionPlanService(getDriver("mssql").executionPlan!);
        await expect(
            service.getExecutionPlan({ graphFileContent: "nope", graphFileType: ".sqlplan" }),
        ).rejects.toThrow("Not a plan document.");
    });
});

describe("Save Plan and Open XML", () => {
    it("save and open a JSON plan as JSON, with a filter that does not say SQL plan", async () => {
        const writeFile = vi.fn(async () => undefined);
        const showSaveDialog = vi.fn(async (options: any) => {
            expect(options.filters).toEqual({ "Execution Plan Files": ["json"] });
            expect(String(options.defaultUri.path ?? options.defaultUri)).toMatch(/plan\.json$/);
            return vscode.Uri.parse("file:///tmp/plan.json");
        });
        const openTextDocument = vi.fn(async (options: any) => options);
        Object.assign(vscode.window, { showSaveDialog, showTextDocument: vi.fn() });
        Object.assign(vscode.workspace, {
            fs: { stat: async () => Promise.reject(new Error("none")), writeFile },
            openTextDocument,
        });
        const state = { executionPlanState: {} };
        const json = { fileExtension: "json", documentLanguage: "json" };
        await saveExecutionPlan(state, { sqlPlanContent: "[1]" }, json);
        expect(writeFile).toHaveBeenCalledOnce();
        await showPlanXml(state, { sqlPlanContent: '[{"a":1}]' }, json);
        expect(openTextDocument).toHaveBeenCalledWith({
            content: '[\n  {\n    "a": 1\n  }\n]',
            language: "json",
        });
    });

    it("keep SQL Server's .sqlplan filter", async () => {
        const showSaveDialog = vi.fn(async (_options: any) => undefined);
        Object.assign(vscode.window, { showSaveDialog });
        Object.assign(vscode.workspace, { fs: { stat: async () => Promise.reject(new Error()) } });
        await saveExecutionPlan(
            { executionPlanState: {} },
            { sqlPlanContent: "<x/>" },
            { fileExtension: "sqlplan" },
        );
        expect(showSaveDialog.mock.calls[0][0].filters).toEqual({
            "SQL Plan Files": ["sqlplan"],
        });
    });
});

describe("plan commands", () => {
    function setupCommands() {
        const handlers = new Map<string, (...args: any[]) => unknown>();
        vi.spyOn(vscode.commands, "registerCommand").mockImplementation(((
            command: string,
            handler: (...args: any[]) => unknown,
        ) => {
            handlers.set(command, handler);
            return { dispose: () => undefined };
        }) as any);
        const e = editor("SELECT 1");
        (vscode.window as any).activeTextEditor = e;
        const enabled = new Set<string>();
        const queries = {
            showEstimatedPlan: vi.fn(async () => undefined),
            isActualPlanEnabled: (uri: string) => enabled.has(uri),
            setActualPlanEnabled: vi.fn((uri: string, on: boolean) =>
                on ? enabled.add(uri) : enabled.delete(uri),
            ),
        };
        registerQueryCommands({ subscriptions: [] } as any, {} as any, {} as any, queries as any);
        return { run: (command: string) => handlers.get(command)!(), queries, enabled, e };
    }

    it("show the estimated plan of the active SQL editor", async () => {
        const { run, queries, e } = setupCommands();
        await run(Constants.cmdShowEstimatedPlan);
        expect(queries.showEstimatedPlan).toHaveBeenCalledWith(e, expect.any(Function));
    });

    it("enable, disable and toggle the actual plan of the active editor", async () => {
        const { run, enabled } = setupCommands();
        await run(Constants.cmdEnableActualPlan);
        expect([...enabled]).toEqual(["untitled:Untitled-1"]);
        await run(Constants.cmdDisableActualPlan);
        expect([...enabled]).toEqual([]);
        await run(Constants.cmdToggleActualPlan);
        expect([...enabled]).toEqual(["untitled:Untitled-1"]);
        await run(Constants.cmdToggleActualPlan);
        expect([...enabled]).toEqual([]);
    });
});

describe("the plan support context key", () => {
    it("lists the connected editors whose engine has plans", () => {
        const listeners: ((uri: string) => void)[] = [];
        const connected = new Map<string, DriverId>();
        const connections = {
            onDidChange: (listener: (uri: string) => void) => {
                listeners.push(listener);
                return { dispose: () => undefined };
            },
            get: (uri: string) =>
                connected.has(uri)
                    ? {
                          profile: { provider: connected.get(uri) },
                          connection: fakeConnection(() => [], connected.get(uri) === "mssql")
                              .connection,
                      }
                    : undefined,
        } as unknown as EditorConnections;
        registerExecutionPlanContext({ subscriptions: [] } as any, connections);
        const fire = (uri: string) => listeners.forEach((l) => l(uri));
        vi.mocked(vscode.commands.executeCommand).mockClear();

        connected.set("a", "mssql");
        fire("a");
        connected.set("b", "pg");
        fire("b");
        expect(vi.mocked(vscode.commands.executeCommand).mock.calls).toEqual([
            ["setContext", planSupportContextKey, ["a"]],
        ]);
        connected.set("a", "pg");
        fire("a");
        expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith(
            "setContext",
            planSupportContextKey,
            [],
        );
    });
});
