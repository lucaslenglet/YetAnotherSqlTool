/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql. Microsoft's service talks to sqltoolsservice
// (CreateSession / Expand requests answered by notifications); this one calls
// the drivers directly: a session is a DriverConnection, and expanding a node is
// DriverConnection.expandNode. The tree logic (groups, loading nodes, caching,
// in-flight deduplication, queued refreshes) is kept as is.
// Not ported: telemetry, filters, Azure serverless wake-up retries, Docker containers.

import * as vscode from "vscode";
import * as LocalizedConstants from "../constants/locConstants";
import * as Constants from "../constants/constants";
import { TreeNodeInfo } from "./nodes/treeNodeInfo";
import { ConnectionNode } from "./nodes/connectionNode";
import { ConnectionGroupNode } from "./nodes/connectionGroupNode";
import { AddConnectionTreeNode } from "./nodes/addConnectionTreeNode";
import { ConnectTreeNode } from "./nodes/connectTreeNode";
import { ExpandErrorNode } from "./nodes/expandErrorNode";
import { NoItemsNode } from "./nodes/noItemNode";
import { getNodeDescriptor } from "./nodes/nodeUtils";
import { ConnectionConfig, IConnectionConfig } from "../connectionconfig/connectionconfig";
import { IConnectionGroup, IConnectionProfile } from "../models/interfaces";
import { getConnectionDisplayName } from "../models/connectionInfo";
import { ConnectionProfile } from "../models/connectionProfile";
import { ILogger } from "../sharedInterfaces/logger";
import { logger } from "../models/logger";
import { getErrorMessage, uuid } from "../utils/utils";
import type { DriverConnection } from "../drivers/types";

/** Opens a driver connection for a profile; resolves undefined when the user cancels. */
export interface IConnector {
    connect(profile: IConnectionProfile): Promise<DriverConnection | undefined>;
}

/** Where the tree reads connections and groups, and removes connections. */
export interface IConnectionSource {
    readonly connectionConfig: IConnectionConfig;
    removeProfile(profile: IConnectionProfile): Promise<boolean>;
}

export class ObjectExplorerService {
    private _logger: ILogger = logger.withPrefix("ObjectExplorerService");

    /** Children shown under each expanded node, including loading, error and "no items" nodes. */
    private _treeNodeToChildrenMap = new Map<vscode.TreeItem, vscode.TreeItem[]>();

    private _connectionNodes = new Map<string, ConnectionNode>();
    private _connectionGroupNodes = new Map<string, ConnectionGroupNode>();
    private get _rootTreeNodeArray(): Array<TreeNodeInfo> {
        const rootGroup = this._connectionGroupNodes.get(ConnectionConfig.ROOT_GROUP_ID);
        return rootGroup ? rootGroup.children : [];
    }

    /** Open driver connections, by session id. */
    private _sessions = new Map<string, DriverConnection>();

    /**
     * Map of in-flight children fetches, keyed by node. Prevents multiple concurrent
     * fetches for the same node when VS Code calls getChildren repeatedly.
     */
    private _inFlightChildrenFetches = new Map<TreeNodeInfo, Promise<void>>();
    /** Nodes refreshed while a fetch was in flight; refetched once that fetch ends. */
    private _refreshQueuedAfterInFlight = new Set<TreeNodeInfo>();

    constructor(
        private _connections: IConnectionSource,
        private _connector: IConnector,
        private _refreshCallback: (node: TreeNodeInfo | undefined) => void,
    ) {}

    // Main method that routes to the appropriate handler
    public async getChildren(element?: TreeNodeInfo): Promise<vscode.TreeItem[]> {
        this._logger.trace(`getChildren called for ${getNodeDescriptor(element)}`);
        if (!element) {
            return this.getRootNodes();
        }

        if (element instanceof ConnectionGroupNode) {
            // If the connection group has no children, show the add connection node
            // so users can easily add a new connection under an empty group.
            if (!element.children || element.children.length === 0) {
                return this.getAddConnectionNodes(element);
            }
            return element.children;
        }

        return this.getNodeChildren(element);
    }

    /**
     * Clean all children of the node
     * @param node Node to cleanup
     */
    public cleanNodeChildren(node: vscode.TreeItem): void {
        if (this._treeNodeToChildrenMap.has(node)) {
            let stack = this._treeNodeToChildrenMap.get(node);
            while (stack.length > 0) {
                let child = stack.pop();
                if (this._treeNodeToChildrenMap.has(child)) {
                    stack.push(...this._treeNodeToChildrenMap.get(child));
                }
                this._treeNodeToChildrenMap.delete(child);
            }
            this._treeNodeToChildrenMap.delete(node);
        }
    }

