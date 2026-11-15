/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscodeMssql from "vscode-mssql";
import { FormItemSpec, FormContextProps, FormState, FormReducers, FormItemOptions } from "./form";
import { ApiStatus } from "./webview";
import { ConnectionGroupSpec, ConnectionGroupState } from "./connectionGroup";
import { NotificationType, RequestType } from "vscode-jsonrpc";
import type { DriverId } from "../drivers/types";
import { ChangePasswordResult, ChangePasswordWebviewState } from "./changePassword";
import { DialogMessageSpec } from "./dialogMessage";

export class ConnectionDialogWebviewState implements FormState<
    IConnectionDialogProfile,
    ConnectionDialogWebviewState,
    ConnectionDialogFormItemSpec
> {
    /** the underlying connection profile for the form target; same as `connectionProfile` */
    formState: IConnectionDialogProfile = {} as IConnectionDialogProfile;
    /** The underlying connection profile for the form target; a more intuitively-named alias for `formState` */
    get connectionProfile(): IConnectionDialogProfile {
        return this.formState;
    }
    set connectionProfile(value: IConnectionDialogProfile) {
        this.formState = value;
    }

    formComponents: Partial<Record<keyof IConnectionDialogProfile, ConnectionDialogFormItemSpec>> =
        {};

    public connectionComponents: ConnectionComponentsInfo = {
        mainOptions: [],
        groupedAdvancedOptions: [],
    };
    public savedConnections: IConnectionDialogProfile[] = [];
    public recentConnections: IConnectionDialogProfile[] = [];
    public isEditingConnection: boolean = false;
    public editingConnectionDisplayName: string | undefined;
    public connectionStatus: ApiStatus = ApiStatus.NotStarted;
    public connectionAction: ConnectionSubmitAction = ConnectionSubmitAction.Connect;
    public testConnectionSucceeded: boolean = false;
    public readyToConnect: boolean = false;
    public formMessage: DialogMessageSpec | undefined;
    public dialog: IDialogProps | undefined;

    constructor(params?: Partial<ConnectionDialogWebviewState>) {
        for (const key in params) {
            if (key in this) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- safe due to key in this check being a Partial of the class
                (this as any)[key as keyof ConnectionDialogWebviewState] =
                    params[key as keyof ConnectionDialogWebviewState]!;
            }
        }
    }
}

export interface IDialogProps {
    type:
        | "trustServerCert"
        | "loadFromConnectionString"
        | "createConnectionGroup"
        | "changePassword"
        | "fileBrowser";
}

export interface TrustServerCertDialogProps extends IDialogProps {
    type: "trustServerCert";
    message: string;
}

export interface ChangePasswordDialogProps extends IDialogProps {
    type: "changePassword";
    props: ChangePasswordWebviewState;
}

export interface ConnectionStringDialogProps extends IDialogProps {
    type: "loadFromConnectionString";
    connectionString: string;
    connectionStringError?: string;
}
export interface CreateConnectionGroupDialogProps extends IDialogProps {
    type: "createConnectionGroup";
    props: ConnectionGroupState;
}

export interface ConnectionComponentsInfo {
    mainOptions: (keyof IConnectionDialogProfile)[];
    groupedAdvancedOptions: ConnectionComponentGroup[];
}

export interface ConnectionComponentGroup {
    groupName: string;
    options: (keyof IConnectionDialogProfile)[];
}

export interface ConnectionDialogFormItemSpec extends FormItemSpec<
    IConnectionDialogProfile,
    ConnectionDialogWebviewState,
    ConnectionDialogFormItemSpec
> {
    optionCategory?: string;
    optionCategoryLabel?: string;
}

export enum ConnectionSubmitAction {
    Connect = "connect",
    TestConnection = "testConnection",
    SaveWithoutConnecting = "saveWithoutConnecting",
}

