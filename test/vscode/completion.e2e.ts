// Autocompletion in a SQL editor, for each engine: nothing from YAST while the editor is not
// connected; once connected, the fixture tables after FROM (read both from the completion provider
// API and from the suggest widget on screen), the inserted text when one is accepted, an alias's
// columns with their types, and a table created by running DDL in the editor without reconnecting.

import * as assert from "node:assert";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { profile, type TestProfile } from "./env";
import { inWorkbench, pickFromCommand, sleep, waitFor } from "./helpers";

type Label = string | vscode.CompletionItemLabel;
const labelOf = (label: Label) => (typeof label === "string" ? label : label.label);

/** What the completion providers (ours and the others) offer at a position. */
async function completions(
    editor: vscode.TextEditor,
    position: vscode.Position,
): Promise<vscode.CompletionItem[]> {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        editor.document.uri,
        position,
    );
    return list?.items ?? [];
}

/** Rows of the suggest widget on screen: each row's aria-label (label first), then its text. */
function suggestRows(): Promise<string[]> {
    return inWorkbench(`(() => {
        const widget = document.querySelector(".editor-widget.suggest-widget");
        if (!widget || !widget.classList.contains("visible")) return [];
        return [...widget.querySelectorAll(".monaco-list-row")].map(
            (row) => (row.getAttribute("aria-label") || "") + " " + row.textContent);
    })()`);
}

/** Replaces the editor's text and puts the cursor where "|" is. */
async function setText(editor: vscode.TextEditor, marked: string): Promise<vscode.Position> {
    const offset = marked.indexOf("|");
    const text = marked.slice(0, offset) + marked.slice(offset + 1);
    const document = editor.document;
    await editor.edit((edit) =>
        edit.replace(
            new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length),
            ),
            text,
        ),
    );
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    return position;
}

function completionOf(provider: TestProfile["provider"]): void {
    describe(`Autocompletion on ${provider}`, () => {
        let editor: vscode.TextEditor;
        const table = provider === "mssql" ? "dbo.customers" : "customers";
        const created = `yast_oe_e2e_${randomBytes(3).toString("hex")}`;

        before(async () => {
            await vscode.commands.executeCommand("workbench.action.closeAllEditors");
            const document = await vscode.workspace.openTextDocument({
                language: "sql",
                content: "",
            });
            editor = await vscode.window.showTextDocument(document, { preview: false });
        });

        after(async () => {
            await vscode.commands.executeCommand("hideSuggestWidget");
            await vscode.window.showTextDocument(editor.document);
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
        });

        it("offers nothing from YAST in an editor that is not connected", async () => {
            const position = await setText(editor, "SELECT * FROM |");
            // Give an activation or a stray load the time to show up.
            await sleep(500);
            // VS Code's own word suggestions (words of the open files, kind Text) remain.
            const ours = (await completions(editor, position)).filter(
                (i) => i.kind !== vscode.CompletionItemKind.Text,
            );
            assert.deepStrictEqual(
                ours.map((i) => labelOf(i.label)),
                [],
            );
        });

        it("offers the tables after FROM once connected, and inserts the one accepted", async () => {
            await pickFromCommand("yast.connect", profile(provider).profileName);
            const position = await setText(editor, "SELECT * FROM |");
            const items = await waitFor(
                "customers in the completions",
                () => completions(editor, position),
                (list) => list.some((i) => labelOf(i.label) === "customers"),
            );
            const customers = items.find((i) => labelOf(i.label) === "customers")!;
            assert.strictEqual(customers.kind, vscode.CompletionItemKind.File);
            assert.ok(items.some((i) => labelOf(i.label) === "orders"));

            // The same, as the user sees it: the suggest widget, then accepting its selection.
            await setText(editor, "SELECT * FROM cust|");
            await vscode.commands.executeCommand("editor.action.triggerSuggest");
            const rows = await waitFor("customers in the suggest widget", suggestRows, (r) =>
                r.some((row) => row.startsWith("customers")),
            );
            assert.ok(rows[0].startsWith("customers"), JSON.stringify(rows));
            await vscode.commands.executeCommand("acceptSelectedSuggestion");
            await waitFor(
                "the accepted table in the editor",
                () => editor.document.getText(),
                (t) => t === "SELECT * FROM customers",
            );
        });

        it("offers an alias's columns with their types", async () => {
            const position = await setText(editor, `SELECT c.| FROM ${table} c`);
            const items = await waitFor(
                "the columns of customers",
                () => completions(editor, position),
                (list) => list.some((i) => labelOf(i.label) === "email"),
            );
            const columns = items.filter((i) => i.kind === vscode.CompletionItemKind.Field);
            assert.deepStrictEqual(
                columns.map((i) => labelOf(i.label)),
                ["id", "name", "email", "created_at"],
            );
            const name = columns.find((i) => labelOf(i.label) === "name")!;
            const type = provider === "mssql" ? "nvarchar(100)" : "character varying(100)";
            assert.strictEqual((name.label as vscode.CompletionItemLabel).description, type);

            await vscode.commands.executeCommand("editor.action.triggerSuggest");
            const rows = await waitFor("the columns in the suggest widget", suggestRows, (r) =>
                r.some((row) => row.startsWith("name")),
            );
            assert.ok(
                rows.some((row) => row.startsWith("name") && row.includes(type)),
                JSON.stringify(rows),
            );
            await vscode.commands.executeCommand("hideSuggestWidget");
        });

        it("offers a table created by DDL run in the editor, without reconnecting", async () => {
            await setText(editor, `CREATE TABLE ${created} (a INT)|`);
            await vscode.commands.executeCommand("yast.runQuery");
            await vscode.window.showTextDocument(editor.document);
            const position = await setText(editor, "SELECT * FROM yast_oe_e2e|");
            await waitFor(
                `${created} in the completions`,
                () => completions(editor, position),
                (list) => list.some((i) => labelOf(i.label) === created),
            );
            await setText(editor, `DROP TABLE ${created}|`);
            await vscode.commands.executeCommand("yast.runQuery");
            await vscode.window.showTextDocument(editor.document);
            await setText(editor, "|");
            await vscode.commands.executeCommand("yast.disconnect");
        });
    });
}

completionOf("pg");
completionOf("mssql");