    /**
     * Helper to show the Add Connection node; only displayed when there are no saved connections under the node
     * @returns An array containing the Add Connection node
     */
    private getAddConnectionNodes(parent?: TreeNodeInfo): AddConnectionTreeNode[] {
        return [new AddConnectionTreeNode(parent)];
    }

    /**
     * Handle getting root node children.
     * @returns The root node children
     */
    private async getRootNodes(): Promise<vscode.TreeItem[]> {
        const serverGroups = await this._connections.connectionConfig.getGroups();
        const savedConnections = await this._connections.connectionConfig.getConnections();

        // if there are no saved connections, show the add connection node
        if (
            savedConnections.length === 0 &&
            serverGroups.length === 1 &&
            serverGroups[0].id === ConnectionConfig.ROOT_GROUP_ID
        ) {
            this._logger.debug(
                "No saved connections or groups found. Showing add connection node.",
            );
            return this.getAddConnectionNodes();
        }

        const newConnectionGroupNodes = new Map<string, ConnectionGroupNode>();
        const newConnectionNodes = new Map<string, ConnectionNode>();

        // Add all group nodes from settings first
        // Read the user setting for collapsed/expanded state
        const config = vscode.workspace.getConfiguration(Constants.extensionName);
        const collapseGroups = config.get<boolean>(
            Constants.cmdObjectExplorerCollapseOrExpandByDefault,
            false,
        );

        for (const group of serverGroups) {
            const initialState = collapseGroups
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.Expanded;
            const groupNode = new ConnectionGroupNode(group, initialState);

            if (this._connectionGroupNodes.has(group.id)) {
                groupNode.id = this._connectionGroupNodes.get(group.id).id;
            }

            newConnectionGroupNodes.set(group.id, groupNode);
        }

        // Populate group hierarchy - add each group as a child to its parent
        for (const group of serverGroups) {
            // Skip the root group as it has no parent
            if (group.id === ConnectionConfig.ROOT_GROUP_ID) {
                continue;
            }

            if (group.parentId && newConnectionGroupNodes.has(group.parentId)) {
                const parentNode = newConnectionGroupNodes.get(group.parentId);
                const childNode = newConnectionGroupNodes.get(group.id);
                parentNode.addChild(childNode);

                if (parentNode.id !== ConnectionConfig.ROOT_GROUP_ID) {
                    // set the parent node for the child group unless the parent is the root group
                    childNode.parentNode = parentNode;
                }
            } else {
                this._logger.error(
                    `Group '${group.name}' with ID '${group.id}' does not have a valid parent group ID.  This should have been corrected when reading server groups from settings.`,
                );
            }
        }

        // Add connections as children of their respective groups
        for (const connection of savedConnections) {
            if (connection.groupId && newConnectionGroupNodes.has(connection.groupId)) {
                const groupNode = newConnectionGroupNodes.get(connection.groupId);

                let connectionNode: ConnectionNode;

                if (this._connectionNodes.has(connection.id)) {
                    connectionNode = this._connectionNodes.get(connection.id);
                    connectionNode.updateConnectionProfile(connection);
                    connectionNode.label = getConnectionDisplayName(connection);
                } else {
                    connectionNode = new ConnectionNode(
                        connection as ConnectionProfile,
                        groupNode.id === ConnectionConfig.ROOT_GROUP_ID ? undefined : groupNode,
                    );
                }

                connectionNode.parentNode =
                    groupNode.id === ConnectionConfig.ROOT_GROUP_ID ? undefined : groupNode;

                newConnectionNodes.set(connection.id, connectionNode);
                groupNode.addChild(connectionNode);
            } else {
                this._logger.error(
                    `Connection '${getConnectionDisplayName(connection)}' with ID '${connection.id}' does not have a valid group ID.  This should have been corrected when reading connections from settings.`,
                );
            }
        }

        // Connections removed from settings while connected: close their sessions.
        for (const [id, oldNode] of this._connectionNodes) {
            if (!newConnectionNodes.has(id)) {
                void this.closeSession(oldNode);
            }
        }

        this._connectionGroupNodes = newConnectionGroupNodes;
        this._connectionNodes = newConnectionNodes;

        return this._rootTreeNodeArray;
    }

