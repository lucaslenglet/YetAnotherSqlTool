// Execution plans on SQL Server, used as a user does: the plan buttons of the editor title, the
// Query Plan tab of the results, a node and its properties, the actual plan of a real run.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { allSessions, findWebviews, jsLiteral, workbench, type Webview } from "./cdp";
import { env, profile } from "./env";
import {
    codeLensTitles,
    errorNotifications,
    pickFromCommand,
    waitFor,
    waitForWebview,
} from "./helpers";

// On the tables of test/fixtures/mssql: 3 orders above 10, of Bob (99.99) and Alice (42.50, 13.00).
const JOIN = `SELECT c.name, o.amount, o.status
FROM customers c JOIN orders o ON o.customer_id = c.id
WHERE o.amount > 10
ORDER BY o.amount DESC;`;

/** Labels of the actions of the active editor's title bar. */
function editorTitleActions(): Promise<string[]> {
    return (async () =>
        (await workbench()).evaluate<string[]>(`[...document.querySelectorAll(
            ".editor-group-container.active .editor-actions .action-item a.action-label")]
            .map((a) => a.getAttribute("aria-label") || a.title || "")`))();
}

/** Clicks the tab of the results pane whose name starts with `name`. */
async function selectResultsTab(webview: Webview, name: string): Promise<void> {
    const clicked = await webview.evaluate<boolean>(`(() => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.startsWith(${jsLiteral(name)}));
        tab?.click();
        return !!tab;
    })()`);
    assert.ok(clicked, `The results pane has no "${name}" tab`);
}

/** Name of the selected tab of the results pane. */
function selectedResultsTab(webview: Webview): Promise<string | null> {
    return webview.evaluate<string>(
        `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ""`,
    );
}

/** Operator names of the plan nodes drawn in the Query Plan tab. */
function planOperators(webview: Webview): Promise<string[] | null> {
    return webview.evaluate<string[]>(`[...document.querySelectorAll(
        "#executionPlanResultsTab .react-flow__node .execution-plan-flow-label")]
        .map((label) => label.innerText.split("\\n")[0].trim())`);
}

/** The lines under the operators drawn in the Query Plan tab: name, then counters of an actual plan. */
function planLabels(webview: Webview): Promise<string[] | null> {
    return webview.evaluate<string[]>(`[...document.querySelectorAll(
        "#executionPlanResultsTab .react-flow__node .execution-plan-flow-label")]
        .map((label) => label.innerText)`);
}

/** "Rows: 3 of 3 (100%)", the rows line upstream's page shows under the operators of an actual plan. */
const ROWS_LINE = /Rows: [\d.,]+[KMBT]? of [\d.,]+[KMBT]?( \([\d.,]+\s?%\))?/;

/** Waits for the rows and elapsed lines of an actual plan under its operators. */
async function waitForActualCounters(webview: Webview): Promise<void> {
    const labels = await waitFor(
        "the rows line of an actual plan under the operators",
        () => planLabels(webview),
        (l) => !!l && l.some((label) => ROWS_LINE.test(label)),
    );
    assert.ok(
        labels?.some((label) => /Elapsed: /.test(label)),
        `no elapsed line under the operators: ${JSON.stringify(labels)}`,
    );
    const header = await webview.evaluate<string>(
        `document.querySelector("#executionPlanResultsTab #queryCostContainer")?.innerText ?? ""`,
    );
    assert.match(header ?? "", /Elapsed: /, "no elapsed time in the header of the plan");
}

/** An estimated plan has no run-time counters under its operators. */
async function assertNoActualCounters(webview: Webview): Promise<void> {
    const labels = (await planLabels(webview)) ?? [];
    assert.ok(labels.length > 0, "no operator drawn");
    assert.ok(
        !labels.some((label) => ROWS_LINE.test(label) || /Elapsed: /.test(label)),
        JSON.stringify(labels),
    );
}

/**
 * Clicks the link of the first XML or JSON cell of the results grid (a plan document), from the
 * Results tab.
 */
async function clickDocumentCell(webview: Webview): Promise<void> {
    await selectResultsTab(webview, "Results");
    await waitFor("a document link in the results grid", () =>
        webview.evaluate<boolean>(`(() => {
            const link = document.querySelector('[data-fluent-result-grid="true"] .slick-cell a');
            if (!link) return false;
            for (const type of ["mousedown", "mouseup", "click"]) {
                link.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            }
            return true;
        })()`),
    );
}

