import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { mockEvents, MockStatusBarItem, MockTextEditorDecorationType } from "../vscodeMock";
import { EditorConnections } from "../../src/queries/editorConnections";
import type { Connector } from "../../src/connections/connector";
import type { IConnectionConfig } from "../../src/connectionconfig/connectionconfig";
import type { IConnectionProfile } from "../../src/models/interfaces";

// The connection color in the status bar and in the gutter of the editors, with VS Code mocked: status bar
// items and decoration types record what the extension sets on them.

const mockWindow = vscode.window as unknown as {
    activeTextEditor: unknown;
    visibleTextEditors: unknown[];
};

/** Color of the bar a decoration type draws: the fill of its SVG gutter icon. */
function barColor(type: MockTextEditorDecorationType): string | undefined {
    const uri = String(type.options.gutterIconPath);
    const match = /^data:image\/svg\+xml;base64,(.+)$/.exec(uri);
    if (!match) return undefined;
    const svg = Buffer.from(match[1], "base64").toString();
    // A 3px bar on the left edge, as high as the line.
    expect(svg).toMatch(/<rect x="0" y="0" width="3" height="100%"/);
    return /fill="(#[0-9a-f]{6})"/.exec(svg)?.[1];
}

/** A text editor that records the ranges set for each decoration type. */
class FakeEditor {
    readonly decorations = new Map<MockTextEditorDecorationType, vscode.Range[]>();
    readonly document: { uri: vscode.Uri; languageId: string; lineCount: number };
    constructor(uri: string, languageId = "sql", lineCount = 3) {
        this.document = { uri: vscode.Uri.parse(uri), languageId, lineCount };
    }
    setDecorations(type: MockTextEditorDecorationType, ranges: vscode.Range[]) {
        this.decorations.set(type, ranges);
    }
    /** Colors of the decorations shown in this editor, with the lines they cover. */
    bars(): { color: unknown; lines: [number, number] }[] {
        return [...this.decorations]
            .filter(([type, ranges]) => !type.disposed && ranges.length > 0)
            .flatMap(([type, ranges]) =>
                ranges.map((r) => ({
                    color: barColor(type),
                    lines: [r.start.line, r.end.line] as [number, number],
                })),
            );
    }
}

const connection = {
    serverInfo: { serverVersion: "16.0" },
    getCurrentDatabase: async () => "master",
    close: async () => undefined,
};

let savedProfiles: Partial<IConnectionProfile>[];
let connections: EditorConnections;
let statusItems: MockStatusBarItem[];

function createdDecorationTypes(): MockTextEditorDecorationType[] {
    return vi
        .mocked(vscode.window.createTextEditorDecorationType)
        .mock.results.map((r) => r.value as MockTextEditorDecorationType);
}

function liveDecorationTypes(): MockTextEditorDecorationType[] {
    return createdDecorationTypes().filter((t) => !t.disposed);
}

const connectionItem = () => statusItems[0];
const databaseItem = () => statusItems[1];

/** Lets the saved profiles load (it is asynchronous). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function profile(id: string, color?: string): IConnectionProfile {
    return { id, server: `${id}-server`, database: "master", color } as IConnectionProfile;
}

function changeSettings(section = "yast.connections") {
    mockEvents.onDidChangeConfiguration.fire({
        affectsConfiguration: (s: string) => section === s || section.startsWith(`${s}.`),
    });
}

beforeEach(async () => {
    vi.mocked(vscode.window.createStatusBarItem).mockClear();
    vi.mocked(vscode.window.createTextEditorDecorationType).mockClear();
    mockWindow.activeTextEditor = undefined;
    mockWindow.visibleTextEditors = [];
    savedProfiles = [];
    const connector = { connect: async () => connection } as unknown as Connector;
    const config = {
        getConnections: async () => savedProfiles.map((p) => ({ ...p })),
    } as unknown as IConnectionConfig;
    connections = new EditorConnections(connector, config);
    statusItems = vi
        .mocked(vscode.window.createStatusBarItem)
        .mock.results.map((r) => r.value as MockStatusBarItem);
    await settle();
});

afterEach(() => {
    connections.dispose();
});

/** Shows these editors, the first one active, as VS Code does before firing its events. */
function show(...editors: FakeEditor[]) {
    mockWindow.visibleTextEditors = editors;
    mockWindow.activeTextEditor = editors[0];
    mockEvents.onDidChangeVisibleTextEditors.fire(editors);
    mockEvents.onDidChangeActiveTextEditor.fire(editors[0]);
}

