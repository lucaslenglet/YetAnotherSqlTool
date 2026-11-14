// Execute Current Statement, Cancel Query and Toggle Query Result Panel, through their commands
// and through real key presses sent to the workbench (DevTools protocol), as a user would.

import * as assert from "node:assert";
import * as vscode from "vscode";
import { workbench } from "./cdp";
import { profile, type TestProfile } from "./env";
import { inWorkbench, pickFromCommand, sleep, waitFor, waitForWebview } from "./helpers";

interface Key {
    key: string;
    code: string;
    keyCode: number;
    /** Alt = 1, Ctrl = 2, Meta = 4, Shift = 8. */
    modifiers: number;
}

const ctrlR: Key = { key: "r", code: "KeyR", keyCode: 82, modifiers: 2 };
const ctrlF5: Key = { key: "F5", code: "F5", keyCode: 116, modifiers: 2 };
const altPause: Key = { key: "Pause", code: "Pause", keyCode: 19, modifiers: 1 };

/** Presses a key in the window of VS Code: it reaches whatever has the focus, as a real one. */
async function press({ key, code, keyCode, modifiers }: Key): Promise<void> {
    const session = await workbench();
    // The test window may not be the focused window of the desktop: focus events must fire anyway.
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const common = {
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
    };
    await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

/** Whether the bottom panel, where the results view lives, is shown. */
function panelVisible(): Promise<boolean> {
    return inWorkbench(`(() => {
        const panel = document.querySelector(".part.panel");
        return !!panel && panel.offsetParent !== null && panel.getBoundingClientRect().height > 0;
    })()`);
}

const waitForPanel = (visible: boolean) =>
    waitFor(`the panel to be ${visible ? "shown" : "hidden"}`, panelVisible, (v) => v === visible);

/** Puts the cursor at the start of `text` in the editor, and the focus in the editor. */
async function placeCursor(editor: vscode.TextEditor, text: string): Promise<void> {
    const offset = editor.document.getText().indexOf(text);
    assert.ok(offset >= 0, `"${text}" is not in the editor`);
    const position = editor.document.positionAt(offset);
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    editor.selection = new vscode.Selection(position, position);
}

/** What the results view shows, once it shows `expected`. */
async function resultsText(expected: string): Promise<string> {
    const webview = await waitForWebview(
        "queryResult",
        `document.body.innerText.includes(${JSON.stringify(expected)})`,
    );
    return webview.text();
}

function shortcutsOf(provider: TestProfile["provider"]): void {
    describe(`Shortcuts on ${provider}`, () => {
        const marker = (n: number) => `${provider}_statement_${n}`;
        // SQL Server users write no semicolons (SSMS style); PostgreSQL needs them.
        const end = provider === "mssql" ? "" : ";";
        const script = [1, 2, 3].map((n) => `SELECT '${marker(n)}' AS m${end}`).join("\n");
        let editor: vscode.TextEditor;

        before(async () => {
            const document = await vscode.workspace.openTextDocument({
                language: "sql",
                content: script,
            });
            editor = await vscode.window.showTextDocument(document, { preview: false });
            await pickFromCommand("yast.connect", profile(provider).profileName);
        });

        after(async () => {
            await vscode.window.showTextDocument(editor.document);
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
        });

        it("runs only the statement at the cursor", async () => {
            await placeCursor(editor, marker(2));
            await vscode.commands.executeCommand("yast.runCurrentStatement");
            const text = await resultsText(marker(2));
            assert.ok(!text.includes(marker(1)), `statement 1 ran too:\n${text}`);
            assert.ok(!text.includes(marker(3)), `statement 3 ran too:\n${text}`);
        });

        it("runs the statement at the cursor with Ctrl+F5", async () => {
            await placeCursor(editor, marker(3));
            await press(ctrlF5);
            const text = await resultsText(marker(3));
            assert.ok(!text.includes(marker(2)), `the previous results are still shown:\n${text}`);
        });

        it("cancels a running query", async () => {
            const sleepQuery =
                provider === "mssql" ? "WAITFOR DELAY '00:00:30'" : "SELECT pg_sleep(30);";
            const whole = new vscode.Range(0, 0, editor.document.lineCount, 0);
            assert.ok(await editor.edit((edit) => edit.replace(whole, sleepQuery)));
            await vscode.window.showTextDocument(editor.document);
            const started = Date.now();
            const running = vscode.commands.executeCommand("yast.runQuery");
            await resultsText("Started executing query");
            await sleep(500);
            await vscode.commands.executeCommand("yast.cancelQuery");
            await running;
            assert.ok(Date.now() - started < 20000, "the query was not canceled");
            await resultsText("Query was canceled by user.");
        });

        it("toggles the results panel", async () => {
            await vscode.window.showTextDocument(editor.document);
            await waitForPanel(true);
            await vscode.commands.executeCommand("yast.toggleQueryResultPanel");
            await waitForPanel(false);
            await vscode.commands.executeCommand("yast.toggleQueryResultPanel");
            await waitForPanel(true);
        });

        if (provider !== "mssql") {
            return;
        }

        it("cancels a running query with Alt+Pause", async () => {
            const whole = new vscode.Range(0, 0, editor.document.lineCount, 0);
            assert.ok(await editor.edit((edit) => edit.replace(whole, "WAITFOR DELAY '00:00:30'")));
            await vscode.window.showTextDocument(editor.document);
            const started = Date.now();
            const running = vscode.commands.executeCommand("yast.runQuery");
            await resultsText("Started executing query");
            await sleep(500);
            await press(altPause);
            await running;
            assert.ok(Date.now() - started < 20000, "Alt+Pause did not cancel the query");
        });

        it("toggles the results panel with Ctrl+R in the SQL editor", async () => {
            await vscode.window.showTextDocument(editor.document);
            await waitForPanel(true);
            await press(ctrlR);
            await waitForPanel(false);
            await press(ctrlR);
            await waitForPanel(true);
        });

        it("hides the results panel with Ctrl+R in the results view", async () => {
            await vscode.commands.executeCommand("yastQueryResult.focus");
            // A webview has the focus when its <iframe> has it.
            await waitFor("the focus in the results view", () =>
                inWorkbench<boolean>(`document.activeElement?.tagName === "IFRAME"`),
            );
            await press(ctrlR);
            await waitForPanel(false);
            await vscode.window.showTextDocument(editor.document);
            await vscode.commands.executeCommand("yast.toggleQueryResultPanel");
            await waitForPanel(true);
        });

        it("leaves Ctrl+R to VS Code in other editors", async () => {
            const other = await vscode.workspace.openTextDocument({
                language: "plaintext",
                content: "not SQL",
            });
            await vscode.window.showTextDocument(other, { preview: false });
            try {
                await press(ctrlR);
                // VS Code's own Ctrl+R: the quick pick of recently opened folders and files.
                await waitFor("the Open Recent quick pick", async () => {
                    const visible = await inWorkbench<boolean>(`(() => {
                        const widget = document.querySelector(".quick-input-widget");
                        return !!widget && widget.style.display !== "none";
                    })()`);
                    return visible;
                });
                await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
                assert.strictEqual(await panelVisible(), true, "Ctrl+R hid the results panel");
            } finally {
                await vscode.window.showTextDocument(other);
                await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            }
        });
    });
}

shortcutsOf("mssql");
shortcutsOf("pg");