/** Waits for the Query Plan tab to be the selected one. */
function waitForPlanTab(webview: Webview): Promise<unknown> {
    return waitFor(
        "the Query Plan tab to be selected",
        () => selectedResultsTab(webview),
        (tab) => !!tab && tab.startsWith("Query Plan"),
    );
}

/**
 * Selects the first operator whose text matches `pattern` with a click, opens the Properties
 * pane from the plan's toolbar and returns its text.
 */
async function operatorProperties(webview: Webview, pattern: string): Promise<string> {
    const clicked = await webview.evaluate<boolean>(`(() => {
        const node = [...document.querySelectorAll("#executionPlanResultsTab .react-flow__node")]
            .find((n) => new RegExp(${jsLiteral(pattern)}).test(n.innerText));
        if (!node) return false;
        const target = node.querySelector(".execution-plan-flow-icon-container") ?? node;
        for (const type of ["mousedown", "mouseup", "click"]) {
            target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return true;
    })()`);
    assert.ok(clicked, `no operator matches ${pattern}`);
    await waitFor("the Properties button of the plan", () =>
        webview.evaluate<boolean>(`(() => {
            if (document.querySelector("#propertiesPanelContainer")) return true;
            const button = document.querySelector('#executionPlanResultsTab button[aria-label="Properties"]');
            button?.click();
            return !!button;
        })()`),
    );
    return (await waitFor(
        "the properties pane",
        () =>
            webview.evaluate<string>(
                `document.querySelector("#propertiesPanelContainer")?.innerText ?? ""`,
            ),
        // The header row of the grid, then the properties of the operator.
        (text) => !!text && /Value[\s\S]+\S/.test(text),
    )) as string;
}

/**
 * Operator names of the plan once it fits the pane: React Flow draws only the operators in view,
 * so the plan is zoomed to fit with its toolbar button first, as a user would.
 */
async function allPlanOperators(
    webview: Webview,
    what: string,
    accept: (operators: string[]) => boolean,
): Promise<string[]> {
    // The toolbar shows once the plan is drawn.
    await waitFor("the Zoom to Fit button of the plan", () =>
        webview.evaluate<boolean>(`(() => {
            const button = document.querySelector('#executionPlanResultsTab button[aria-label="Zoom to Fit"]');
            button?.click();
            return !!button;
        })()`),
    );
    return (await waitFor(
        what,
        () => planOperators(webview),
        (operators) => !!operators && accept(operators),
    )) as string[];
}

/** Saves what the window shows to the artifacts folder of the run. */
async function screenshot(name: string): Promise<void> {
    const { data } = await (
        await workbench()
    ).send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(env.artifactsDir, `${name}.png`), Buffer.from(data, "base64"));
}