describe("status bar", () => {
    it("shows the connection and the database in the color of the saved profile", async () => {
        savedProfiles = [profile("prod", "#C50F1F")];
        changeSettings();
        await settle();
        const editor = new FakeEditor("file:///prod.sql");
        show(editor);

        await connections.connect(editor.document.uri.toString(), profile("prod", "#C50F1F"));

        expect(connectionItem().visible).toBe(true);
        expect(databaseItem().visible).toBe(true);
        expect(connectionItem().color).toBe("#c50f1f");
        expect(databaseItem().color).toBe("#c50f1f");
    });

    it("loses the color when the editor disconnects", async () => {
        savedProfiles = [profile("prod", "#c50f1f")];
        changeSettings();
        await settle();
        const editor = new FakeEditor("file:///prod.sql");
        show(editor);
        await connections.connect(editor.document.uri.toString(), profile("prod", "#c50f1f"));

        await connections.disconnect(editor.document.uri.toString());

        expect(connectionItem().text).toContain("Connect");
        expect(connectionItem().color).toBeUndefined();
        expect(databaseItem().visible).toBe(false);
    });

    it("has no color for a profile without one, or with an invalid one", async () => {
        savedProfiles = [profile("plain"), profile("odd", "red")];
        changeSettings();
        await settle();
        const editor = new FakeEditor("file:///plain.sql");
        show(editor);

        await connections.connect(editor.document.uri.toString(), profile("plain"));
        expect(connectionItem().color).toBeUndefined();
        await connections.connect(editor.document.uri.toString(), profile("odd", "red"));
        expect(connectionItem().color).toBeUndefined();
        expect(liveDecorationTypes()).toHaveLength(0);
    });

    it("follows the active editor", async () => {
        const colored = new FakeEditor("file:///colored.sql");
        const other = new FakeEditor("file:///other.sql");
        show(colored, other);
        await connections.connect(colored.document.uri.toString(), profile("x", "#107c10"));
        expect(connectionItem().color).toBe("#107c10");

        show(other, colored);
        expect(connectionItem().color).toBeUndefined();
    });
});

