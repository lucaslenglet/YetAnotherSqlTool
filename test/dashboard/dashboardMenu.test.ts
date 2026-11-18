import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { pgDriver } from "../../src/drivers/pg";
import type { Driver } from "../../src/drivers/types";
import type { ConnectionProfile } from "../../src/models/connectionProfile";
import { ConnectionNode } from "../../src/objectExplorer/nodes/connectionNode";
import { IconUtils } from "../../src/utils/iconUtils";

IconUtils.initialize(vscode.Uri.file(process.cwd()));

// The "Dashboard" item of the Object Explorer: on connected servers whose engine has a dashboard.

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const entry = manifest.contributes.menus["view/item/context"].find(
    (e: { command: string }) => e.command === "yast.openDashboard",
);
const pattern = new RegExp(/viewItem =~ \/(.*)\/$/.exec(entry.when)![1]);

const original = pgDriver.openDashboard;
afterEach(() => {
    (pgDriver as Driver).openDashboard = original;
});

function connectedNode(provider: "pg" | "mssql", database = ""): ConnectionNode {
    const profile = { id: "p", provider, server: "s", database } as unknown as ConnectionProfile;
    const node = new ConnectionNode(profile);
    node.updateToConnectedState({
        nodeInfo: { nodePath: "s", nodeType: "Server", label: "s", isLeaf: false } as never,
        sessionId: "session",
        parentNode: undefined as never,
        connectionProfile: profile,
    });
    return node;
}

describe("Dashboard menu item", () => {
    it("is offered on a connected server whose engine has a dashboard", () => {
        (pgDriver as Driver).openDashboard = async () => ({}) as never;
        expect(pattern.test(connectedNode("pg").contextValue!)).toBe(true);
        expect(pattern.test(connectedNode("pg", "sales").contextValue!)).toBe(true);
        expect(entry.when.startsWith("view == yastObjectExplorer")).toBe(true);
    });

    it("is not offered on a server whose engine has none, nor on a disconnected one", () => {
        (pgDriver as Driver).openDashboard = undefined;
        expect(pattern.test(connectedNode("pg").contextValue!)).toBe(false);

        (pgDriver as Driver).openDashboard = async () => ({}) as never;
        const node = connectedNode("pg");
        node.updateToDisconnectedState();
        expect(pattern.test(node.contextValue!)).toBe(false);
    });

    it("is not offered on other nodes", () => {
        for (const value of [
            "type=Database,filterable=false,hasFilters=false,subType=,",
            "type=Table,filterable=false,hasFilters=false,subType=,",
            "type=disconnectedServer,filterable=false,hasFilters=false,subType=undefined,",
        ]) {
            expect(pattern.test(value), value).toBe(false);
        }
    });

    it("has its command in the palette, where it asks for the connection", () => {
        const hidden = manifest.contributes.menus.commandPalette.find(
            (e: { command: string }) => e.command === "yast.openDashboard",
        );
        expect(hidden).toBeUndefined();
        expect(
            manifest.contributes.commands.some(
                (c: { command: string }) => c.command === "yast.openDashboard",
            ),
        ).toBe(true);
    });
});
