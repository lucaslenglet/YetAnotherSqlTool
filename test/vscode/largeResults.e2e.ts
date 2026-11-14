// A query returning a few hundred thousand rows, used as a user does: the rows go to a file under
// the extension's storage, the grid jumps to the last row (Ctrl+End) and copies from there, and the
// file goes away with the editor.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Webview } from "./cdp";
import { env, profile, type TestProfile } from "./env";
import { codeLensTitles, pickFromCommand, waitFor, waitForWebview } from "./helpers";

const ROWS = 300_000;

const queries: Record<TestProfile["provider"], string> = {
    mssql: `SELECT n, CONCAT('row ', n) AS s FROM (
    SELECT TOP (${ROWS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
    FROM sys.all_columns a CROSS JOIN sys.all_columns b
) t ORDER BY n`,
    pg: `SELECT n, 'row ' || n AS s FROM generate_series(1, ${ROWS}) AS n`,
};

/**
 * Result files of the extension under test: <user data>/User/globalStorage/<extension>/results.
 * scripts/test-vscode.mjs puts the user data next to the artifacts folder.
 */
function resultFiles(): string[] {
    const globalStorage = path.join(
        path.dirname(env.artifactsDir),
        "user-data",
        "User",
        "globalStorage",
    );
    const extensionDir = fs
        .readdirSync(globalStorage)
        .find((name) => name.toLowerCase() === env.extensionId.toLowerCase());
    const results = extensionDir && path.join(globalStorage, extensionDir, "results");
    if (!results || !fs.existsSync(results)) return [];
    return fs
        .readdirSync(results, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
}

/** Dispatches a key press on the active cell of the results grid (or its first cell). */
async function pressKey(
    webview: Webview,
    key: string,
    code: string,
    modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {},
): Promise<void> {
    const pressed = await webview.evaluate<boolean>(`(() => {
        const grid = document.querySelector('[data-fluent-result-grid="true"]');
        const cell = grid?.querySelector('.slick-cell.active') ?? grid?.querySelector('.grid-canvas-right .slick-cell');
        cell?.dispatchEvent(new window.KeyboardEvent("keydown", {
            key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)},
            ctrlKey: ${!!modifiers.ctrlKey}, shiftKey: ${!!modifiers.shiftKey}, bubbles: true, cancelable: true,
        }));
        return !!cell;
    })()`);
    assert.ok(pressed, "The results grid has no cell");
}

/** Clicks the first data cell of the results grid, which makes it the active cell. */
async function clickFirstCell(webview: Webview): Promise<void> {
    const clicked = await webview.evaluate<boolean>(`(() => {
        const cell = document.querySelector('[data-fluent-result-grid="true"] .grid-canvas-right .slick-cell');
        if (!cell) return false;
        for (const type of ["mousedown", "mouseup", "click"]) {
            cell.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
        }
        return true;
    })()`);
    assert.ok(clicked, "The results grid has no cell");
}

function largeResultsOf(provider: TestProfile["provider"]): void {
    describe(`Large results on ${provider}`, () => {
        let editor: vscode.TextEditor;
        let webview: Webview;

        before(async () => {
            const document = await vscode.workspace.openTextDocument({
                language: "sql",
                content: queries[provider],
            });
            editor = await vscode.window.showTextDocument(document, { preview: false });
        });

        after(async () => {
            if (!editor.document.isClosed) {
                await vscode.window.showTextDocument(editor.document);
                await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            }
        });

        it(`runs a query of ${ROWS.toLocaleString("en-US")} rows into a result file`, async function () {
            this.timeout(120_000);
            await pickFromCommand("yast.connect", profile(provider).profileName);
            await waitFor(
                "the connection",
                () => codeLensTitles(editor.document.uri),
                (titles) => titles.length === 3,
            );
            await vscode.window.showTextDocument(editor.document);
            await vscode.commands.executeCommand("yast.runQuery");

            const count = ROWS.toLocaleString("en-US");
            webview = await waitForWebview(
                "queryResult",
                `document.body.innerText.includes("row 1") && document.body.innerText.includes(${JSON.stringify(count)})`,
                90_000,
            );
            assert.match(await webview.text(), /Results Preview \(1\)/);
            // Past the memory budget: the rows are in a file of this window's session.
            const files = resultFiles();
            assert.strictEqual(files.length, 1, JSON.stringify(files));
            assert.match(files[0], /^\d+\.rows$/);
        });

        it("jumps to the last row with Ctrl+End and copies the end of the result", async function () {
            await clickFirstCell(webview);
            await pressKey(webview, "End", "End", { ctrlKey: true });
            await waitFor(
                "the last row in the grid",
                () => webview.text(),
                (text) => text.includes(`row ${ROWS}`),
            );
            await pressKey(webview, "ArrowUp", "ArrowUp", { shiftKey: true });
            await pressKey(webview, "ArrowLeft", "ArrowLeft", { shiftKey: true });
            await waitFor(
                "two rows of two cells selected",
                () =>
                    webview.evaluate<number>(
                        `document.querySelectorAll(".slick-cell.selected").length`,
                    ),
                (selected) => selected === 4,
            );

            const previous = await vscode.env.clipboard.readText();
            try {
                await vscode.env.clipboard.writeText("");
                await pressKey(webview, "c", "KeyC", { ctrlKey: true });
                const copied = await waitFor(
                    "the rows in the clipboard",
                    () => vscode.env.clipboard.readText(),
                    (text) => text.includes("\t"),
                );
                assert.deepStrictEqual(
                    copied
                        .trim()
                        .split(/\r?\n/)
                        .map((line) => line.split("\t")),
                    [
                        [String(ROWS - 1), `row ${ROWS - 1}`],
                        [String(ROWS), `row ${ROWS}`],
                    ],
                );
            } finally {
                await vscode.env.clipboard.writeText(previous);
            }
        });

        it("deletes the result file when the editor is closed", async function () {
            await vscode.window.showTextDocument(editor.document);
            await vscode.commands.executeCommand("yast.disconnect");
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            await waitFor(
                "the result file to be deleted",
                resultFiles,
                (files) => files.length === 0,
            );
        });
    });
}

largeResultsOf("mssql");
largeResultsOf("pg");