    /**
     * Handles getting children for all nodes other than the root node
     * @param element The node to get children for
     * @returns The children of the node
     */
    private async getNodeChildren(element: TreeNodeInfo): Promise<vscode.TreeItem[]> {
        const wasRefresh = element.shouldRefresh;
        const hasInFlight = this._inFlightChildrenFetches.has(element);

        // Consume the refresh before showing the loading node. That update makes VS Code request
        // the children again, and the cleared flag prevents the callback from queuing a refresh.
        element.shouldRefresh = false;

        if (wasRefresh) {
            this.cleanNodeChildren(element);

            if (hasInFlight) {
                this._refreshQueuedAfterInFlight.add(element);
                return this.setLoadingUiForNode(element);
            }
        } else {
            if (this._treeNodeToChildrenMap.has(element)) {
                return this._treeNodeToChildrenMap.get(element);
            }
        }

        /**
         * If no children are cached, return a temporary loading node to keep the UI responsive
         * and trigger the async call to fetch real children.
         * This node will be replaced once the data is retrieved and the tree is refreshed.
         */
        void this.getOrCreateNodeChildrenWithSession(element);
        return this.setLoadingUiForNode(element);
    }

    /**
     * Sets a loading UI for the given node.
     * @param element The node to set the loading UI for
     * @returns A loading node that will be displayed in the tree
     */
    public async setLoadingUiForNode(element: TreeNodeInfo): Promise<vscode.TreeItem[]> {
        const label = element.loadingLabel ?? LocalizedConstants.ObjectExplorer.LoadingNodeLabel;
        const loadingNode = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        loadingNode.iconPath = new vscode.ThemeIcon("loading~spin");
        this._treeNodeToChildrenMap.set(element, [loadingNode]);
        this._refreshCallback(element);

        return this._treeNodeToChildrenMap.get(element);
    }

    /**
     * Get or create the children of a node. If the node has a session, expand it.
     * If it doesn't, connect first.
     */
    private async getOrCreateNodeChildrenWithSession(element: TreeNodeInfo): Promise<void> {
        const existing = this._inFlightChildrenFetches.get(element);
        if (existing) {
            return existing;
        }

        const fetchPromise = (async () => {
            try {
                if (element.sessionId && this._sessions.has(element.sessionId)) {
                    await this.expandExistingNode(element);
                } else if (element instanceof ConnectionNode) {
                    await this.createSessionAndExpandNode(element);
                } else {
                    // The session behind this node was closed: nothing left to expand.
                    this._treeNodeToChildrenMap.set(element, [new NoItemsNode(element)]);
                }
            } finally {
                this._inFlightChildrenFetches.delete(element);

                if (this._refreshQueuedAfterInFlight.delete(element)) {
                    element.loadingLabel = undefined;
                    this.cleanNodeChildren(element);
                    await this.setLoadingUiForNode(element);
                    void this.getOrCreateNodeChildrenWithSession(element);
                } else {
                    this._refreshCallback(element);
                }
            }
        })();

        this._inFlightChildrenFetches.set(element, fetchPromise);
        return fetchPromise;
    }

    /**
     * Expands a node through its session's driver connection and caches the result.
     * @returns The children of the node
     */
    public async expandNode(node: TreeNodeInfo): Promise<vscode.TreeItem[]> {
        this._logger.trace(`expandNode start: ${getNodeDescriptor(node)}`);
        const connection = this._sessions.get(node.sessionId);
        try {
            if (!connection || !node.objectNode) {
                throw new Error(LocalizedConstants.msgUnableToExpand);
            }
            const nodes = await connection.expandNode(node.objectNode);
            const children = nodes.map((n) =>
                TreeNodeInfo.fromObjectNode(n, node.sessionId, node, node.connectionProfile),
            );
            this._treeNodeToChildrenMap.set(node, children);
            return children;
        } catch (error) {
            const errorMessage = getErrorMessage(error);
            this._logger.error(
                `Expand node failed: ${errorMessage} for ${getNodeDescriptor(node)}`,
            );
            void vscode.window.showErrorMessage(errorMessage);
            const errorNode = new ExpandErrorNode(node, errorMessage);
            this._treeNodeToChildrenMap.set(node, [errorNode]);
            return [errorNode];
        } finally {
            node.loadingLabel = undefined;
        }
    }

    private async expandExistingNode(element: TreeNodeInfo): Promise<vscode.TreeItem[]> {
        const children = await this.expandNode(element);
        if (children?.length === 0) {
            const noItemsNode = [new NoItemsNode(element)];
            this._treeNodeToChildrenMap.set(element, noItemsNode);
            return noItemsNode;
        }
        return children;
    }

    private async createSessionAndExpandNode(element: ConnectionNode): Promise<void> {
        const connected = await this.connectNode(element);
        if (!connected) {
            // Cancelled or failed: leave a "Connect" item so the user can try again.
            this._treeNodeToChildrenMap.set(element, [new ConnectTreeNode(element)]);
            return;
        }
        await this.expandExistingNode(element);
    }

