import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { MAX_EDITOR_SCRIPT_LENGTH, ScriptingService } from "../../src/scripting/scriptingService";

// The vscode mock has no editors: the parts of the API the service uses are added here.
const openTextDocument = vi.fn();
const showTextDocument = vi.fn();
const withProgress = vi.fn((_options: unknown, task: (...args: any[]) => Promise<unknown>) =>
    task(),
);
Object.assign(vscode.workspace, { openTextDocument });
Object.assign(vscode.window, { showTextDocument, withProgress });
Object.assign(vscode, { ProgressLocation: { Notification: 15 } });

const profile = { profileName: "p", server: "s", database: "" };

function fakeNode(overrides: Record<string, unknown> = {}) {
    return {
        nodeType: "Table",
        label: "dbo.customers",
        connectionProfile: profile,
        metadata: { schema: "dbo", name: "customers" },
        objectNode: { nodeType: "Table", database: "yast" },
        ...overrides,
    } as never;
}

describe("ScriptingService.scriptNode", () => {
    const scriptObject = vi.fn();
    const getSession = vi.fn();
    const connect = vi.fn();
    const runQuery = vi.fn();
    let service: ScriptingService;
    const editor = { document: { uri: { toString: () => "untitled:1" } } };

    beforeEach(() => {
        vi.clearAllMocks();
        getSession.mockReturnValue({ scriptObject });
        scriptObject.mockResolvedValue("SELECT 1");
        openTextDocument.mockResolvedValue(editor.document);
        showTextDocument.mockResolvedValue(editor);
        connect.mockResolvedValue(true);
        service = new ScriptingService(
            { getSession } as never,
            { connect } as never,
            { runQuery } as never,
        );
    });

    it("opens the script in a new SQL editor, connects it with the node's database and runs it", async () => {
        await service.scriptNode(fakeNode(), "select");
        expect(scriptObject).toHaveBeenCalledWith(
            { nodeType: "Table", database: "yast" },
            "select",
        );
        expect(openTextDocument).toHaveBeenCalledWith({ language: "sql", content: "SELECT 1" });
        expect(connect).toHaveBeenCalledWith("untitled:1", profile, "yast");
        expect(runQuery).toHaveBeenCalledTimes(1);
    });

    it("tells the user when the script cannot be generated, and opens nothing", async () => {
        scriptObject.mockRejectedValue(new Error("boom"));
        await service.scriptNode(fakeNode(), "select");
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            "Failed to generate script: boom",
        );
        expect(openTextDocument).not.toHaveBeenCalled();
    });

    it("does nothing when the node has no session or no scripting metadata", async () => {
        getSession.mockReturnValue(undefined);
        await service.scriptNode(fakeNode(), "select");
        getSession.mockReturnValue({ scriptObject });
        await service.scriptNode(fakeNode({ metadata: undefined }), "select");
        expect(scriptObject).not.toHaveBeenCalled();
        expect(openTextDocument).not.toHaveBeenCalled();
    });

    it("does not run the script of an operation other than select", async () => {
        await service.scriptNode(fakeNode(), "create");
        expect(openTextDocument).toHaveBeenCalled();
        expect(runQuery).not.toHaveBeenCalled();
    });
});

