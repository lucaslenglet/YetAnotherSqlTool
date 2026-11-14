import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { TreeNodeInfo } from "../../src/objectExplorer/nodes/treeNodeInfo";
import { ConnectionGroupNode } from "../../src/objectExplorer/nodes/connectionGroupNode";
import { ConnectTreeNode } from "../../src/objectExplorer/nodes/connectTreeNode";
import { ObjectExplorerUtils } from "../../src/objectExplorer/objectExplorerUtils";
import { mssqlOptions, pgOptions } from "../support/databases";
import { createExplorer, iconFile, labelOf } from "./serviceHarness";

const { service, children, expandPath, connectionNode } = createExplorer(
    mssqlOptions(),
    pgOptions(),
);

describe("SQL Server connection", () => {
    it("connects on expand and shows the driver tree down to columns", async () => {
        const server = await connectionNode("mssql-docker");
        const columns = await expandPath(
            server,
            "Databases",
            "yast",
            "Tables",
            "dbo.customers",
            "Columns",
        );

        expect(server.context.type).toBe("Server");
        expect(server.parentNode).toBeInstanceOf(ConnectionGroupNode);
        expect(iconFile(server)).toBe("Database_green.svg");
        expect((await children(columns)).map(labelOf)).toContain("id (PK, int, not null)");
    });

    it("copies schema-qualified names with the engine's quoting", async () => {
        const server = await connectionNode("mssql-docker");
        const table = await expandPath(server, "Databases", "yast", "Tables", "dbo.customers");
        expect(ObjectExplorerUtils.getQualifiedName(table)).toBe("[dbo].[customers]");
        expect(table.context.type).toBe("Table");
    });

    it("uses icons that exist for every node of the yast database", async () => {
        const server = await connectionNode("mssql-docker");
        const database = await expandPath(server, "Databases", "yast");
        await expectIconsExist(database, 4);
    });
});

describe("PostgreSQL connection", () => {
    it("shows the driver tree down to columns", async () => {
        const server = await connectionNode("pg-docker");
        const table = await expandPath(
            server,
            "Databases",
            "yast",
            "Schemas",
            "public",
            "Tables",
            "customers",
        );
        expect(ObjectExplorerUtils.getQualifiedName(table)).toBe('"public"."customers"');
        const columns = await expandPath(table, "Columns");
        expect((await children(columns)).map(labelOf).some((l) => l.startsWith("id ("))).toBe(true);
    });

    it("uses icons that exist for every node of the public schema", async () => {
        const server = await connectionNode("pg-docker");
        const schema = await expandPath(server, "Databases", "yast", "Schemas", "public");
        await expectIconsExist(schema, 4);
    });

    it("disconnects, then reconnects on refresh", async () => {
        const server = await connectionNode("pg-docker");
        await expandPath(server, "Databases");

        await service.disconnectNode(server);
        expect(server.context.type).toBe("disconnectedServer");
        const afterDisconnect = await service.getChildren(server);
        expect(afterDisconnect).toHaveLength(1);
        expect(afterDisconnect[0]).toBeInstanceOf(ConnectTreeNode);

        service.refreshNode(server);
        await expandPath(server, "Databases");
        expect(server.context.type).toBe("Server");
    });
});

describe("connection failure", () => {
    it("shows the error and leaves a Connect item to retry", async () => {
        const node = await connectionNode("pg-bad-password");
        const items = await children(node);

        expect(items).toHaveLength(1);
        expect(items[0]).toBeInstanceOf(ConnectTreeNode);
        expect(node.context.type).toBe("disconnectedServer");
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Bad password: "),
            "Retry",
        );
    });
});

/** Walks the tree under a node and checks that each node's icon file exists. */
async function expectIconsExist(node: TreeNodeInfo, depth: number): Promise<void> {
    const missing = new Set<string>();
    let visited = 0;
    const walk = async (current: TreeNodeInfo, level: number) => {
        if (level === 0 || current.collapsibleState === vscode.TreeItemCollapsibleState.None)
            return;
        for (const child of await children(current)) {
            if (!(child instanceof TreeNodeInfo)) continue;
            visited++;
            if (!existsSync((child.iconPath as vscode.Uri).path)) {
                missing.add(`${iconFile(child)} (${labelOf(child)})`);
            }
            await walk(child, level - 1);
        }
    };
    await walk(node, depth);
    expect(visited).toBeGreaterThan(20);
    expect([...missing]).toEqual([]);
}
