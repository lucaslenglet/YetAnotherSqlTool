// A SQL editor, used as a user does: connect it through the connection quick pick, run its query
// with the real command, read the rows in the results webview, copy them.

import * as assert from "node:assert";
import * as vscode from "vscode";
import { workbench, type Webview } from "./cdp";
import { profile, type TestProfile } from "./env";
import {
    codeLensTitles,
    errorNotifications,
    extension,
    pickFromCommand,
    statusBarTexts,
    waitFor,
    waitForWebview,
} from "./helpers";

// Rows of the customers table of test/fixtures.
const customers = [
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
    ["Chloé", "chloe@example.com"],
];

/** Clicks the tab of the results pane with this name ("Results", "Messages"). */
async function selectResultsTab(webview: Webview, name: string): Promise<void> {
    const clicked = await webview.evaluate<boolean>(`(() => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes(${JSON.stringify(name)}));
        tab?.click();
        return !!tab;
    })()`);
    assert.ok(clicked, `The results pane has no "${name}" tab`);
}

/** Presses Ctrl+<key> on a cell of the results grid. */
async function pressCtrl(webview: Webview, key: string): Promise<void> {
    const pressed = await webview.evaluate<boolean>(`(() => {
        const cell = document.querySelector('[data-fluent-result-grid="true"] .grid-canvas-right .slick-cell');
        cell?.dispatchEvent(new window.KeyboardEvent("keydown", {
            key: ${JSON.stringify(key)}, code: "Key${key.toUpperCase()}", ctrlKey: true, bubbles: true, cancelable: true,
        }));
        return !!cell;
    })()`);
    assert.ok(pressed, "The results grid has no cell");
}

