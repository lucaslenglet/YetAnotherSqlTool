// The screenshots of README.md, taken inside the window started by scripts/screenshots.mjs
// (npm run screenshots). The extension is driven as a user would drive it, with the helpers of
// test/vscode, and the window is captured through the DevTools protocol.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { closeAllSessions, workbench, type Webview } from "../vscode/cdp";
import { env, profile } from "../vscode/env";
import {
    codeLensTitles,
    errorNotifications,
    objectExplorerRows,
    pickFromCommand,
    sleep,
    statusBarTexts,
    waitFor,
    waitForWebview,
} from "../vscode/helpers";

/** Size of every screenshot, in CSS pixels; the PNG has twice as many pixels in each direction. */
const WIDTH = 1280;
const HEIGHT = 860;
const SCALE = 2;

const outputDir = process.env.YAST_SCREENSHOTS_DIR as string;
const salesMssql = () => profile("mssql").profileName;
const salesPg = () => profile("pg").profileName;

async function shot(name: string): Promise<void> {
    const window = await workbench();
    await vscode.commands.executeCommand("notifications.clearAll");
    // Nothing under the pointer: no tooltip, no hover highlight.
    await window.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: WIDTH - 2, y: 2 });
    await sleep(800);
    assert.deepStrictEqual(
        await errorNotifications(),
        [],
        `an error notification is on screen for ${name}`,
    );
    const { data } = await window.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
    });
    fs.writeFileSync(path.join(outputDir, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`captured ${name}.png`);
}

async function openSql(name: string): Promise<vscode.TextEditor> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the window has no workspace folder");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, name));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    return editor;
}

async function connectEditor(editor: vscode.TextEditor, profileName: string): Promise<void> {
    await pickFromCommand("yast.connect", profileName);
    await waitFor(
        "the CodeLenses of the connection",
        () => codeLensTitles(editor.document.uri),
        (titles) => titles.length === 3,
    );
    await waitFor("the server in the status bar", statusBarTexts, (texts) => texts.length > 0);
}

/** Runs the query of the active editor and waits for the results webview to show `marker`. */
async function runQuery(marker: string): Promise<Webview> {
    await vscode.commands.executeCommand("yast.runQuery");
    return waitForWebview(
        "queryResult",
        `document.body.innerText.includes(${JSON.stringify(marker)})`,
    );
}

// -- Object Explorer --------------------------------------------------------------------------

type Row = Awaited<ReturnType<typeof objectExplorerRows>>[number];

/** The row for `label` among the descendants of the rows [parentIndex, ...) one level below. */
function findChild(rows: Row[], parentIndex: number, label: string): number {
    const parentLevel = parentIndex < 0 ? 0 : rows[parentIndex].level;
    for (let i = parentIndex + 1; i < rows.length; i++) {
        if (rows[i].level <= parentLevel) break;
        // Table labels may carry their schema: "dbo.customers".
        if (
            rows[i].level === parentLevel + 1 &&
            (rows[i].label === label || rows[i].label.replace(/^\w+\./, "") === label)
        ) {
            return i;
        }
    }
    return -1;
}

/** Expands the nodes of a path from a connection down, clicking only those that are collapsed. */
async function expandPath(...labels: string[]): Promise<void> {
    const treeWindow = await workbench();
    let parentLabels: string[] = [];
    for (const label of labels) {
        parentLabels = [...parentLabels, label];
        const locate = async () => {
            const rows = await objectExplorerRows();
            let index = -1;
            for (const part of parentLabels) {
                index = findChild(rows, index, part);
                if (index < 0) return undefined;
            }
            return rows[index];
        };
        const row = await waitFor(
            `the Object Explorer node ${parentLabels.join(" > ")}`,
            locate,
            Boolean,
            60000,
        );
        if (row!.expanded !== "true") {
            await treeWindow.clickAt(row!.x, row!.y);
        }
        await waitFor(
            `${parentLabels.join(" > ")} to be expanded`,
            async () => (await locate())?.expanded,
            (e) => e === "true" || e === null,
            60000,
        );
        // Children come from the server: let them be drawn before looking for the next node.
        await sleep(400);
    }
}

// -- the grid ---------------------------------------------------------------------------------

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Where a cell of the results grid is in the window of VS Code (CSS pixels). */
async function cellBox(webview: Webview, row: number, column: string): Promise<Box> {
    const inFrame = await webview.evaluate<Box | null>(`(() => {
        const headers = [...document.querySelectorAll(".slick-header-column")];
        // The first header is the one of the row numbers, which has no cell here.
        const index = headers.findIndex((h) => h.textContent.trim() === ${JSON.stringify(column)});
        const rows = [...document.querySelectorAll(".grid-canvas-right .slick-row")]
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const cell = rows[${row}]?.querySelectorAll(".slick-cell")[index - 1];
        if (!cell) return null;
        const box = cell.getBoundingClientRect();
        return { x: box.left, y: box.top, width: box.width, height: box.height };
    })()`);
    assert.ok(inFrame, `no cell for ${column} on row ${row}`);

    // Position of the webview's frame in the window: the iframe that hosts it, by its id.
    const id = new URL(webview.session.target.url).searchParams.get("id");
    const host = await (
        await workbench()
    ).evaluate<Box | null>(`(() => {
        const frame = [...document.querySelectorAll("iframe")].find((f) => f.src.includes(${JSON.stringify(`id=${id}`)}));
        if (!frame) return null;
        const box = frame.getBoundingClientRect();
        return { x: box.left, y: box.top, width: box.width, height: box.height };
    })()`);
    assert.ok(host, "the results webview is not in the window");
    // The page of the extension sits in an <iframe id="active-frame"> filling the webview.
    const nested = await webview.session.evaluate<Box>(`(() => {
        const box = document.querySelector("iframe#active-frame").getBoundingClientRect();
        return { x: box.left, y: box.top, width: box.width, height: box.height };
    })()`);
    return {
        x: host.x + nested.x + inFrame.x,
        y: host.y + nested.y + inFrame.y,
        width: inFrame.width,
        height: inFrame.height,
    };
}

