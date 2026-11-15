import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerQueryCommands } from "../../src/queries/queryCommands";
import * as Constants from "../../src/constants/constants";

// The "change database" list of an editor honors the database filter of its connection.

const databases = ["app-dev-1", "app-rec-1", "master", "tempdb"];

async function pickerLabels(options: { filter?: string; current: string }) {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(((
        command: string,
        handler: (...args: any[]) => unknown,
    ) => {
        handlers.set(command, handler);
        return { dispose: () => undefined };
    }) as any);
    (vscode.window as any).activeTextEditor = {
        document: { languageId: "sql", uri: { toString: () => "file:///a.sql" } },
    };
    const connections = {
        get: () => ({
            profile: { databaseFilter: options.filter },
            database: options.current,
            connection: { listDatabases: async () => databases },
        }),
    };
    registerQueryCommands({ subscriptions: [] } as any, {} as any, connections as any, {} as any);

    let items: { label: string; description?: string }[] = [];
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce((async (list: any) => {
        items = list;
        return undefined;
    }) as any);
    await handlers.get(Constants.cmdChangeDatabase)!();
    return items;
}

describe("yast.changeDatabase", () => {
    it("lists every database when the connection has no filter", async () => {
        const items = await pickerLabels({ current: "master" });
        expect(items.map((i) => i.label)).toEqual(databases);
    });

    it("lists the matching databases and the current one, which is marked", async () => {
        const items = await pickerLabels({ filter: "*-dev-*", current: "master" });
        expect(items.map((i) => i.label)).toEqual(["app-dev-1", "master"]);
        expect(items.find((i) => i.label === "master")?.description).toBe("$(check)");
    });

    it("does not list the current database twice when it matches", async () => {
        const items = await pickerLabels({ filter: "*-dev-*", current: "app-dev-1" });
        expect(items.map((i) => i.label)).toEqual(["app-dev-1"]);
    });
});
