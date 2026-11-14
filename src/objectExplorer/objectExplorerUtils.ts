/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { TreeNodeInfo } from "./nodes/treeNodeInfo";
import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import { IconUtils } from "../utils/iconUtils";
import { getDriver } from "../drivers";

export class ObjectExplorerUtils {
    /**
     * Gets the path to the icon for a given node type.
     * @param nodeType The type of node to get the icon for
     * @returns The path to the icon for the node type
     */
    public static iconPath(nodeType: string): vscode.Uri | undefined {
        return IconUtils.getIcon("objectTypes", `${nodeType}.svg`);
    }

    /**
     * Gets the database name for the node - which is the database name of the connection for a server node, the database name
     * for nodes at or under a database node or a default value if it's neither of those.
     * @param node The node to get the database name of
     * @returns The database name
     */
    public static getDatabaseName(node: TreeNodeInfo): string {
        // We're on a server node so just use the database directly from the connection string
        if (
            node.nodeType === Constants.serverLabel ||
            node.nodeType === Constants.disconnectedServerNodeType
        ) {
            return node.connectionProfile.database;
        }
        // Drivers tag every node under a database with its name.
        return node.objectNode?.database ?? LocalizedConstants.defaultDatabaseLabel;
    }

    /** Quoted, schema-qualified name of the node's object, e.g. [dbo].[customers] or "public"."customers". */
    public static getQualifiedName(node: TreeNodeInfo): string {
        let objectString = "";
        if (node.metadata) {
            const quote = (name: string) =>
                getDriver(node.connectionProfile?.provider).quoteIdentifier(name);
            switch (node.metadata.metadataTypeName) {
                case "Table":
                case "StoredProcedure":
                case "View":
                case "UserDefinedFunction":
                    objectString = node.metadata.schema
                        ? `${quote(node.metadata.schema)}.${quote(node.metadata.name)}`
                        : quote(node.metadata.name);
                    break;
                default:
                    objectString = quote(node.metadata.name);
                    break;
            }
        }
        return objectString;
    }
}
