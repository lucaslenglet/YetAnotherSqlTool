/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql: reads the editor's connection from EditorConnections.
// Shows the connection of a SQL editor on its first line: "Connect" when the editor
// has none, else [profile name] | server | database, each clickable.

import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import { generateDatabaseDisplayName, generateServerDisplayName } from "../models/connectionInfo";
import { IConnectionConfig } from "../connectionconfig/connectionconfig";
import { EditorConnections, EditorConnection } from "../queries/editorConnections";

export const connectionCodeLensRange = new vscode.Range(0, 0, 0, 0);

export class SqlCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private _disposables: vscode.Disposable[] = [];
    private _codeLensChangedEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses?: vscode.Event<void> = this._codeLensChangedEmitter.event;

    constructor(
        private _connections: EditorConnections,
        private _connectionConfig: IConnectionConfig,
    ) {
        this._disposables.push(
            this._codeLensChangedEmitter,
            this._connections.onDidChange(() => this._codeLensChangedEmitter.fire()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration(
                        Constants.configShowActiveConnectionAsCodeLensSuggestion,
                    ) ||
                    e.affectsConfiguration(
                        `${Constants.extensionName}.${Constants.connectionsArrayName}`,
                    )
                ) {
                    this._codeLensChangedEmitter.fire();
                }
            }),
        );
    }

    public async provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken,
    ): Promise<vscode.CodeLens[]> {
        const shouldShowActiveConnection = vscode.workspace
            .getConfiguration()
            .get<boolean>(Constants.configShowActiveConnectionAsCodeLensSuggestion, true);
        if (!shouldShowActiveConnection) {
            return [];
        }

        const uri = document.uri.toString();
        const connection = this._connections.get(uri);
        if (this._connections.isConnecting(uri)) {
            return [
                new vscode.CodeLens(connectionCodeLensRange, {
                    title: `$(loading~spin) ${LocalizedConstants.StatusBar.connectingLabel}`,
                    command: "",
                }),
            ];
        }
        if (!connection) {
            // On no connection, show a single "Connect" CodeLens
            return [
                new vscode.CodeLens(connectionCodeLensRange, {
                    title: LocalizedConstants.QueryEditor.codeLensConnect,
                    command: Constants.cmdConnect,
                }),
            ];
        }

        // If connected, show [profile name] | server | database
        const codeLenses: vscode.CodeLens[] = [];
        const credentials = { ...connection.profile, database: connection.database };
        const profileName = await this.getMatchingProfileName(connection);
        if (profileName) {
            codeLenses.push(
                new vscode.CodeLens(connectionCodeLensRange, {
                    title: `$(star-full) ${profileName}`,
                    command: Constants.cmdConnect,
                }),
            );
        }
        codeLenses.push(
            new vscode.CodeLens(connectionCodeLensRange, {
                title: generateServerDisplayName(credentials),
                command: Constants.cmdConnect,
            }),
            new vscode.CodeLens(connectionCodeLensRange, {
                title: generateDatabaseDisplayName(credentials),
                command: Constants.cmdChooseDatabase,
            }),
        );
        return codeLenses;
    }

    /**
     * Returns the profile name for the current connection if unchanged from the profile's
     * saved configuration (server + database) or if the profile does not specify a database.
     */
    private async getMatchingProfileName(
        connection: EditorConnection,
    ): Promise<string | undefined> {
        const id = connection.profile.id;
        if (!id) {
            return undefined;
        }
        const profile = await this._connectionConfig.getConnectionById(id).catch(() => undefined);
        if (
            profile &&
            profile.server === connection.profile.server &&
            (!profile.database || profile.database === connection.database)
        ) {
            return profile.profileName;
        }
        return undefined;
    }

    public dispose(): void {
        this._disposables.forEach((d) => d.dispose());
        this._disposables = [];
    }
}