describe("Execution plans on SQL Server", () => {
    let editor: vscode.TextEditor;

    before(async () => {
        const document = await vscode.workspace.openTextDocument({
            language: "sql",
            content: JOIN,
        });
        editor = await vscode.window.showTextDocument(document, { preview: false });
    });

    after(async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("yast.disableActualPlan");
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    });

    it("offers no plan button before the editor is connected", async () => {
        await waitFor("the Connect action", editorTitleActions, (labels) =>
            labels.some((l) => l.startsWith("Connect")),
        );
        const labels = await editorTitleActions();
        assert.ok(!labels.some((l) => /Estimated Plan|Actual Plan/.test(l)), labels.join(", "));
    });

    it("offers the estimated and actual plan once connected to SQL Server", async () => {
        await pickFromCommand("yast.connect", profile("mssql").profileName);
        await waitFor(
            "the CodeLenses of the connection",
            () => codeLensTitles(editor.document.uri),
            (titles) => titles.length === 3,
        );
        const labels = await waitFor(
            "the plan buttons in the editor title",
            editorTitleActions,
            (l) => l.includes("Estimated Plan") && l.includes("Enable Actual Plan"),
        );
        assert.ok(!labels.includes("Disable Actual Plan"), labels.join(", "));
    });

    it("shows the estimated plan of a join in the Query Plan tab", async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("yast.showEstimatedPlan");

        const webview = await waitForWebview(
            "queryResult",
            `document.querySelectorAll("#executionPlanResultsTab .react-flow__node").length > 0`,
        );
        assert.match((await selectedResultsTab(webview)) ?? "", /^Query Plan \(1\)/);
        // SELECT, the join, and a read of each table.
        const operators = await allPlanOperators(
            webview,
            "the join and a read of each table",
            (o) =>
                o.includes("SELECT") &&
                o.some((name) => /Nested Loops|Hash Match|Merge Join/.test(name)) &&
                o.filter((name) => /Scan|Seek/.test(name)).length >= 2,
        );
        // React Flow draws the operators in no particular order.
        assert.ok(operators.includes("SELECT"), operators.join(", "));
        const text = await webview.text();
        assert.match(text, /Query 1: +Query cost \(relative to the script\): +100\.00%/);
        assert.ok(text.includes("FROM customers c JOIN orders o"), text);
        await assertNoActualCounters(webview);
        await screenshot("execution-plan-estimated");

        // The showplan document is also in the grid: its link brings the plan back.
        await clickDocumentCell(webview);
        await waitForPlanTab(webview);
    });

    it("shows the properties of the selected operator", async () => {
        const webview = await waitForWebview(
            "queryResult",
            `document.querySelector(".react-flow__node")`,
        );
        const pane = await operatorProperties(webview, "Join|Nested Loops|Hash Match|Merge");
        assert.match(pane, /Physical Operation/);
        assert.match(pane ?? "", /Estimated Subtree Cost/);
        await screenshot("execution-plan-properties");
    });

    it("runs with the actual plan once enabled: rows and plan", async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("yast.enableActualPlan");
        await waitFor("the Disable Actual Plan button", editorTitleActions, (labels) =>
            labels.includes("Disable Actual Plan"),
        );

        await vscode.commands.executeCommand("yast.runQuery");
        // Like SSMS, the Results tab comes first; the plan is in its own tab.
        const webview = await waitForWebview(
            "queryResult",
            `document.body.innerText.includes("99.99") && [...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent.startsWith("Query Plan (1)"))`,
        );
        const text = await webview.text();
        for (const name of ["Alice", "Bob", "99.99", "42.50", "13.00"]) {
            assert.ok(text.includes(name), `"${name}" is not in the results:\n${text}`);
        }
        assert.match((await selectedResultsTab(webview)) ?? "", /^Results/);

        await selectResultsTab(webview, "Query Plan");
        const operators = await allPlanOperators(
            webview,
            "the operators of the plan",
            (o) => o.includes("SELECT") && o.some((name) => /Scan|Seek/.test(name)),
        );
        assert.ok(operators.includes("SELECT"), operators.join(", "));
        // An actual plan carries what really ran: the rows each operator returned.
        // An actual plan shows what really ran under its operators: "Rows: 3 of 3 (100%)", as
        // Microsoft's page does, and the elapsed time of the statement in its header.
        await waitForActualCounters(webview);
        const pane = await operatorProperties(webview, "Nested Loops|Hash Match|Merge Join");
        assert.match(pane, /Actual Number of Rows/);
        await screenshot("execution-plan-actual");
        assert.deepStrictEqual(await errorNotifications(), []);
    });

    it("runs normally again once the actual plan is disabled", async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("yast.disableActualPlan");
        await waitFor("the Enable Actual Plan button", editorTitleActions, (labels) =>
            labels.includes("Enable Actual Plan"),
        );
        await vscode.commands.executeCommand("yast.runQuery");
        await waitFor("a run without plan", async () => {
            for (const webview of await findWebviews("queryResult")) {
                const tabs = await webview.evaluate<string[]>(
                    `[...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent)`,
                );
                const text = await webview.text();
                if (
                    text.includes("99.99") &&
                    tabs &&
                    !tabs.some((t) => t.startsWith("Query Plan"))
                ) {
                    return true;
                }
            }
            return false;
        });
    });

    it("no plan webview reported a script error, a blocked resource or a failed load", () => {
        const webviews = allSessions().filter((session) =>
            session.target.url.startsWith("vscode-webview://"),
        );
        assert.ok(webviews.length >= 1, "no webview was observed");
        assert.deepStrictEqual(
            webviews.flatMap((session) => session.errors),
            [],
        );
    });
});

