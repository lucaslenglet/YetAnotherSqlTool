import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { QueryManager } from "../../src/queries/queryManager";
import type { EditorConnections } from "../../src/queries/editorConnections";
import type { QueryResultWebviewController } from "../../src/queryResult/queryResultWebViewController";
import type { Batch, DriverConnection, DriverId } from "../../src/drivers/types";
import type { QueryResultWebviewState } from "../../src/sharedInterfaces/queryResult";
import { withCursor } from "../sql/statementCases";

/** A text document over `text`, enough for QueryManager. */
function document(text: string) {
    const lines = text.split("\n");
    const offset = (p: vscode.Position) =>
        p.line >= lines.length
            ? text.length
            : lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    return {
        uri: vscode.Uri.parse("untitled:Untitled-1"),
        languageId: "sql",
        lineCount: lines.length,
        getText: (range?: vscode.Range) =>
            range ? text.slice(offset(range.start), offset(range.end)) : text,
    };
}

/** An editor on a script marked with a "|" cursor, or with a selection between two "|". */
function editor(marked: string): vscode.TextEditor {
    const first = withCursor(marked);
    const second = first.script.includes("|") ? withCursor(first.script) : first;
    const at = (p: { line: number; column: number }) => new vscode.Position(p.line, p.column);
    const selection = new vscode.Selection(at(first.position), at(second.position));
    return {
        document: document(second.script),
        selection,
        selections: [selection],
    } as unknown as vscode.TextEditor;
}

interface Setup {
    manager: QueryManager;
    batches: Batch[];
    results: { isVisible: ReturnType<typeof vi.fn>; hasPanel: ReturnType<typeof vi.fn> };
    state: QueryResultWebviewState;
}

function setup(provider: DriverId, connected = true): Setup {
    const batches: Batch[] = [];
    const connection = {
        execute: vi.fn(async (batch: Batch) => {
            batches.push(batch);
        }),
    } as unknown as DriverConnection;
    const connections = {
        isConnected: () => connected,
        get: () => ({ profile: { provider }, connection }),
        setRunning: () => undefined,
        refreshDatabase: async () => undefined,
    } as unknown as EditorConnections;
    const state = {
        messages: [],
        resultSetSummaries: {},
        tabStates: {},
    } as unknown as QueryResultWebviewState;
    const results = {
        set queryManager(_: unknown) {},
        isVisible: vi.fn(() => false),
        hasPanel: vi.fn(() => false),
        revealPanel: vi.fn(),
        addQueryResultState: vi.fn(),
        getQueryResultState: () => state,
        hasQueryResultState: () => true,
        pushState: vi.fn(),
    };
    const manager = new QueryManager(
        connections,
        results as unknown as QueryResultWebviewController,
    );
    return { manager, batches, results, state };
}

const noConnect = async () => false;

describe("QueryManager.runCurrentStatement", () => {
    beforeEach(() => {
        vi.mocked(vscode.window.showInformationMessage).mockClear();
        vi.mocked(vscode.window.showErrorMessage).mockClear();
        vi.mocked(vscode.commands.executeCommand).mockClear();
    });

    it("runs only the PostgreSQL statement at the cursor, at its line in the editor", async () => {
        const { manager, batches, state } = setup("pg");
        await manager.runCurrentStatement(editor("SELECT 1;\n  SELECT |2;\nSELECT 3;"), noConnect);
        expect(batches.map((b) => b.text)).toEqual(["SELECT 2;"]);
        // "Started executing query at Line 2" links to the statement.
        expect(state.messages[0].link?.text).toBe("Line 2");
        expect(state.messages[0].selection).toEqual(
            expect.objectContaining({ startLine: 1, startColumn: 2 }),
        );
    });

    it("runs only the SQL Server statement at the cursor, without semicolons", async () => {
        const { manager, batches, state } = setup("mssql");
        await manager.runCurrentStatement(
            editor("SELECT 1\nGO\nSELECT 2\nUPDATE t\nSET |a = 1\nSELECT 3"),
            noConnect,
        );
        expect(batches.map((b) => b.text)).toEqual(["UPDATE t\nSET a = 1"]);
        expect(state.messages[0].link?.text).toBe("Line 4");
    });

    it("runs the selection when there is one, like Execute Query", async () => {
        const { manager, batches } = setup("pg");
        await manager.runCurrentStatement(editor("SELECT |1; SELECT 2|; SELECT 3;"), noConnect);
        expect(batches.map((b) => b.text)).toEqual(["1; SELECT 2"]);
    });

    it("runs an empty query when there is no statement at the cursor, like sqltoolsservice", async () => {
        const { manager, batches, state } = setup("pg");
        await manager.runCurrentStatement(editor("SELECT 1;\n|\nSELECT 2;"), noConnect);
        expect(batches).toEqual([]);
        expect(state.messages.map((m) => m.message)).toEqual([
            "Commands completed successfully.",
            expect.stringMatching(/^Total execution time/),
        ]);
    });

    it("says there is nothing to run in an empty editor or for a blank selection", async () => {
        const { manager, batches } = setup("pg");
        await manager.runCurrentStatement(editor("  \n|"), noConnect);
        await manager.runCurrentStatement(editor("SELECT 1;|   |"), noConnect);
        expect(batches).toEqual([]);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            "There is no query text to execute. Enter a query or select non-empty query text.",
        );
    });

    it("refuses multiple selections", async () => {
        const { manager, batches } = setup("pg");
        const e = editor("SELECT |1;");
        (e as { selections: unknown[] }).selections = [e.selection, e.selection];
        await manager.runCurrentStatement(e, noConnect);
        expect(batches).toEqual([]);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledOnce();
    });

    it("asks for a connection first, and stops when none is chosen", async () => {
        const { manager, batches } = setup("pg", false);
        const connect = vi.fn(async () => false);
        await manager.runCurrentStatement(editor("SELECT |1;"), connect);
        expect(connect).toHaveBeenCalledOnce();
        expect(batches).toEqual([]);
    });
});

describe("QueryManager.toggleQueryResult", () => {
    beforeEach(() => vi.mocked(vscode.commands.executeCommand).mockClear());

    it("closes the panel when the results view is visible", () => {
        const { manager, results } = setup("pg");
        results.isVisible.mockReturnValue(true);
        manager.toggleQueryResult("untitled:Untitled-1");
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.closePanel");
    });

    it("reveals the results view, keeping the focus, when it is hidden", () => {
        const { manager, results } = setup("pg");
        results.isVisible.mockReturnValue(false);
        manager.toggleQueryResult("untitled:Untitled-1");
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith("yastQueryResult.focus", {
            preserveFocus: true,
        });
    });
});
