/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { IConnectionSource, IConnector, ObjectExplorerService } from "./objectExplorerService";
import { TreeNodeInfo } from "./nodes/treeNodeInfo";
import { ConnectionNode } from "./nodes/connectionNode";
import { ILogger } from "../sharedInterfaces/logger";
import { logger } from "../models/logger";
import { getNodeDescriptor } from "./nodes/nodeUtils";

export class ObjectExplorerProvider implements vscode.TreeDataProvider<any> {
    private _onDidChangeTreeData: vscode.EventEmitter<any | undefined> = new vscode.EventEmitter<
        any | undefined
    >();
    readonly onDidChangeTreeData: vscode.Event<any | undefined> = this._onDidChangeTreeData.event;

    private _objectExplorerService: ObjectExplorerService;
    private _logger: ILogger = logger.withPrefix("ObjectExplorerProvider");

    constructor(connections: IConnectionSource, connector: IConnector) {
        this._objectExplorerService = new ObjectExplorerService(connections, connector, (node) => {
            this.refresh(node);
        });
    }

    public getParent(element: TreeNodeInfo) {
        return element.parentNode;
    }

    public refresh(nodeInfo?: TreeNodeInfo): void {
        this._logger.trace(`refresh fired for ${getNodeDescriptor(nodeInfo)}`);
        this._onDidChangeTreeData.fire(nodeInfo);
    }

    public getTreeItem(node: TreeNodeInfo): TreeNodeInfo {
        return node;
    }

    public async getChildren(element?: TreeNodeInfo): Promise<vscode.TreeItem[]> {
        return this._objectExplorerService.getChildren(element);
    }

    public async removeNode(node: ConnectionNode): Promise<void> {
        await this._objectExplorerService.removeNode(node);
    }

    public async disconnectNode(node: ConnectionNode): Promise<void> {
        await this._objectExplorerService.disconnectNode(node);
        this.refresh(node);
    }

    public refreshNode(node: TreeNodeInfo): void {
        this._logger.trace(`refreshNode called for ${getNodeDescriptor(node)}`);
        this._objectExplorerService.refreshNode(node);
    }

    public get objectExplorerService(): ObjectExplorerService {
        return this._objectExplorerService;
    }
}