/** Selects the cells from one to the other with the mouse, like a drag. */
async function dragSelect(from: Box, to: Box): Promise<void> {
    const window = await workbench();
    const start = {
        x: Math.round(from.x + from.width / 2),
        y: Math.round(from.y + from.height / 2),
    };
    const end = { x: Math.round(to.x + to.width / 2), y: Math.round(to.y + to.height / 2) };
    await window.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
    await window.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...start,
        button: "left",
        buttons: 1,
        clickCount: 1,
    });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
        const x = Math.round(start.x + ((end.x - start.x) * i) / steps);
        const y = Math.round(start.y + ((end.y - start.y) * i) / steps);
        await window.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x,
            y,
            button: "left",
            buttons: 1,
        });
        await sleep(30);
    }
    await window.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...end,
        button: "left",
        buttons: 0,
        clickCount: 1,
    });
}

async function selectResultsTab(webview: Webview, name: string): Promise<void> {
    const clicked = await webview.evaluate<boolean>(`(() => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes(${JSON.stringify(name)}));
        tab?.click();
        return !!tab;
    })()`);
    assert.ok(clicked, `The results pane has no "${name}" tab`);
}

/** Drags the border between the editor and the bottom panel so that the panel starts at `top`. */
async function setPanelTop(top: number): Promise<void> {
    const window = await workbench();
    const current = await window.evaluate<number>(
        `document.querySelector(".part.panel").getBoundingClientRect().top`,
    );
    const x = 700;
    const from = Math.round(current - 3);
    await window.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: from });
    await window.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y: from,
        button: "left",
        buttons: 1,
        clickCount: 1,
    });
    for (let i = 1; i <= 10; i++) {
        await window.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x,
            y: Math.round(from + ((top - from) * i) / 10),
            button: "left",
            buttons: 1,
        });
        await sleep(20);
    }
    await window.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y: top,
        button: "left",
        buttons: 0,
        clickCount: 1,
    });
    await sleep(500);
}

// -- the scenario -----------------------------------------------------------------------------

export async function run(): Promise<void> {
    fs.mkdirSync(outputDir, { recursive: true });
    const window = await workbench();
    // A fixed viewport, whatever the size of the real window; twice the pixels for sharp text.
    await window.send("Emulation.setDeviceMetricsOverride", {
        width: WIDTH,
        height: HEIGHT,
        deviceScaleFactor: SCALE,
        mobile: false,
    });
    try {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await vscode.commands.executeCommand("workbench.action.closePanel");
        await vscode.commands.executeCommand("yastObjectExplorer.focus");

        // 1. The connection dialog, before anything else is on screen.
        await vscode.commands.executeCommand("yast.addObjectExplorer");
        const dialog = await waitForWebview(
            "connectionDialog",
            `document.querySelector("#connectButton")`,
        );
        fs.writeFileSync(path.join(env.artifactsDir, "connection-dialog.txt"), await dialog.text());
        await sleep(1000);
        // Open the "Database type" list so that both engines show.
        await dialog.evaluate(`(() => {
            const box = [...document.querySelectorAll('[role="combobox"]')].find((c) => c.textContent.includes("Microsoft SQL Server"));
            box?.click();
        })()`);
        await sleep(800);
        fs.writeFileSync(
            path.join(env.artifactsDir, "connection-dialog-open.txt"),
            await dialog.text(),
        );
        await shot("connection-dialog");
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");

        // 2. The Object Explorer of both engines, a query and its results.
        await expandPath(salesMssql(), "Databases", "yast", "Tables");
        await expandPath(salesPg(), "Databases", "yast", "Schemas", "public", "Tables");
        const editor = await openSql("top_customers.sql");
        await connectEditor(editor, salesMssql());
        await runQuery("total_spent");
        await waitForWebview("queryResult", `document.body.innerText.includes("@example.com")`);
        await setPanelTop(300);
        await shot("overview");

        // 3. The results grid, with cells selected and their summary in the status bar.
        const orders = await openSql("recent_orders.sql");
        await connectEditor(orders, salesPg());
        const grid = await runQuery("is_large");
        await waitFor(
            "the rows",
            () => grid.text(),
            (text) => /Rows\s+20/.test(text),
        );
        await setPanelTop(330);
        const from = await cellBox(grid, 1, "amount");
        const to = await cellBox(grid, 6, "amount");
        await dragSelect(from, to);
        await waitFor(
            "the selection summary",
            () => grid.text(),
            (text) => !text.includes("No selection"),
        );
        await shot("results-grid");

        // 4. The Messages tab after an error.
        const failing = await openSql("order_items.sql");
        await connectEditor(failing, salesMssql());
        const messages = await runQuery("order_items");
        await selectResultsTab(messages, "Messages");
        await waitFor(
            "the error message",
            () => messages.text(),
            (text) => /Invalid object name/.test(text),
        );
        await shot("messages");
    } finally {
        closeAllSessions();
    }
}
