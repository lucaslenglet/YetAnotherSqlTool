import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { EditorConnections } from "../../src/queries/editorConnections";
import type { QueryManager } from "../../src/queries/queryManager";
import { SqlCompletionProvider } from "../../src/languageFeatures/completion/completionProvider";
import { fakeConnection } from "./completionFakes";

/** A document with just what the provider uses; "|" marks the cursor. */
function document(marked: string, uri = "untitled:a") {
    const offset = marked.indexOf("|");
    const text = marked.slice(0, offset) + marked.slice(offset + 1);
    const lineStarts = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index! + 1)];
    const positionAt = (o: number) => {
        let line = 0;
        while (line + 1 < lineStarts.length && lineStarts[line + 1] <= o) line++;
        return new vscode.Position(line, o - lineStarts[line]);
    };
    return {
        doc: {
            uri: vscode.Uri.parse(uri),
            getText: () => text,
            offsetAt: (p: vscode.Position) => lineStarts[p.line] + p.character,
            positionAt,
        } as unknown as vscode.TextDocument,
        position: positionAt(offset),
    };
}

function setup() {
    const connection = fakeConnection();
    const editors = new Map<string, unknown>();
    const connectionChanged = new vscode.EventEmitter<string>();
    const ranText = new vscode.EventEmitter<{ uri: string; text: string }>();
    const connections = {
        get: (uri: string) => editors.get(uri),
        onDidChange: connectionChanged.event,
    } as unknown as EditorConnections;
    const queries = { onDidRunText: ranText.event } as unknown as QueryManager;
    const provider = new SqlCompletionProvider(connections, queries);
    const connect = (uri = "untitled:a") => {
        editors.set(uri, {
            profile: { provider: "mssql", server: "srv" },
            connection,
            database: "shop",
        });
        connectionChanged.fire(uri);
    };
    return { provider, connection, connect, ranText };
}

const token = { isCancellationRequested: false } as vscode.CancellationToken;
const invoke = { triggerKind: vscode.CompletionTriggerKind.Invoke } as vscode.CompletionContext;

describe("SqlCompletionProvider", () => {
    it("returns nothing for an editor that is not connected with YAST", async () => {
        const { provider } = setup();
        const { doc, position } = document("SELECT * FROM |");
        expect(await provider.provideCompletionItems(doc, position, token, invoke)).toBeUndefined();
    });

    it("converts suggestions to completion items", async () => {
        const { provider, connect, connection } = setup();
        connect();
        // Loading starts with the connection, before any request.
        expect(connection.calls.objects).toBe(1);
        const { doc, position } = document("SELECT * FROM dbo.customers c WHERE c.|");
        const list = (await provider.provideCompletionItems(doc, position, token, invoke))!;
        expect(list.isIncomplete).toBe(false);
        const id = list.items.find((i) => (i.label as { label: string }).label === "id")!;
        expect(id.kind).toBe(vscode.CompletionItemKind.Field);
        expect(id.label).toEqual({ label: "id", description: "int" });
        expect(id.insertText).toBe("id");
        expect(id.range).toEqual({
            inserting: new vscode.Range(new vscode.Position(0, 38), new vscode.Position(0, 38)),
            replacing: new vscode.Range(new vscode.Position(0, 38), new vscode.Position(0, 38)),
        });

        const tables = (await provider.provideCompletionItems(
            ...(Object.values(document("SELECT * FROM |")) as [
                vscode.TextDocument,
                vscode.Position,
            ]),
            token,
            invoke,
        ))!;
        const table = tables.items.find((i) => i.label === "customers")!;
        expect(table.kind).toBe(vscode.CompletionItemKind.File);
        const fn = tables.items.find((i) => i.label === "sales.top_lines")!;
        expect(fn.kind).toBe(vscode.CompletionItemKind.Value);
        expect(fn.insertText).toEqual(new vscode.SnippetString("sales.top_lines($0)"));
        expect(tables.items.find((i) => i.label === "sales")?.kind).toBe(
            vscode.CompletionItemKind.Module,
        );
        expect(tables.items.find((i) => i.label === "master")?.kind).toBe(
            vscode.CompletionItemKind.Method,
        );
    });

    it("ignores trigger characters that start nothing here", async () => {
        const { provider, connect } = setup();
        connect();
        const trigger = (character: string) =>
            ({
                triggerKind: vscode.CompletionTriggerKind.TriggerCharacter,
                triggerCharacter: character,
            }) as vscode.CompletionContext;
        const colon = document("SELECT a:|");
        expect(
            await provider.provideCompletionItems(colon.doc, colon.position, token, trigger(":")),
        ).toBeUndefined();
        const cast = document("SELECT a::|");
        expect(
            await provider.provideCompletionItems(cast.doc, cast.position, token, trigger(":")),
        ).toBeDefined();
        const bracket = document("SELECT * FROM [|");
        const list = await provider.provideCompletionItems(
            bracket.doc,
            bracket.position,
            token,
            trigger("["),
        );
        expect(list?.items.find((i) => i.label === "customers")?.insertText).toBe("[customers]");
    });

    it("reloads the metadata after the editor ran DDL", async () => {
        const { provider, connect, connection, ranText } = setup();
        connect();
        await provider.cache.get("untitled:a")!.whenLoaded();
        ranText.fire({ uri: "untitled:a", text: "SELECT * FROM customers" });
        expect(connection.calls.objects).toBe(1);
        ranText.fire({ uri: "untitled:a", text: "CREATE TABLE t (id int)" });
        expect(connection.calls.objects).toBe(2);
    });

    it("refreshes the active editor's cache, or asks for a SQL editor", async () => {
        const { provider, connect, connection } = setup();
        connect();
        const window = vscode.window as unknown as { activeTextEditor: unknown };
        window.activeTextEditor = undefined;
        await provider.refreshCache();
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        window.activeTextEditor = {
            document: { languageId: "sql", uri: vscode.Uri.parse("untitled:a") },
        };
        await provider.refreshCache();
        expect(connection.calls.objects).toBe(2);
        expect(vscode.window.setStatusBarMessage).toHaveBeenCalled();
        window.activeTextEditor = undefined;
        vi.clearAllMocks();
    });
});