describe("color bar in the gutter of the editors", () => {
    it("covers every line of each visible editor of the connected document", async () => {
        const editor = new FakeEditor("file:///a.sql", "sql", 12);
        const split = new FakeEditor("file:///a.sql", "sql", 12);
        const notConnected = new FakeEditor("file:///b.sql");
        const notSql = new FakeEditor("file:///a.txt", "plaintext");
        show(editor, split, notConnected, notSql);

        await connections.connect(editor.document.uri.toString(), profile("x", "#0078D4"));

        const [type] = liveDecorationTypes();
        expect(liveDecorationTypes()).toHaveLength(1);
        expect(type.options).toMatchObject({
            isWholeLine: true,
            gutterIconSize: "100% 100%",
        });
        expect(barColor(type)).toBe("#0078d4");
        expect(editor.bars()).toEqual([{ color: "#0078d4", lines: [0, 11] }]);
        expect(split.bars()).toEqual([{ color: "#0078d4", lines: [0, 11] }]);
        expect(notConnected.bars()).toEqual([]);
        expect(notSql.bars()).toEqual([]);
    });

    it("never shows on a non-SQL editor, even with a connection", async () => {
        const editor = new FakeEditor("file:///a.txt", "plaintext");
        show(editor);
        await connections.connect(editor.document.uri.toString(), profile("x", "#0078d4"));
        expect(editor.bars()).toEqual([]);
    });

    it("appears in an editor of the document that becomes visible later", async () => {
        const editor = new FakeEditor("file:///a.sql");
        show(editor);
        await connections.connect(editor.document.uri.toString(), profile("x", "#0078d4"));

        const later = new FakeEditor("file:///a.sql");
        show(later);

        expect(later.bars()).toEqual([{ color: "#0078d4", lines: [0, 2] }]);
    });

    it("follows the document as lines are added", async () => {
        const editor = new FakeEditor("file:///a.sql", "sql", 3);
        show(editor);
        await connections.connect(editor.document.uri.toString(), profile("x", "#0078d4"));

        editor.document.lineCount = 40;
        mockEvents.onDidChangeTextDocument.fire({
            document: editor.document,
            contentChanges: [{ text: "\n" }],
        });

        expect(editor.bars()).toEqual([{ color: "#0078d4", lines: [0, 39] }]);
    });

    it("goes away when the editor disconnects, and its decoration type is disposed", async () => {
        const editor = new FakeEditor("file:///a.sql");
        show(editor);
        await connections.connect(editor.document.uri.toString(), profile("x", "#0078d4"));

        await connections.disconnect(editor.document.uri.toString());

        expect(editor.bars()).toEqual([]);
        expect(createdDecorationTypes()).toHaveLength(1);
        expect(liveDecorationTypes()).toHaveLength(0);
    });

    it("goes away when the editor reconnects with an uncolored profile", async () => {
        const editor = new FakeEditor("file:///a.sql");
        show(editor);
        await connections.connect(editor.document.uri.toString(), profile("x", "#0078d4"));

        await connections.connect(editor.document.uri.toString(), profile("y"));

        expect(editor.bars()).toEqual([]);
        expect(liveDecorationTypes()).toHaveLength(0);
    });

    it("uses one decoration type per color", async () => {
        const a = new FakeEditor("file:///a.sql");
        const b = new FakeEditor("file:///b.sql");
        const c = new FakeEditor("file:///c.sql");
        show(a, b, c);
        await connections.connect(a.document.uri.toString(), profile("x", "#0078d4"));
        await connections.connect(b.document.uri.toString(), profile("y", "#0078D4"));
        await connections.connect(c.document.uri.toString(), profile("z", "#107c10"));

        expect(liveDecorationTypes().map(barColor)).toEqual(["#0078d4", "#107c10"]);
        expect(a.bars()).toEqual([{ color: "#0078d4", lines: [0, 2] }]);
        expect(b.bars()).toEqual([{ color: "#0078d4", lines: [0, 2] }]);
        expect(c.bars()).toEqual([{ color: "#107c10", lines: [0, 2] }]);
    });

    it("disposes its decoration types with the editor connections", async () => {
        const editor = new FakeEditor("file:///a.sql");
        show(editor);
        await connections.connect(editor.document.uri.toString(), profile("x", "#0078d4"));

        connections.dispose();

        expect(liveDecorationTypes()).toHaveLength(0);
        expect(statusItems.every((item) => item.disposed)).toBe(true);
    });
});