// PostgreSQL's plans come from EXPLAIN (FORMAT JSON): the same page, a JSON document.
describe("Execution plans on PostgreSQL", () => {
    let editor: vscode.TextEditor;

    before(async () => {
        const document = await vscode.workspace.openTextDocument({
            language: "sql",
            content: JOIN,
        });
        editor = await vscode.window.showTextDocument(document, { preview: false });
        await pickFromCommand("yast.connect", profile("pg").profileName);
        await waitFor(
            "the CodeLenses of the connection",
            () => codeLensTitles(editor.document.uri),
            (titles) => titles.length === 3,
        );
    });

    after(async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("yast.disableActualPlan");
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    });

    it("shows the estimated plan, whose document is JSON", async () => {
        await waitFor("the plan buttons in the editor title", editorTitleActions, (l) =>
            l.includes("Estimated Plan"),
        );
        await vscode.commands.executeCommand("yast.showEstimatedPlan");
        const webview = await waitForWebview(
            "queryResult",
            `[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some((t) => t.textContent.startsWith("Query Plan (1)")) && document.querySelector("#executionPlanResultsTab .react-flow__node")`,
        );
        const operators = await allPlanOperators(
            webview,
            "the join and a read of each table",
            (o) =>
                o.some((name) => /Join|Nested Loop/.test(name)) &&
                o.filter((name) => /Scan/.test(name)).length >= 2,
        );
        assert.ok(operators.length >= 3, operators.join(", "));
        await assertNoActualCounters(webview);
        // The plan document is JSON: its button says so.
        const labels = await webview.evaluate<string[]>(
            `[...document.querySelectorAll('#executionPlanResultsTab [role="toolbar"] button')].map((b) => b.getAttribute("aria-label"))`,
        );
        assert.ok(labels?.includes("Open JSON"), (labels ?? []).join(", "));
        assert.ok(!labels?.includes("Open XML"), (labels ?? []).join(", "));
        await screenshot("execution-plan-pg-estimated");

        // The grid's QUERY PLAN cell is EXPLAIN's output, not the reported document (which adds
        // the query text): its link still brings the plan back, not a separate viewer.
        await clickDocumentCell(webview);
        await waitForPlanTab(webview);
        assert.deepStrictEqual(await findWebviews("executionPlan"), []);
    });

    it("shows the actual plan once enabled", async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("yast.enableActualPlan");
        await waitFor("the Disable Actual Plan button", editorTitleActions, (labels) =>
            labels.includes("Disable Actual Plan"),
        );
        await vscode.commands.executeCommand("yast.runQuery");
        // Unlike the estimated plan before it, a run brings the Results tab (EXPLAIN's output) first.
        const webview = await waitForWebview(
            "queryResult",
            `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.startsWith("Results") && [...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent.startsWith("Query Plan (1)"))`,
        );
        await selectResultsTab(webview, "Query Plan");
        await allPlanOperators(webview, "the operators of the actual plan", (o) =>
            o.some((name) => /Scan/.test(name)),
        );
        // What really ran: EXPLAIN ANALYZE's counters, under the operators and in the properties.
        await waitForActualCounters(webview);
        const pane = await operatorProperties(webview, "Scan");
        assert.match(pane, /Actual Rows/);
        await screenshot("execution-plan-pg-actual");
        assert.deepStrictEqual(await errorNotifications(), []);
    });

    it("opens the plan of an EXPLAIN run as a query in the execution plan viewer", async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("yast.disableActualPlan");
        const whole = new vscode.Range(0, 0, editor.document.lineCount, 0);
        assert.ok(
            await editor.edit((edit) =>
                edit.replace(whole, "EXPLAIN (FORMAT JSON) SELECT * FROM customers;"),
            ),
        );
        await vscode.commands.executeCommand("yast.runQuery");
        const results = await waitForWebview(
            "queryResult",
            `![...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent.startsWith("Query Plan")) && document.body.innerText.includes("QUERY PLAN")`,
        );
        await clickDocumentCell(results);
        const viewer = await waitForWebview(
            "executionPlan",
            `document.querySelector(".react-flow__node .execution-plan-flow-label")`,
        );
        assert.match((await viewer.text()) ?? "", /Seq Scan/);
        await screenshot("execution-plan-pg-viewer");
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    });

    it("no plan webview reported a script error, a blocked resource or a failed load", () => {
        assert.deepStrictEqual(
            allSessions()
                .filter((session) => session.target.url.startsWith("vscode-webview://"))
                .flatMap((session) => session.errors),
            [],
        );
    });
});
