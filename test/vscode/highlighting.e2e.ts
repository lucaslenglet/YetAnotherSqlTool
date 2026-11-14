// Syntax highlighting that follows the editor's connection: the same script, read from the
// rendered editor (the computed color of each token's span), unconnected, then connected to
// PostgreSQL, then to SQL Server, then disconnected again. Colors are compared with each other,
// not with fixed values, so that the test does not depend on the color theme.

import * as assert from "node:assert";
import * as vscode from "vscode";
import { profile } from "./env";
import { inWorkbench, pickFromCommand, waitFor } from "./helpers";

const script = [
    `SELECT TOP 10 email, "Users".id::int FROM t WHERE email ILIKE 'x%' -- note`,
    "GO",
    "DO $$ BEGIN PERFORM 1; END $$;",
    "SELECT [name] FROM s RETURNING id",
].join("\n");

/** Where to read a color: the line containing `line`, at the first `text` after it (+ `skip`). */
interface Landmark {
    line: string;
    text: string;
    skip?: number;
}

const landmarks = {
    select: { line: "SELECT TOP", text: "SELECT" },
    top: { line: "SELECT TOP", text: "TOP" },
    email: { line: "SELECT TOP", text: "email" },
    quoted: { line: "SELECT TOP", text: '"Users"' },
    int: { line: "SELECT TOP", text: "::int", skip: 2 },
    ilike: { line: "SELECT TOP", text: "ILIKE" },
    string: { line: "SELECT TOP", text: "'x%'" },
    comment: { line: "SELECT TOP", text: "-- note" },
    go: { line: "GO", text: "GO" },
    dollar: { line: "DO $$", text: "$$" },
    begin: { line: "DO $$", text: "BEGIN" },
    bracketed: { line: "SELECT [name]", text: "name" },
    returning: { line: "SELECT [name]", text: "RETURNING" },
} satisfies Record<string, Landmark>;

type Colors = Record<keyof typeof landmarks, string | null>;

/** The computed color of the character of each landmark, in the editor on screen. */
function colors(): Promise<Colors> {
    return inWorkbench(`(() => {
        const landmarks = ${JSON.stringify(landmarks)};
        const lines = [...document.querySelectorAll(".monaco-editor .view-lines .view-line")];
        const textOf = (element) => element.textContent.replace(/\\u00a0/g, " ");
        const result = {};
        for (const [name, { line, text, skip }] of Object.entries(landmarks)) {
            const element = lines.find((l) =>
                line === "GO" ? textOf(l).trim() === "GO" : textOf(l).includes(line));
            result[name] = null;
            if (!element) continue;
            const content = textOf(element);
            const offset = content.indexOf(text, content.indexOf(line)) + (skip ?? 0);
            let position = 0;
            for (const span of element.firstElementChild?.children ?? []) {
                const length = span.textContent.length;
                if (offset < position + length) {
                    result[name] = getComputedStyle(span).color;
                    break;
                }
                position += length;
            }
        }
        return result;
    })()`);
}

/** Waits for the colors to satisfy `accept` (semantic tokens arrive after the text is drawn). */
function waitForColors(what: string, accept: (c: Colors) => boolean): Promise<Colors> {
    return waitFor(what, colors, (c) => Object.values(c).every((v) => v !== null) && accept(c));
}

describe("Syntax highlighting per engine", () => {
    let editor: vscode.TextEditor;
    let unconnected: Colors;

    before(async () => {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        const document = await vscode.workspace.openTextDocument({
            language: "sql",
            content: script,
        });
        editor = await vscode.window.showTextDocument(document, { preview: false });
    });

    after(async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    });

    it("keeps VS Code's T-SQL coloring in an editor without a connection", async () => {
        // The T-SQL grammar: TOP and GO are keywords, ILIKE is a plain word, "Users" a string.
        // TextMate colors the lines one after the other: wait for all of them.
        unconnected = await waitForColors(
            "the T-SQL grammar's colors",
            (c) =>
                c.top === c.select &&
                c.top !== c.email &&
                c.go === c.select &&
                c.ilike === c.email &&
                c.quoted === c.string,
        );
    });

    it("colors PostgreSQL in an editor connected to PostgreSQL", async () => {
        await pickFromCommand("yast.connect", profile("pg").profileName);
        const c = await waitForColors("PostgreSQL colors", (c) => c.ilike === c.select);
        assert.strictEqual(c.returning, c.select, "RETURNING is a keyword");
        assert.strictEqual(c.top, c.email, "TOP is a plain name");
        assert.strictEqual(c.go, c.email, "GO is a plain name");
        assert.strictEqual(c.quoted, c.email, '"Users" is a name, not a string');
        assert.notStrictEqual(c.int, c.email, "::int is a type");
        assert.strictEqual(c.begin, c.select, "the DO body is SQL");
        assert.strictEqual(c.dollar, c.string, "$$ looks like a string quote");
        assert.strictEqual(c.string, unconnected.string);
        assert.strictEqual(c.comment, unconnected.comment);
    });

    it("colors T-SQL in the same editor connected to SQL Server", async () => {
        await pickFromCommand("yast.connect", profile("mssql").profileName);
        const c = await waitForColors(
            "SQL Server colors",
            (c) => c.top === c.select && c.ilike !== c.select,
        );
        assert.strictEqual(c.go, c.select, "GO alone on its line is a keyword");
        assert.strictEqual(c.ilike, c.email, "ILIKE is a plain name");
        assert.strictEqual(c.returning, c.email, "RETURNING is a plain name");
        assert.strictEqual(c.bracketed, c.email, "[name] is a name");
        assert.strictEqual(c.quoted, c.email, '"Users" is a name, not a string');
        assert.strictEqual(c.string, unconnected.string);
        assert.strictEqual(c.comment, unconnected.comment);
    });

    it("goes back to VS Code's coloring when the editor disconnects", async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("yast.disconnect");
        await waitForColors("the colors of the unconnected editor", (c) =>
            Object.entries(unconnected).every(([name, color]) => c[name as keyof Colors] === color),
        );
    });
});