describe("color changed in the settings", () => {
    it("applies to an editor already connected, without reconnecting", async () => {
        savedProfiles = [profile("prod", "#107c10")];
        changeSettings();
        await settle();
        const editor = new FakeEditor("file:///prod.sql");
        show(editor);
        const connect = vi.spyOn(connections, "connect");
        await connections.connect(editor.document.uri.toString(), profile("prod", "#107c10"));
        expect(editor.bars()).toEqual([{ color: "#107c10", lines: [0, 2] }]);

        savedProfiles = [profile("prod", "#c50f1f")];
        changeSettings();
        await settle();

        expect(connect).toHaveBeenCalledTimes(1);
        expect(connectionItem().color).toBe("#c50f1f");
        expect(databaseItem().color).toBe("#c50f1f");
        expect(editor.bars()).toEqual([{ color: "#c50f1f", lines: [0, 2] }]);
        // The type of the previous color is not leaked.
        expect(liveDecorationTypes().map(barColor)).toEqual(["#c50f1f"]);

        // Color removed from the saved profile: the snapshot's color no longer applies.
        savedProfiles = [profile("prod")];
        changeSettings();
        await settle();

        expect(connectionItem().color).toBeUndefined();
        expect(editor.bars()).toEqual([]);
        expect(liveDecorationTypes()).toHaveLength(0);
    });

    it("keeps the snapshot's color when the saved profile is gone", async () => {
        savedProfiles = [profile("prod", "#107c10")];
        changeSettings();
        await settle();
        const editor = new FakeEditor("file:///prod.sql");
        show(editor);
        await connections.connect(editor.document.uri.toString(), profile("prod", "#107c10"));

        savedProfiles = [];
        changeSettings();
        await settle();

        expect(connectionItem().color).toBe("#107c10");
        expect(editor.bars()).toEqual([{ color: "#107c10", lines: [0, 2] }]);
    });

    it("ignores changes to other settings", async () => {
        const editor = new FakeEditor("file:///prod.sql");
        show(editor);
        await connections.connect(editor.document.uri.toString(), profile("prod", "#107c10"));

        savedProfiles = [profile("prod", "#c50f1f")];
        changeSettings("yast.statusBar.connectionInfoMaxLength");
        await settle();

        expect(connectionItem().color).toBe("#107c10");
    });
});

describe("metadata hint", () => {
    /** Replaces the editor connections of this test with ones over `driverConnection`. */
    function connectWith(driverConnection: object): EditorConnections {
        connections.dispose();
        const connector = { connect: async () => driverConnection } as unknown as Connector;
        const config = { getConnections: async () => [] } as unknown as IConnectionConfig;
        connections = new EditorConnections(connector, config);
        return connections;
    }

    it("tells the connection that autocompletion will read the catalog of the database it logged in to", async () => {
        const prepareMetadata = vi.fn();
        const editors = connectWith({ ...connection, prepareMetadata });

        expect(await editors.connect("file:///a.sql", profile("prod"))).toBe(true);

        expect(prepareMetadata).toHaveBeenCalledTimes(1);
        expect(prepareMetadata).toHaveBeenCalledWith();
    });

    it("does not when autocompletion is off", async () => {
        const prepareMetadata = vi.fn();
        const editors = connectWith({ ...connection, prepareMetadata });
        const spy = vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
            get: (key: string, fallback?: unknown) =>
                key === "intelliSense.enableIntelliSense" ? false : fallback,
        } as never);
        try {
            expect(await editors.connect("file:///a.sql", profile("prod"))).toBe(true);
        } finally {
            spy.mockRestore();
        }

        expect(prepareMetadata).not.toHaveBeenCalled();
    });

    it("closes a connection that fails after logging in, with what the hint opened", async () => {
        const close = vi.fn(async () => undefined);
        const editors = connectWith({
            ...connection,
            prepareMetadata: vi.fn(),
            getCurrentDatabase: async () => {
                throw new Error("connection lost");
            },
            close,
        });

        expect(await editors.connect("file:///a.sql", profile("prod"))).toBe(false);

        expect(close).toHaveBeenCalledTimes(1);
        expect(editors.isConnected("file:///a.sql")).toBe(false);
    });

    it("connects a driver connection that has no hint", async () => {
        const editors = connectWith(connection);

        expect(await editors.connect("file:///a.sql", profile("prod"))).toBe(true);
        expect(editors.get("file:///a.sql")?.database).toBe("master");
    });
});