    /**
     * Opens a session for a connection node and switches it to the connected state.
     * @returns true when connected
     */
    public async connectNode(node: ConnectionNode): Promise<boolean> {
        const profile = node.connectionProfile;
        node.loadingLabel = LocalizedConstants.ObjectExplorer.Connecting;
        let connection: DriverConnection | undefined;
        try {
            connection = await this._connector.connect(profile);
        } catch (error) {
            const errorMessage = getErrorMessage(error);
            this._logger.error(`Connection to '${node.label}' failed: ${errorMessage}`);
            void this.showConnectionError(node, errorMessage);
            return false;
        } finally {
            node.loadingLabel = undefined;
        }
        if (!connection) {
            return false;
        }

        const sessionId = uuid();
        this._sessions.set(sessionId, connection);
        node.updateToConnectedState({
            nodeInfo: connection.getRootNode(),
            sessionId,
            parentNode: node.parentNode,
            connectionProfile: profile as ConnectionProfile,
        });
        return true;
    }

    private async showConnectionError(node: ConnectionNode, errorMessage: string): Promise<void> {
        const retry = LocalizedConstants.ObjectExplorer.FailedOEConnectionErrorRetry;
        const choice = await vscode.window.showErrorMessage(
            `${node.label}: ${errorMessage}`,
            retry,
        );
        if (choice === retry) {
            this.cleanNodeChildren(node);
            node.shouldRefresh = true;
            this._refreshCallback(node);
        }
    }

    /** Marks a node for refetch and asks VS Code to redraw it. */
    public refreshNode(node: TreeNodeInfo): void {
        node.shouldRefresh = true;
        this._refreshCallback(node);
    }

    /**
     * Removes a node from the OE tree. It will also disconnect the node from the server before removing it.
     * @param node The connection node to remove.
     * @param showUserConfirmationPrompt Whether to show a confirmation prompt to the user before removing the node.
     */
    public async removeNode(
        node: ConnectionNode,
        showUserConfirmationPrompt: boolean = true,
    ): Promise<void> {
        if (showUserConfirmationPrompt) {
            const response = await vscode.window.showInformationMessage(
                LocalizedConstants.ObjectExplorer.NodeDeletionConfirmation(node.label as string),
                {
                    modal: true,
                },
                LocalizedConstants.ObjectExplorer.NodeDeletionConfirmationYes,
                LocalizedConstants.ObjectExplorer.NodeDeletionConfirmationNo,
            );
            if (response !== LocalizedConstants.ObjectExplorer.NodeDeletionConfirmationYes) {
                return;
            }
        }

        await this.disconnectNode(node);
        this._connectionNodes.delete(node.connectionProfile.id);
        await this._connections.removeProfile(node.connectionProfile);
        this._refreshCallback(undefined); // Refresh tree root.
    }

    /**
     * Disconnects a connection node and cleans up its cached children.
     * @param node The connection node to disconnect.
     */
    public async disconnectNode(node: ConnectionNode): Promise<void> {
        await this.closeSession(node);
        this.cleanNodeChildren(node);
        node.updateToDisconnectedState();
        this._treeNodeToChildrenMap.set(node, [new ConnectTreeNode(node)]);
    }

    /** Closes the driver connection behind a node, if any. */
    public async closeSession(node: TreeNodeInfo): Promise<void> {
        const connection = node.sessionId ? this._sessions.get(node.sessionId) : undefined;
        if (!connection) {
            return;
        }
        this._sessions.delete(node.sessionId);
        this.cleanNodeChildren(node);
        try {
            await connection.close();
        } catch (error) {
            this._logger.error(`Error closing session: ${getErrorMessage(error)}`);
        }
    }

    /** Closes every open session; called when the extension deactivates. */
    public async dispose(): Promise<void> {
        const connections = [...this._sessions.values()];
        this._sessions.clear();
        await Promise.allSettled(connections.map((c) => c.close()));
    }

    public getConnectionNodeById(id: string): ConnectionNode | undefined {
        return id ? this._connectionNodes.get(id) : undefined;
    }

    public getServerGroupNodeById(id: string): ConnectionGroupNode | undefined {
        return id ? this._connectionGroupNodes.get(id) : undefined;
    }

    public get connections(): IConnectionProfile[] {
        return [...this._connectionNodes.values()].map((node) => node.connectionProfile);
    }

    public get connectionGroups(): IConnectionGroup[] {
        return [...this._connectionGroupNodes.values()].map((node) => node.connectionGroup);
    }

    /** Driver connection of a node's session; used by commands that run queries. */
    public getSession(node: TreeNodeInfo): DriverConnection | undefined {
        return node.sessionId ? this._sessions.get(node.sessionId) : undefined;
    }
}