describe("ScriptingService.scriptDatabase", () => {
    const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
    const showInformationMessage = vscode.window.showInformationMessage as unknown as ReturnType<
        typeof vi.fn
    >;
    const showSaveDialog = vi.fn();
    Object.assign(vscode.window, { showSaveDialog });
    const scriptDatabase = vi.fn();
    const getSession = vi.fn();
    const connect = vi.fn();
    let service: ScriptingService;
    let directory: string;
    const editor = { document: { uri: { toString: () => "untitled:2" } } };
    const databaseNode = () =>
        ({
            nodeType: "Database",
            label: "yast",
            connectionProfile: profile,
            objectNode: { nodeType: "Database", database: "yast" },
        }) as never;
    /** Fires the cancellation token of the progress notification. */
    let cancel: () => void = () => undefined;

    /** Picks the items with these labels, in order. */
    function pick(...labels: string[]) {
        for (const label of labels) {
            showQuickPick.mockImplementationOnce(async (items: Array<{ label: string }>) =>
                items.find((i) => i.label === label),
            );
        }
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        directory = await mkdtemp(join(tmpdir(), "yast-script-"));
        getSession.mockReturnValue({ scriptDatabase });
        openTextDocument.mockResolvedValue(editor.document);
        showTextDocument.mockResolvedValue(editor);
        withProgress.mockImplementation(async (_options, task) => {
            const listeners: Array<() => void> = [];
            cancel = () => listeners.forEach((listener) => listener());
            return task(
                { report: vi.fn() },
                { onCancellationRequested: (listener: () => void) => listeners.push(listener) },
            );
        });
        scriptDatabase.mockImplementation(async (_db, _options, write) => {
            await write("CREATE TABLE t (id int)\nGO\n");
            await write("INSERT t VALUES (1)\nGO\n");
        });
        service = new ScriptingService(
            { getSession } as never,
            { connect } as never,
            { runQuery: vi.fn() } as never,
        );
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it("asks what to script and opens the script in a new editor connected to the database", async () => {
        pick("Schema and data", "Open in a new query editor");
        await service.scriptDatabase(databaseNode());
        expect(scriptDatabase).toHaveBeenCalledWith(
            "yast",
            { schema: true, data: true },
            expect.any(Function),
            expect.any(AbortSignal),
            expect.any(Function),
        );
        expect(openTextDocument).toHaveBeenCalledWith({
            language: "sql",
            content: "CREATE TABLE t (id int)\nGO\nINSERT t VALUES (1)\nGO\n",
        });
        expect(connect).toHaveBeenCalledWith("untitled:2", profile, "yast");
    });

    it("passes the choice of schema or data", async () => {
        pick("Schema only", "Open in a new query editor");
        await service.scriptDatabase(databaseNode());
        pick("Data only", "Open in a new query editor");
        await service.scriptDatabase(databaseNode());
        expect(scriptDatabase.mock.calls.map((c) => c[1])).toEqual([
            { schema: true, data: false },
            { schema: false, data: true },
        ]);
    });

    it("does nothing when a pick or the save dialog is dismissed", async () => {
        await service.scriptDatabase(databaseNode());
        pick("Schema only");
        await service.scriptDatabase(databaseNode());
        pick("Schema only", "Save to file...");
        showSaveDialog.mockResolvedValue(undefined);
        await service.scriptDatabase(databaseNode());
        expect(scriptDatabase).not.toHaveBeenCalled();
    });

    it("streams the script into the chosen file, then offers to open it", async () => {
        const file = join(directory, "out.sql");
        pick("Schema and data", "Save to file...");
        showSaveDialog.mockResolvedValue({ fsPath: file });
        showInformationMessage.mockResolvedValueOnce("Open");
        await service.scriptDatabase(databaseNode());
        expect(await readFile(file, "utf8")).toBe(
            "CREATE TABLE t (id int)\nGO\nINSERT t VALUES (1)\nGO\n",
        );
        expect(showInformationMessage).toHaveBeenCalledWith(`Script saved to ${file}.`, "Open");
        expect(openTextDocument).toHaveBeenCalledWith({ fsPath: file });
        expect(connect).not.toHaveBeenCalled();
    });

    it("deletes the partial file when canceled, and says nothing", async () => {
        const file = join(directory, "out.sql");
        pick("Schema and data", "Save to file...");
        showSaveDialog.mockResolvedValue({ fsPath: file });
        scriptDatabase.mockImplementation(async (_db, _options, write, signal: AbortSignal) => {
            await write("CREATE TABLE t (id int)\nGO\n");
            cancel();
            expect(signal.aborted).toBe(true);
            const error = new Error("The script was canceled.");
            error.name = "AbortError";
            throw error;
        });
        await service.scriptDatabase(databaseNode());
        await expect(stat(file)).rejects.toThrow();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        expect(showInformationMessage).not.toHaveBeenCalled();
    });

    it("deletes the partial file and shows the error when scripting fails", async () => {
        const file = join(directory, "out.sql");
        pick("Schema and data", "Save to file...");
        showSaveDialog.mockResolvedValue({ fsPath: file });
        scriptDatabase.mockImplementation(async (_db, _options, write) => {
            await write("partial");
            throw new Error("connection lost");
        });
        await service.scriptDatabase(databaseNode());
        await expect(stat(file)).rejects.toThrow();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            "Failed to generate script: connection lost",
        );
    });

    it("refuses to open a script too large for an editor", async () => {
        pick("Schema and data", "Open in a new query editor");
        const chunk = "x".repeat(1024 * 1024);
        let written = 0;
        scriptDatabase.mockImplementation(async (_db, _options, write) => {
            for (let i = 0; i <= MAX_EDITOR_SCRIPT_LENGTH / chunk.length; i++) {
                await write(chunk);
                written++;
            }
        });
        await service.scriptDatabase(databaseNode());
        expect(written).toBe(MAX_EDITOR_SCRIPT_LENGTH / chunk.length);
        expect(openTextDocument).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            "The script is larger than 50 MB, too large for an editor. Save it to a file instead.",
        );
    });
});
