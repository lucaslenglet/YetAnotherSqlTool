/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql: nodes are built from driver ObjectNodes instead of
// sqltoolsservice NodeInfos. Filters are not supported yet.

import * as vscode from "vscode";
import * as vscodeMssql from "vscode-mssql";
import { ObjectExplorerUtils } from "../objectExplorerUtils";
import * as Constants from "../../constants/constants";
import { ObjectMetadata } from "vscode-mssql";
import { IConnectionProfile } from "../../models/interfaces";
import { uuid } from "../../utils/utils";
import type { ObjectNode } from "../../drivers/types";

export class TreeNodeInfo extends vscode.TreeItem {
    private _nodePath: string;
    private _nodeType: string;
    private _nodeSubType: string;
    private _sessionId: string;
    private _parentNode: TreeNodeInfo;
    private _connectionProfile: IConnectionProfile;
    private _metadata: ObjectMetadata;
    private _objectNode: ObjectNode | undefined;
    private _loadingLabel: string | undefined;

    /**
     * Use this flag to force a refresh of the node in the next expansion.
     * It will be reset to false after the refresh is done.
     */
    public shouldRefresh: boolean = false;

    constructor(
        label: string,
        context: vscodeMssql.TreeNodeContextValue,
        collapsibleState: vscode.TreeItemCollapsibleState,
        nodePath: string,
        nodeType: string,
        sessionId: string,
        connectionProfile: IConnectionProfile,
        parentNode: TreeNodeInfo,
        nodeSubType: string,
        objectMetadata?: ObjectMetadata,
        objectNode?: ObjectNode,
    ) {
        super(label, collapsibleState);
        this.context = context;
        this._nodePath = nodePath;
        this._nodeType = nodeType;
        this._sessionId = sessionId;
        this._parentNode = parentNode;
        this._connectionProfile = connectionProfile;
        this._metadata = objectMetadata;
        this._nodeSubType = nodeSubType;
        this._objectNode = objectNode;
        if (this._nodeSubType) {
            this.iconPath = ObjectExplorerUtils.iconPath(`${this._nodeType}_${this._nodeSubType}`);
        } else {
            this.iconPath = ObjectExplorerUtils.iconPath(this.nodeType);
        }
        this.id = this.generateId();
    }

    // Generating a unique ID for the node
    protected generateId(): string {
        return `${this._connectionProfile?.id}-${this._nodePath}-${uuid()}`;
    }

    public static fromObjectNode(
        node: ObjectNode,
        sessionId: string,
        parentNode: TreeNodeInfo,
        connectionProfile: IConnectionProfile,
    ): TreeNodeInfo {
        return new TreeNodeInfo(
            node.label,
            {
                type: node.nodeType,
                filterable: false,
                hasFilters: false,
                subType: node.nodeSubType ?? "",
            },
            node.isLeaf
                ? vscode.TreeItemCollapsibleState.None
                : node.nodeType === Constants.serverLabel
                  ? vscode.TreeItemCollapsibleState.Expanded
                  : vscode.TreeItemCollapsibleState.Collapsed,
            node.nodePath,
            node.nodeType,
            sessionId,
            connectionProfile,
            parentNode,
            node.nodeSubType,
            node.metadata,
            node,
        );
    }

    /** Getters */
    public get nodePath(): string {
        return this._nodePath;
    }

    public get nodeType(): string {
        return this._nodeType;
    }

    public get sessionId(): string {
        return this._sessionId;
    }

    public get nodeSubType(): string {
        return this._nodeSubType;
    }

    public get parentNode(): TreeNodeInfo {
        return this._parentNode;
    }

    public get loadingLabel(): string | undefined {
        return this._loadingLabel;
    }

    /**
     * Returns a **copy** of the node's connection information.
     *
     * ⚠️ Note: This is a **shallow copy**—modifying the returned object will NOT affect the original connection info.
     * If you want to update the actual connection info stored in the node, use the `updateConnectionProfile` method instead.
     */
    public get connectionProfile(): IConnectionProfile | undefined {
        if (!this._connectionProfile) {
            return undefined;
        }
        return {
            ...this._connectionProfile,
        };
    }

    public get metadata(): ObjectMetadata {
        return this._metadata;
    }

    /** The driver node this tree node was built from; passed back to the driver to expand it. */
    public get objectNode(): ObjectNode | undefined {
        return this._objectNode;
    }

    public get context(): vscodeMssql.TreeNodeContextValue {
        return this._convertToTreeNodeContext(this.contextValue);
    }

    /** Setters */
    public set nodePath(value: string) {
        this._nodePath = value;
    }

    public set nodeType(value: string) {
        this._nodeType = value;
    }

    public set nodeSubType(value: string) {
        this._nodeSubType = value;
    }

    public set sessionId(value: string) {
        this._sessionId = value;
    }

    public set parentNode(value: TreeNodeInfo) {
        this._parentNode = value;
    }

    public set context(value: vscodeMssql.TreeNodeContextValue) {
        this.contextValue = this._convertToContextValue(value);
    }

    public set loadingLabel(value: string | undefined) {
        this._loadingLabel = value;
    }

    public updateConnectionProfile(value: IConnectionProfile): void {
        this._connectionProfile = value;
    }

    protected updateMetadata(value: ObjectMetadata): void {
        this._metadata = value;
    }

    protected updateObjectNode(value: ObjectNode | undefined): void {
        this._objectNode = value;
    }

    //split the context value with, and is in the form of key=value and convert it to TreeNodeContextValue
    private _convertToTreeNodeContext(contextValue: string): vscodeMssql.TreeNodeContextValue {
        let contextArray = contextValue.split(",");
        let context: vscodeMssql.TreeNodeContextValue = {
            filterable: false,
            hasFilters: false,
            type: undefined,
            subType: undefined,
        };
        contextArray.forEach((element) => {
            let keyValuePair = element.split("=");
            context[keyValuePair[0]] = keyValuePair[1];
        });
        return context;
    }

    //convert TreeNodeContextValue to context value string
    private _convertToContextValue(context: vscodeMssql.TreeNodeContextValue): string {
        if (context === undefined) {
            return "";
        }
        let contextValue = "";
        Object.keys(context).forEach((key) => {
            contextValue += key + "=" + context[key] + ",";
        });
        return contextValue;
    }
}