function queriesOf(provider: TestProfile["provider"]): void {
    describe(`SQL editor on ${provider}`, () => {
        let editor: vscode.TextEditor;
        let connected = false;
        const uri = () => editor.document.uri;

        /** The tests that need the connection are skipped when it failed: they would only time out. */
        function needsConnection(context: Mocha.Context): void {
            if (!connected) {
                context.skip();
            }
        }

        before(async () => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            assert.ok(folder, "the test window has no workspace folder");
            const document = await vscode.workspace.openTextDocument(
                vscode.Uri.joinPath(folder.uri, `${provider}.sql`),
            );
            assert.strictEqual(document.languageId, "sql");
            editor = await vscode.window.showTextDocument(document, { preview: false });
        });

        after(async () => {
            await vscode.window.showTextDocument(editor.document);
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
        });

        it("offers to connect", async () => {
            const titles = await waitFor(
                "the Connect CodeLens",
                () => codeLensTitles(uri()),
                (t) => t.length > 0,
            );
            assert.strictEqual(titles.length, 1);
            assert.match(titles[0], /Connect$/);
            await waitFor("the Connect status bar item", statusBarTexts, (texts) =>
                texts.some((t) => t.includes("Connect")),
            );
        });

        it("connects with the profile picked in the quick pick", async () => {
            const { profileName, server, database } = profile(provider);
            await pickFromCommand("yast.connect", profileName);

            const titles = await waitFor(
                "the CodeLenses of the connection",
                () => codeLensTitles(uri()),
                (t) => t.length === 3,
            );
            assert.ok(titles[0].includes(profileName), JSON.stringify(titles));
            assert.strictEqual(titles[1], server);
            assert.ok(titles[2].includes(database), JSON.stringify(titles));
            await waitFor("the server in the status bar", statusBarTexts, (texts) =>
                texts.some((t) => t.includes(server)),
            );
            assert.deepStrictEqual(await errorNotifications(), []);
            connected = true;
        });

        it("runs the query and shows its rows in the results webview", async function () {
            needsConnection(this);
            await vscode.window.showTextDocument(editor.document);
            await vscode.commands.executeCommand("yast.runQuery");

            const webview = await waitForWebview(
                "queryResult",
                `document.body.innerText.includes("${customers[2][1]}")`,
            );
            const text = await webview.text();
            for (const cell of customers.flat()) {
                assert.ok(text.includes(cell), `"${cell}" is not in the results grid:\n${text}`);
            }
            assert.deepStrictEqual(await errorNotifications(), []);
        });

        it("copies the rows selected in the grid to the clipboard", async function () {
            needsConnection(this);
            const webview = await waitForWebview(
                "queryResult",
                `document.querySelector('[data-fluent-result-grid="true"]')`,
            );
            const previous = await vscode.env.clipboard.readText();
            try {
                await vscode.env.clipboard.writeText("");
                await pressCtrl(webview, "a");
                await waitFor(
                    "every cell to be selected",
                    () =>
                        webview.evaluate<number>(
                            `document.querySelectorAll(".slick-cell.selected").length`,
                        ),
                    (selected) => selected === customers.flat().length,
                );
                await pressCtrl(webview, "c");
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
                    customers,
                );
            } finally {
                await vscode.env.clipboard.writeText(previous);
            }
        });

        it("shows the messages of the query", async function () {
            needsConnection(this);
            const webview = await waitForWebview("queryResult");
            await selectResultsTab(webview, "Messages");
            const expected = [
                /Started executing query at\s+Line 1/,
                // Each engine words it its own way.
                provider === "mssql" ? /\(3 rows affected\)/ : /SELECT 3/,
                ...(provider === "mssql" ? [/printed by the smoke test/] : []),
                /Total execution time: \d\d:\d\d:\d\d/,
            ];
            await waitFor(
                "the messages",
                () => webview.text(),
                (text) => expected.every((message) => message.test(text)),
            );
            await selectResultsTab(webview, "Results");
        });

        it("reports the error of a failing query in the messages", async function () {
            needsConnection(this);
            await vscode.window.showTextDocument(editor.document);
            const whole = new vscode.Range(0, 0, editor.document.lineCount, 0);
            assert.ok(
                await editor.edit((edit) =>
                    edit.replace(whole, "SELECT * FROM no_such_table_for_smoke_test;"),
                ),
            );
            await vscode.commands.executeCommand("yast.runQuery");

            // The Messages tab comes to the front by itself after an error.
            const webview = await waitForWebview(
                "queryResult",
                `document.body.innerText.includes("no_such_table_for_smoke_test")`,
            );
            const text = await webview.text();
            assert.match(text, provider === "mssql" ? /Msg 208, Level 16/ : /does not exist/);
            assert.ok(
                !text.includes(customers[0][1]),
                "the rows of the previous query are still shown",
            );
        });

        /** Replaces the editor's text and selects the first `selected` characters (none: just a cursor). */
        async function setEditorText(text: string, selected: number): Promise<void> {
            await vscode.window.showTextDocument(editor.document);
            const whole = new vscode.Range(0, 0, editor.document.lineCount, 0);
            assert.ok(await editor.edit((edit) => edit.replace(whole, text)));
            editor.selection = new vscode.Selection(0, 0, 0, selected);
        }

        /** Presses Alt+F1 in the focused editor, with a real key event of the window. */
        async function pressAltF1(): Promise<void> {
            await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
            const key = { key: "F1", code: "F1", windowsVirtualKeyCode: 112, modifiers: 1 };
            const session = await workbench();
            await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
            await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
        }

        it("contributes Alt+F1 for SQL editors", async function () {
            const { keybindings } = extension().packageJSON.contributes as {
                keybindings: { command: string; key: string; when: string }[];
            };
            const keybinding = keybindings.find((k) => k.command === "yast.showObjectInformation");
            assert.strictEqual(keybinding?.key, "alt+f1");
            assert.match(keybinding?.when ?? "", /editorLangId == 'sql'/);
            assert.ok(
                (await vscode.commands.getCommands(true)).includes("yast.showObjectInformation"),
            );
        });

        it("shows the information about the selected object with Alt+F1", async function () {
            needsConnection(this);
            await setEditorText("customers", "customers".length);
            await pressAltF1();

            const webview = await waitForWebview(
                "queryResult",
                `document.body.innerText.includes("Column_name") && document.body.innerText.includes("created_at")`,
            );
            const text = await webview.text();
            for (const column of ["id", "name", "email", "created_at"]) {
                assert.ok(text.includes(column), `"${column}" is not in the results:\n${text}`);
            }
            // The tab counts the result sets (the lower grids are not rendered until scrolled to).
            const [, count] = /Results Preview \((\d+)\)/.exec(text) ?? [];
            assert.ok(Number(count) >= 4, `the results pane says "${count}" result sets:\n${text}`);

            await selectResultsTab(webview, "Messages");
            const messages = await waitFor(
                "the messages",
                () => webview.text(),
                (t) => /Started executing object information query/.test(t),
            );
            assert.match(messages, /Total execution time: \d\d:\d\d:\d\d/);
            assert.ok(!/Started executing query at/.test(messages), messages);
            await selectResultsTab(webview, "Results");
            assert.deepStrictEqual(await errorNotifications(), []);
        });

        it("lists the objects of the database when nothing is selected", async function () {
            needsConnection(this);
            await setEditorText("customers", 0);
            await vscode.commands.executeCommand("yast.showObjectInformation");

            const webview = await waitForWebview(
                "queryResult",
                `document.body.innerText.includes("Object_type") && document.body.innerText.includes("orders")`,
            );
            const text = await webview.text();
            assert.ok(text.includes("customers"), text);
            assert.ok(text.includes("orders"), text);
            assert.ok(!text.includes("Column_name"), "the columns of one object are shown");
            assert.deepStrictEqual(await errorNotifications(), []);
        });

        it("disconnects", async function () {
            needsConnection(this);
            await vscode.window.showTextDocument(editor.document);
            await vscode.commands.executeCommand("yast.disconnect");
            const titles = await waitFor(
                "the Connect CodeLens",
                () => codeLensTitles(uri()),
                (t) => t.length === 1,
            );
            assert.match(titles[0], /Connect$/);
        });
    });
}

queriesOf("mssql");
queriesOf("pg");