// A Connection Profile contains all the properties of connection credentials, with additional
// optional name and details on whether password should be saved
export interface IConnectionDialogProfile extends vscodeMssql.IConnectionInfo {
    /** Database engine; profiles without it are SQL Server ones. */
    provider?: DriverId;
    /** PostgreSQL options (see src/drivers/pg/options.ts). */
    sslmode?: string;
    sslrootcert?: string;
    searchPath?: string;
    clientId?: string;
    profileName?: string;
    groupId?: string;
    /** Patterns of the databases the connection shows; every database when empty. */
    databaseFilter?: string;
    /** Color (`#RRGGBB`) shown in the editors that use the connection. */
    color?: string;
    savePassword?: boolean;
    emptyPasswordInput?: boolean;
    azureAuthType?: vscodeMssql.AzureAuthType;
    id?: string;
}

export enum AuthenticationType {
    /**
     * Username and password
     */
    SqlLogin = "SqlLogin",
    /**
     * Windows Authentication
     */
    Integrated = "Integrated",
    /**
     * Microsoft Entra Id - Universal with MFA support
     */
    AzureMFA = "AzureMFA",
    /**
     * Microsoft Entra Id - Default
     */
    ActiveDirectoryDefault = "ActiveDirectoryDefault",
    /**
     * Microsoft Entra Id - Password
     */
    AzureMFAAndUser = "AzureMFAAndUser",
    /**
     * Microsoft Entra Id - Service Principal (client ID + client secret)
     */
    ActiveDirectoryServicePrincipal = "ActiveDirectoryServicePrincipal",
    /**
     * Datacenter Security Token Service Authentication
     */
    DSTSAuth = "dstsAuth",
    /**
     * No authentication required
     */
    None = "None",
}

export interface ConnectionDialogContextProps extends FormContextProps<IConnectionDialogProfile> {
    // Reducers
    loadConnectionForEdit: (connection: IConnectionDialogProfile) => void;
    loadConnectionAsNewDraft: (connection: IConnectionDialogProfile) => void;
    connect: () => void;
    testConnection: () => void;
    saveWithoutConnecting: () => void;
    retryLastSubmitAction: () => void;
    closeDialog: () => void;
    closeMessage: () => void;
    openCreateConnectionGroupDialog: () => void;
    createConnectionGroup: (connectionGroupSpec: ConnectionGroupSpec) => void;
    refreshConnectionsList: () => void;
    deleteSavedConnection(connection: IConnectionDialogProfile): void;
    removeRecentConnection(connection: IConnectionDialogProfile): void;
    loadFromConnectionString: (connectionString: string) => void;
    openConnectionStringDialog: () => void;
    messageButtonClicked: (buttonId: string) => void;

    // Request handlers
    getConnectionDisplayName: (connection: IConnectionDialogProfile) => Promise<string>;
    changePassword: (newPassword: string) => Promise<ChangePasswordResult>;
}

export interface ConnectionDialogReducers extends FormReducers<IConnectionDialogProfile> {
    loadConnectionForEdit: {
        connection: IConnectionDialogProfile;
    };
    loadConnectionAsNewDraft: {
        connection: IConnectionDialogProfile;
    };
    connect: {};
    testConnection: {};
    saveWithoutConnecting: {};
    retryLastSubmitAction: {};
    createConnectionGroup: {
        connectionGroupSpec: ConnectionGroupSpec;
    };
    openCreateConnectionGroupDialog: {};
    closeDialog: {};
    closeMessage: {};
    refreshConnectionsList: {};
    deleteSavedConnection: {
        connection: IConnectionDialogProfile;
    };
    removeRecentConnection: {
        connection: IConnectionDialogProfile;
    };
    loadFromConnectionString: { connectionString: string };
    openConnectionStringDialog: {};
    messageButtonClicked: { buttonId: string };
}

export namespace OpenOptionInfoLinkNotification {
    export const type = new NotificationType<{ option: FormItemOptions }>(
        "connectionDialog/openOptionInfoLink",
    );
}

export namespace OpenAzureDataStudioMigrationRequest {
    export const type = new RequestType<void, void, void>(
        "connectionDialog/openAzureDataStudioMigration",
    );
}

export namespace GetConnectionDisplayNameRequest {
    export const type = new RequestType<IConnectionDialogProfile, string, void>(
        "getConnectionDisplayName",
    );
}

export type ConnectionSubDialogDisplayType = "standalone" | "modal";
