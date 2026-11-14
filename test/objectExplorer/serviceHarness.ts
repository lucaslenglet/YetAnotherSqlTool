import { resolve } from "node:path";
import { afterAll, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import { ObjectExplorerService } from "../../src/objectExplorer/objectExplorerService";
import { TreeNodeInfo } from "../../src/objectExplorer/nodes/treeNodeInfo";
import { ConnectionNode } from "../../src/objectExplorer/nodes/connectionNode";
import { Connector } from "../../src/connections/connector";
import { IconUtils } from "../../src/utils/iconUtils";
import { ConnectionConfig, IConnectionConfig } from "../../src/connectionconfig/connectionconfig";
import { IConnectionGroup, IConnectionProfile } from "../../src/models/interfaces";

// Shared by objectExplorerService.test.ts (no database: nothing is expanded) and
// objectExplorerService.integration.test.ts (expands the connections).

const repoRoot = resolve(__dirname, "../..");
IconUtils.initialize(vscode.Uri.file(repoRoot));

type Options = Record<string, string | number | boolean>;

export const labelOf = (item: vscode.TreeItem) =>
    typeof item.label === "string" ? item.label : item.label.label;

/** Icon file names of a node, from its iconPath. */
export const iconFile = (node: TreeNodeInfo) => (node.iconPath as vscode.Uri).path.split("/").pop();

const isLoading = (items: vscode.TreeItem[]) =>
    items.length === 1 && items[0].iconPath instanceof vscode.ThemeIcon;

/**
 * An Object Explorer service over three saved connections: "mssql-docker" in the "Dev" group,
 * "pg-docker" and "pg-bad-password" (the same server with a wrong password) at the root.
 * Call it at the top of a test file: it registers the hooks that reset and dispose it.
 */
export function createExplorer(mssqlOptions: Options, pgOptions: Options) {
    const groups = [
        { id: ConnectionConfig.ROOT_GROUP_ID, name: ConnectionConfig.ROOT_GROUP_ID },
        { id: "dev", name: "Dev", parentId: ConnectionConfig.ROOT_GROUP_ID },
    ] as IConnectionGroup[];

    const mssqlProfile = {
        ...mssqlOptions,
        id: "mssql-docker",
        groupId: "dev",
        profileName: "SQL Server (Docker)",
        provider: "mssql",
    } as unknown as IConnectionProfile;

    const pgProfile = {
        ...pgOptions,
        id: "pg-docker",
        groupId: ConnectionConfig.ROOT_GROUP_ID,
        profileName: "PostgreSQL (Docker)",
        provider: "pg",
    } as unknown as IConnectionProfile;

    const badPasswordProfile = {
        ...pgProfile,
        id: "pg-bad-password",
        profileName: "Bad password",
        password: "wrong",
    } as IConnectionProfile;

    const connectionConfig = {
        getGroups: async () => groups,
        getConnections: async () => [mssqlProfile, pgProfile, badPasswordProfile],
    } as unknown as IConnectionConfig;

    const service = new ObjectExplorerService(
        { connectionConfig, removeProfile: async () => true },
        new Connector(),
        () => undefined,
    );

    afterAll(() => service.dispose());

    beforeEach(() => {
        vi.mocked(vscode.window.showErrorMessage).mockClear();
    });

    /** Children of a node once loaded: the first call only returns a "Loading..." item. */
    async function children(node?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const deadline = Date.now() + 20000;
        for (;;) {
            const items = await service.getChildren(node as TreeNodeInfo);
            if (!isLoading(items)) return items;
            if (Date.now() > deadline) throw new Error(`Timed out expanding ${labelOf(node)}`);
            await new Promise((r) => setTimeout(r, 20));
        }
    }

    async function expandPath(node: vscode.TreeItem, ...labels: string[]): Promise<TreeNodeInfo> {
        let current = node;
        for (const label of labels) {
            const items = await children(current);
            current = items.find((i) => labelOf(i) === label);
            if (!current) {
                throw new Error(`'${label}' not found among: ${items.map(labelOf).join(", ")}`);
            }
        }
        return current as TreeNodeInfo;
    }

    async function connectionNode(id: string): Promise<ConnectionNode> {
        await children(); // loads the root, which creates the connection nodes
        return service.getConnectionNodeById(id);
    }

    return { service, children, expandPath, connectionNode };
}
