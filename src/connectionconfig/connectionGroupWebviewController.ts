/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql's controllers/connectionGroupWebviewController.ts (telemetry removed).

import * as vscode from "vscode";
import { WebviewPanelController } from "../controllers/webviewPanelController";
import {
    ConnectionGroupState,
    ConnectionGroupReducers,
    ConnectionGroupSpec,
    CreateConnectionGroupDialogProps,
} from "../sharedInterfaces/connectionGroup";
import { getErrorMessage, uuid } from "../utils/utils";
import * as Loc from "../constants/locConstants";
import { IConnectionGroup } from "../models/interfaces";
import { IConnectionConfig } from "./connectionconfig";

/**
 * Controller for the Create / Edit Connection Group dialog
 */
export class ConnectionGroupWebviewController extends WebviewPanelController<
    ConnectionGroupState,
    ConnectionGroupReducers,
    boolean
> {
    constructor(
        context: vscode.ExtensionContext,
        private connectionConfig: IConnectionConfig,
        private connectionGroupToEdit?: IConnectionGroup,
    ) {
        super(
            context,
            "connectionGroup",
            "ConnectionGroup",
            {
                existingGroupName: connectionGroupToEdit?.name,
                name: connectionGroupToEdit?.name || "",
                description: connectionGroupToEdit?.description || "",
                color: connectionGroupToEdit?.color || "",
                message: "",
            },
            {
                title: connectionGroupToEdit
                    ? Loc.ConnectionGroup.editExistingGroup(connectionGroupToEdit.name)
                    : Loc.ConnectionGroup.createNewGroup,
                viewColumn: vscode.ViewColumn.One,
                iconPath: {
                    light: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "connectionGroup_light.svg",
                    ),
                    dark: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "connectionGroup_dark.svg",
                    ),
                },
            },
        );
        this.registerRpcHandlers();
        this.updateState();
    }

    /**
     * Register reducers for handling actions from the webview
     */
    private registerRpcHandlers(): void {
        this.registerReducer("closeDialog", async (state) => {
            this.dialogResult.resolve(false);
            this.panel.dispose();
            return state;
        });

        this.registerReducer("saveConnectionGroup", async (state, payload) => {
            try {
                if (this.connectionGroupToEdit) {
                    await this.connectionConfig.updateGroup({
                        ...this.connectionGroupToEdit,
                        name: payload.name,
                        description: payload.description,
                        color: payload.color,
                    });
                } else {
                    await this.connectionConfig.addGroup(createConnectionGroupFromSpec(payload));
                }

                this.dialogResult.resolve(true);
                await this.panel.dispose();
            } catch (err) {
                state.message = getErrorMessage(err);
            }

            return state;
        });
    }
}

export function createConnectionGroupFromSpec(spec: ConnectionGroupSpec): IConnectionGroup {
    return {
        name: spec.name,
        description: spec.description,
        color: spec.color,
        id: uuid(),
        configSource: vscode.ConfigurationTarget.Global,
    };
}

/**
 * Shared function to get the default properties for the Create Connection Group dialog.
 */
export function getDefaultConnectionGroupDialogProps(): CreateConnectionGroupDialogProps {
    return {
        type: "createConnectionGroup",
        props: {} as ConnectionGroupState,
    };
}

/**
 * Creates a connection group from the provided spec and saves it.
 * @returns the created group, or an error message.
 */
export async function createConnectionGroup(
    connectionGroupSpec: ConnectionGroupSpec,
    connectionConfig: IConnectionConfig,
): Promise<IConnectionGroup | string> {
    const addedGroup = createConnectionGroupFromSpec(connectionGroupSpec);
    try {
        await connectionConfig.addGroup(addedGroup);
    } catch (err) {
        return getErrorMessage(err);
    }
    return addedGroup;
}
