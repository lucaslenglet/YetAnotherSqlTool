/**
 * Object Explorer view and its commands, including the connection and
 * connection group dialogs it opens. Handlers follow vscode-mssql's mainController.
 */

import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import { ObjectExplorerProvider } from "./objectExplorerProvider";
import { ConnectionStore } from "../connections/connectionStore";
import { Connector } from "../connections/connector";
import {
    ConnectionDialogWebviewController,
    IConnectionDialogHost,
} from "../connectionconfig/connectionDialogWebviewController";
import { ConnectionGroupWebviewController } from "../connectionconfig/connectionGroupWebviewController";
import { IConnectionGroup, IConnectionProfile } from "../models/interfaces";
import { TreeNodeInfo } from "./nodes/treeNodeInfo";
import { ConnectionNode } from "./nodes/connectionNode";
import { ConnectionGroupNode } from "./nodes/connectionGroupNode";
import { ConnectTreeNode } from "./nodes/connectTreeNode";
import { ObjectExplorerUtils } from "./objectExplorerUtils";
import type { ScriptOperation } from "../drivers/types";

export function registerObjectExplorer(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    connector: Connector,
    scriptNode?: (node: TreeNodeInfo, operation: ScriptOperation) => Promise<void>,
    scriptDatabase?: (node: TreeNodeInfo) => Promise<void>,
): ObjectExplorerProvider {
    const connectionConfig = store.connectionConfig;
    const provider = new ObjectExplorerProvider(store, connector);
    const service = provider.objectExplorerService;
    const tree = vscode.window.createTreeView(Constants.objectExplorerId, {
        treeDataProvider: provider,
        canSelectMany: false,
        showCollapseAll: true,
    });
    context.subscriptions.push(tree, {
        dispose: () => void provider.objectExplorerService.dispose(),
    });

    const resolveSelectedNode = (node?: TreeNodeInfo): TreeNodeInfo | undefined => {
        if (!node && tree.selection?.length === 1) {
            return tree.selection[0];
        }
        return node;
    };

    const register = (command: string, handler: (...args: any[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(command, handler));

    const dialogHost: IConnectionDialogHost = {
        revealConnection: async (profile: IConnectionProfile) => {
            await service.getChildren(); // rebuilds the connection nodes from settings
            provider.refresh(undefined);
            const node = service.getConnectionNodeById(profile.id);
            if (node) {
                await tree.reveal(node, { select: true, focus: true, expand: true });
            }
        },
        disconnectConnection: async (profileId: string) => {
            const node = service.getConnectionNodeById(profileId);
            if (node?.sessionId) {
                await provider.disconnectNode(node);
            }
        },
    };

    const openConnectionDialog = (
        connectionToEdit?: IConnectionProfile,
        group?: IConnectionGroup,
    ) => {
        const dialog = new ConnectionDialogWebviewController(
            context,
            store,
            connector,
            dialogHost,
            connectionToEdit,
            group,
        );
        dialog.revealToForeground();
    };

    register(Constants.cmdAddObjectExplorer, (args?: unknown) => {
        openConnectionDialog(
            undefined,
            args instanceof ConnectionGroupNode ? args.connectionGroup : undefined,
        );
    });

    register(Constants.cmdEditConnection, (nodeOrProfile: TreeNodeInfo | IConnectionProfile) => {
        const profile =
            nodeOrProfile instanceof TreeNodeInfo
                ? nodeOrProfile.connectionProfile
                : (nodeOrProfile as IConnectionProfile);
        if (profile) {
            openConnectionDialog(profile);
        }
    });

    register(Constants.cmdConnectionGroupCreate, () => {
        new ConnectionGroupWebviewController(context, connectionConfig).revealToForeground();
    });

    register(Constants.cmdConnectionGroupEdit, (node: ConnectionGroupNode) => {
        new ConnectionGroupWebviewController(
            context,
            connectionConfig,
            node.connectionGroup,
        ).revealToForeground();
    });

    register(Constants.cmdConnectObjectExplorerNode, (node: ConnectTreeNode) => {
        provider.refreshNode(node.parentNode);
    });

    register(Constants.cmdDisconnectObjectExplorerNode, async (node: ConnectionNode) => {
        await provider.disconnectNode(node);
    });

    register(Constants.cmdRemoveObjectExplorerNode, async (node: ConnectionNode) => {
        await provider.removeNode(node);
    });

    register(Constants.cmdRefreshObjectExplorerNode, (node?: TreeNodeInfo) => {
        node = resolveSelectedNode(node);
        if (node) {
            provider.refreshNode(node);
        }
    });

    register(Constants.cmdCopyObjectName, async (node?: TreeNodeInfo) => {
        node = resolveSelectedNode(node);
        if (!node) {
            return;
        }
        const name = ObjectExplorerUtils.getQualifiedName(node);
        if (name) {
            await vscode.env.clipboard.writeText(name);
        }
    });

    // vscode-mssql's ScriptingService.getNodeForScripting: the selected node when none is passed.
    const nodeForScripting = (node?: TreeNodeInfo): TreeNodeInfo | undefined => {
        if (node) return node;
        if (tree.selection.length === 0) {
            vscode.window.showInformationMessage(LocalizedConstants.msgSelectNodeToScript);
            return undefined;
        }
        if (tree.selection.length > 1) {
            vscode.window.showInformationMessage(LocalizedConstants.msgSelectSingleNodeToScript);
            return undefined;
        }
        return tree.selection[0];
    };
    const scriptCommands: Array<[string, ScriptOperation]> = [
        [Constants.cmdScriptSelect, "select"],
        [Constants.cmdScriptCreate, "create"],
        [Constants.cmdScriptDelete, "delete"],
        [Constants.cmdScriptExecute, "execute"],
        [Constants.cmdScriptAlter, "alter"],
    ];
    for (const [command, operation] of scriptCommands) {
        register(command, async (node?: TreeNodeInfo) => {
            const target = nodeForScripting(node);
            if (target) await scriptNode?.(target, operation);
        });
    }

    // SSMS's "Generate Scripts..." on a database (no vscode-mssql equivalent).
    register(Constants.cmdScriptDatabase, async (node?: TreeNodeInfo) => {
        const target = nodeForScripting(node);
        if (target) await scriptDatabase?.(target);
    });

    register(Constants.cmdConnectionGroupDelete, async (node: ConnectionGroupNode) => {
        if (!(node instanceof ConnectionGroupNode)) {
            return;
        }
        const label = typeof node.label === "string" ? node.label : node.label.label;

        let result: string | undefined;
        if (node.children.length > 0) {
            result = await vscode.window.showInformationMessage(
                LocalizedConstants.ObjectExplorer.ConnectionGroupDeletionConfirmationWithContents(
                    label,
                ),
                { modal: true },
                LocalizedConstants.ObjectExplorer.ConnectionGroupDeleteContents,
                LocalizedConstants.ObjectExplorer.ConnectionGroupMoveContents,
            );
        } else {
            result = await vscode.window.showInformationMessage(
                LocalizedConstants.ObjectExplorer.ConnectionGroupDeletionConfirmationWithoutContents(
                    label,
                ),
                { modal: true },
                LocalizedConstants.Common.delete,
            );
        }
        if (
            result === LocalizedConstants.ObjectExplorer.ConnectionGroupDeleteContents ||
            result === LocalizedConstants.Common.delete
        ) {
            await connectionConfig.removeGroup(node.connectionGroup.id, "delete");
        } else if (result === LocalizedConstants.ObjectExplorer.ConnectionGroupMoveContents) {
            await connectionConfig.removeGroup(node.connectionGroup.id, "move");
        }
    });

    // Connections and groups live in settings: redraw when they change (by hand or by us).
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (
                e.affectsConfiguration(
                    `${Constants.extensionName}.${Constants.connectionsArrayName}`,
                ) ||
                e.affectsConfiguration(
                    `${Constants.extensionName}.${Constants.connectionGroupsArrayName}`,
                )
            ) {
                provider.refresh(undefined);
            }
        }),
        // Workspace connections are ignored until the folder is trusted.
        vscode.workspace.onDidGrantWorkspaceTrust(() => provider.refresh(undefined)),
    );

    return provider;
}
