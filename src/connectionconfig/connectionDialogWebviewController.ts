/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql's connectionconfig/connectionDialogWebviewController.ts.
// Same reducers and submit flow (validate -> test -> save -> connect and reveal in the
// Object Explorer), but connections are opened through our drivers instead of
// sqltoolsservice, and a "provider" field selects the engine: changing it rebuilds
// the form from that driver's options.
// Not ported yet: Entra tenant picker (step 7), password change.
// Removed: Azure and Fabric browsing, Azure firewall rules, telemetry, Docker,
// Azure Data Studio migration.

import * as vscode from "vscode";
import * as LocalizedConstants from "../constants/locConstants";
import {
    AuthenticationType,
    ConnectionDialogFormItemSpec,
    ConnectionDialogReducers,
    ConnectionDialogWebviewState,
    ConnectionStringDialogProps,
    ConnectionSubmitAction,
    GetConnectionDisplayNameRequest,
    IConnectionDialogProfile,
    TrustServerCertDialogProps,
} from "../sharedInterfaces/connectionDialog";
import { FormItemActionButton, FormItemOptions, FormItemType } from "../sharedInterfaces/form";
import { ApiStatus } from "../sharedInterfaces/webview";
import { IConnectionGroup, IConnectionProfile } from "../models/interfaces";
import { CredentialsQuickPickItemType, IConnectionProfileWithSource } from "../models/interfaces";
import { getConnectionDisplayName, getDefaultConnection } from "../models/connectionInfo";
import { FormWebviewController } from "../forms/formWebviewController";
import { Deferred } from "../protocol";
import { getErrorMessage } from "../utils/utils";
import * as Constants from "../constants/constants";
import { ConnectionConfig } from "./connectionconfig";
import {
    generateConnectionComponents,
    groupAdvancedOptions,
    mainOptionsByProvider,
} from "./formComponentHelpers";
import {
    createConnectionGroup,
    getDefaultConnectionGroupDialogProps,
} from "./connectionGroupWebviewController";
import { ConnectionStore } from "../connections/connectionStore";
import { Connector, openConnection } from "../connections/connector";
import { getDriver } from "../drivers";
import type { DriverId } from "../drivers/types";
import {
    areCompatibleEntraAccountIds,
    getDefaultTenantId,
    isPersonalMicrosoftAccount,
    getVscodeEntraAccountOptions,
    getVscodeEntraTenantOptions,
} from "../azure/vscodeEntraMfaUtils";

export const CONNECTION_DIALOG_VIEW_ID = "connectionDialog";

/** What the dialog needs from the Object Explorer. */
export interface IConnectionDialogHost {
    /** Shows a saved connection in the tree, connected and expanded. */
    revealConnection(profile: IConnectionProfile): Promise<void>;
    /** Closes the tree's session for a connection being edited or deleted. */
    disconnectConnection(profileId: string): Promise<void>;
}

/** Databases listed under "System databases" in the Database dropdown, per engine. */
const systemDatabases: Record<DriverId, string[]> = {
    mssql: Constants.systemDatabases,
    pg: ["postgres"],
};

export class ConnectionDialogWebviewController extends FormWebviewController<
    IConnectionDialogProfile,
    ConnectionDialogWebviewState,
    ConnectionDialogFormItemSpec,
    ConnectionDialogReducers
> {
    public readonly initialized: Deferred<void> = new Deferred<void>();

    /** Properties that trigger a database list fetch when changed */
    private static readonly _dbFetchTriggerProps: readonly (keyof IConnectionDialogProfile)[] = [
        "server",
        "port",
        "authenticationType",
        "user",
        "password",
        "accountId",
        "trustServerCertificate",
        "encrypt",
        "sslmode",
    ];

    private _connectionBeingEdited: IConnectionDialogProfile | undefined;
    private _lastSubmittedAction: ConnectionSubmitAction = ConnectionSubmitAction.Connect;
    /** Engine whose options are currently in the form. */
    private _formProvider: DriverId | undefined;

    /** Incremented on each database fetch to allow superseding in-flight requests. */
    private _dbFetchCounter = 0;
    /** Fetch key currently reflected in the UI (options + loadStatus). */
    private _activeDbFetchKey = "";
    /** Cache of database lists keyed by fetch key, reused within the same dialog session. */
    private _databaseListCache: Map<string, string[]> = new Map();
    private _originalUserLabel: string | undefined;
    private _originalUserTooltip: string | undefined;
    private _originalPasswordLabel: string | undefined;
    private _originalPasswordTooltip: string | undefined;
    private _originalSavePasswordLabel: string | undefined;
    /** Tenants of each Microsoft account, read once per dialog. */
    private _cachedEntraTenants: Map<string, FormItemOptions[]> = new Map();

    constructor(
        context: vscode.ExtensionContext,
        private _store: ConnectionStore,
        private _connector: Connector,
        private _host: IConnectionDialogHost,
        connectionToEdit?: IConnectionProfile,
        initialConnectionGroup?: IConnectionGroup,
        private _openAsNewDraft?: boolean,
    ) {
        super(
            context,
            CONNECTION_DIALOG_VIEW_ID,
            CONNECTION_DIALOG_VIEW_ID,
            new ConnectionDialogWebviewState(),
            {
                title: LocalizedConstants.ConnectionDialog.connectionDialog,
                viewColumn: vscode.ViewColumn.Active,
                iconPath: {
                    dark: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "connectionDialogEditor_dark.svg",
                    ),
                    light: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "connectionDialogEditor_light.svg",
                    ),
                },
            },
        );

        this.registerRpcHandlers();
        void this.initializeDialog(connectionToEdit, initialConnectionGroup, this._openAsNewDraft)
            .then(() => {
                this.updateState();
                this.initialized.resolve();
            })
            .catch((err) => {
                void vscode.window.showErrorMessage(getErrorMessage(err));
                this.initialized.reject(getErrorMessage(err));
            });
    }

    /** Background work (database list, initialization) may finish after the dialog is closed. */
    public override updateState(state?: ConnectionDialogWebviewState): void {
        if (!this.isDisposed) {
            super.updateState(state);
        }
    }

    //#region Initialization

    private async initializeDialog(
        connectionToEdit: IConnectionProfile | undefined,
        initialConnectionGroup?: IConnectionGroup,
        openAsNewDraft?: boolean,
    ): Promise<void> {
        // Display the initial UI first, since loading the connections may take a moment
        this.state.connectionProfile = defaultConnectionFor("mssql");
        await this.loadFormComponents("mssql");
        await this.updateItemVisibility();
        this.updateState();

        try {
            await this.updateLoadedConnections(this.state);
            this.updateState();
        } catch (err) {
            void vscode.window.showErrorMessage(getErrorMessage(err));
        }

        // Load connection (if specified); happens after form is loaded so that the form can be updated
        if (connectionToEdit) {
            try {
                await this.loadConnectionToEdit(connectionToEdit, openAsNewDraft);
            } catch (err) {
                this.loadEmptyConnection();
                void vscode.window.showErrorMessage(getErrorMessage(err));
            }
        }

        // Ensure connection group is set in precedence order:
        // 1. explicitly-specified initialConnectionGroup
        // 2. existing groupId on connection being edited
        // 3. default to root group
        if (initialConnectionGroup) {
            this.state.connectionProfile.groupId = initialConnectionGroup.id;
        } else {
            this.state.connectionProfile.groupId ??= ConnectionConfig.ROOT_GROUP_ID;
        }

        await this.updateItemVisibility();
    }

    /** Builds the form for an engine; does nothing when it is already shown. */
    private async loadFormComponents(provider: DriverId): Promise<void> {
        if (this._formProvider === provider) {
            return;
        }
        this._formProvider = provider;

        this.state.formComponents = await generateConnectionComponents(
            provider,
            this.getEntraAccountOptions(),
            Promise.resolve(this.getAzureActionButtons()),
            this.getConnectionGroupOptions(),
        );

        this.state.connectionComponents = {
            mainOptions: [...mainOptionsByProvider[provider]].filter(
                (o) => this.state.formComponents[o] !== undefined,
            ),
            groupedAdvancedOptions: [],
        };
        this.state.connectionComponents.groupedAdvancedOptions = groupAdvancedOptions(
            this.state.formComponents as Record<
                keyof IConnectionDialogProfile,
                ConnectionDialogFormItemSpec
            >,
            this.state.connectionComponents,
        );

        this._activeDbFetchKey = "";
    }

    //#endregion

    //#region Reducers

    private registerRpcHandlers() {
        this.registerReducer("loadConnectionForEdit", async (state, payload) => {
            await this.setConnectionForEdit(payload.connection as IConnectionProfile);
            return state;
        });

        this.registerReducer("loadConnectionAsNewDraft", async (state, payload) => {
            await this.setConnectionAsNewDraft(payload.connection as IConnectionProfile);
            return state;
        });

        this.registerReducer("connect", async (state) => {
            return this.submitConnectionAction(state, ConnectionSubmitAction.Connect);
        });

        this.registerReducer("testConnection", async (state) => {
            return this.submitConnectionAction(state, ConnectionSubmitAction.TestConnection);
        });

        this.registerReducer("saveWithoutConnecting", async (state) => {
            return this.submitConnectionAction(state, ConnectionSubmitAction.SaveWithoutConnecting);
        });

        this.registerReducer("retryLastSubmitAction", async (state) => {
            return this.submitConnectionAction(state, this._lastSubmittedAction);
        });

        this.registerReducer("createConnectionGroup", async (state, payload) => {
            const createConnectionGroupResult = await createConnectionGroup(
                payload.connectionGroupSpec,
                this._store.connectionConfig,
            );
            if (typeof createConnectionGroupResult === "string") {
                // If the result is a string, it means there was an error creating the group
                state.formMessage = { message: createConnectionGroupResult };
            } else {
                state.connectionProfile.groupId = createConnectionGroupResult.id;
            }

            state.formComponents.groupId.options = await this.getConnectionGroupOptions();
            state.dialog = undefined;
            return state;
        });

        this.registerReducer("openCreateConnectionGroupDialog", async (state) => {
            state.dialog = getDefaultConnectionGroupDialogProps();
            return state;
        });

        this.registerReducer("closeDialog", async (state) => {
            state.dialog = undefined;
            return state;
        });

        this.registerReducer("closeMessage", async (state) => {
            state.formMessage = undefined;
            return state;
        });

        this.registerReducer("refreshConnectionsList", async (state) => {
            await this.updateLoadedConnections(state);
            return state;
        });

        this.registerReducer("deleteSavedConnection", async (state, payload) => {
            const confirm = await vscode.window.showQuickPick(
                [LocalizedConstants.Common.delete, LocalizedConstants.Common.cancel],
                {
                    title: LocalizedConstants.Common.areYouSureYouWantTo(
                        LocalizedConstants.ConnectionDialog.deleteTheSavedConnection(
                            getConnectionDisplayName(payload.connection),
                        ),
                    ),
                },
            );

            if (confirm !== LocalizedConstants.Common.delete) {
                return state;
            }

            const profile = payload.connection as IConnectionProfile;
            await this._host.disconnectConnection(profile.id);
            if (await this._store.removeProfile(profile)) {
                await this.updateLoadedConnections(state);
            }
            return state;
        });

        this.registerReducer("removeRecentConnection", async (state, payload) => {
            await this._store.removeRecentlyUsed(payload.connection as IConnectionProfile);
            await this.updateLoadedConnections(state);
            return state;
        });

        this.registerReducer("loadFromConnectionString", async (state, payload) => {
            // Helper function to set error message in the appropriate place
            function setConnectionStringError(errorMessage: string) {
                if (state.dialog?.type === "loadFromConnectionString") {
                    (state.dialog as ConnectionStringDialogProps).connectionStringError =
                        errorMessage;
                } else {
                    state.formMessage = { message: errorMessage };
                }
            }

            try {
                // A PostgreSQL URI selects PostgreSQL whatever the current engine.
                const provider: DriverId = /^postgres(ql)?:\/\//i.test(
                    payload.connectionString.trim(),
                )
                    ? "pg"
                    : currentProvider(state.connectionProfile);
                const options = getDriver(provider).parseConnectionString(payload.connectionString);

                const current = state.connectionProfile;
                const profile = {
                    ...defaultConnectionFor(provider),
                    ...options,
                    provider,
                    profileName: current.profileName,
                    groupId: current.groupId,
                    id: current.id,
                    savePassword: current.savePassword,
                } as IConnectionDialogProfile;
                splitServerAndPort(profile);

                await this.loadFormComponents(provider);
                state.connectionProfile = profile;
                state.dialog = undefined; // Close the dialog
                await this.updateItemVisibility();
                this.triggerDatabaseFetchIfReady();
                return state;
            } catch (error) {
                this.logger.error("Error parsing connection string: " + getErrorMessage(error));
                setConnectionStringError(
                    LocalizedConstants.invalidConnectionString0(getErrorMessage(error)),
                );
                return state;
            }
        });

        this.registerReducer("openConnectionStringDialog", async (state) => {
            let connectionString = "";
            try {
                // if the current connection has no server yet, the connection string is left empty
                if (state.connectionProfile.server) {
                    const cleanedConnection = this.cleanConnection(state.connectionProfile);
                    connectionString = getDriver(
                        currentProvider(cleanedConnection),
                    ).buildConnectionString(toOptionValues(cleanedConnection), true);
                }
            } catch (error) {
                this.logger.error("Error generating connection string: " + getErrorMessage(error));
            }

            state.dialog = {
                type: "loadFromConnectionString",
                connectionString: connectionString,
            } as ConnectionStringDialogProps;
            return state;
        });

        this.onRequest(GetConnectionDisplayNameRequest.type, async (payload) => {
            return getConnectionDisplayName(payload);
        });

        this.registerReducer("messageButtonClicked", async (state, payload) => {
            this.logger.error(`Unknown message button clicked: ${payload.buttonId}`);
            return state;
        });
    }

    //#endregion

    //#region Form

    async afterSetFormProperty(
        propertyName: keyof IConnectionDialogProfile,
        isBlur: boolean,
    ): Promise<void> {
        if (propertyName === "provider") {
            await this.changeProvider(currentProvider(this.state.connectionProfile));
            return;
        }

        if (propertyName === "accountId" && this.state.connectionProfile.accountId) {
            // VS Code signs in to Microsoft accounts on its own; the account only selects which one.
            this.state.formMessage = undefined;
        }
        await this.handleAzureMFAEdits(propertyName);

        if (
            ConnectionDialogWebviewController._dbFetchTriggerProps.includes(propertyName) &&
            // Text fields: wait for blur so that typing doesn't open a connection per keystroke.
            (isBlur || !isTextField(this.state.formComponents[propertyName]))
        ) {
            this.triggerDatabaseFetchIfReady();
        }
    }

    /** Switches the form to another engine, keeping what the user typed that still applies. */
    private async changeProvider(provider: DriverId): Promise<void> {
        const previous = this.state.connectionProfile;
        await this.loadFormComponents(provider);
        this.state.connectionProfile = {
            ...defaultConnectionFor(provider),
            server: previous.server,
            user: previous.user,
            password: previous.password,
            savePassword: previous.savePassword,
            database: previous.database,
            profileName: previous.profileName,
            groupId: previous.groupId,
            id: previous.id,
        };
        await this.updateItemVisibility();
        this.triggerDatabaseFetchIfReady();
    }

    async updateItemVisibility() {
        const profile = this.state.connectionProfile;
        const hiddenProperties: (keyof IConnectionDialogProfile)[] = [];

        const authType = profile.authenticationType;
        const isPostgres = currentProvider(profile) === "pg";
        const isServicePrincipal = authType === AuthenticationType.ActiveDirectoryServicePrincipal;
        // Windows Authentication here is NTLM: the account (DOMAIN\user) and its password are typed in.
        const isWindowsAuth = authType === AuthenticationType.Integrated && !isPostgres;
        // Azure Database for PostgreSQL names Entra roles freely (a group, for instance), so the
        // user stays visible there; left empty, the account's sign-in name is used.
        const entraUserVisible = authType === AuthenticationType.AzureMFA && isPostgres;
        if (!(isPostgres && isServicePrincipal)) {
            hiddenProperties.push("clientId");
        }
        if (
            authType !== AuthenticationType.SqlLogin &&
            !isWindowsAuth &&
            authType !== AuthenticationType.ActiveDirectoryDefault &&
            !isServicePrincipal &&
            !entraUserVisible
        ) {
            hiddenProperties.push("user");
        }
        if (authType !== AuthenticationType.SqlLogin && !isWindowsAuth && !isServicePrincipal) {
            hiddenProperties.push("password", "savePassword");
        }
        const tenantComponent = this.state.formComponents["tenantId"];
        if (authType !== AuthenticationType.AzureMFA) {
            hiddenProperties.push("accountId");
            if (isServicePrincipal && tenantComponent) {
                // Microsoft's driver finds the tenant from the server; tedious must be told.
                tenantComponent.type = FormItemType.Input;
                tenantComponent.freeform = false;
            } else {
                hiddenProperties.push("tenantId");
            }
        } else {
            const tenants = await this.getEntraTenantOptions(profile.accountId);
            if (tenantComponent) {
                tenantComponent.options = tenants;
                // A list, as Microsoft shows it, when the tenants are known; otherwise (no
                // management token yet, or a tenant the list lacks) the tenant is typed in.
                const typedIn = !tenants.some((t) => t.value === profile.tenantId);
                tenantComponent.type = typedIn ? FormItemType.Combobox : FormItemType.Dropdown;
                tenantComponent.freeform = typedIn;
            }
            const tenantIsListed =
                !profile.tenantId || tenants.some((t) => t.value === profile.tenantId);
            if (
                tenants.length < 2 &&
                tenantIsListed &&
                !isPersonalMicrosoftAccount(profile.accountId)
            ) {
                hiddenProperties.push("tenantId");
            }
        }

        const userComponent = this.state.formComponents["user"];
        if (userComponent) {
            // userId is required for SQL Login and Service Principal, optional for AD Default, and hidden (above) for everything else
            userComponent.required =
                authType === AuthenticationType.SqlLogin || isWindowsAuth || isServicePrincipal;
        }
        const clientIdComponent = this.state.formComponents["clientId"];
        if (clientIdComponent) {
            clientIdComponent.required = true;
        }

        // Relabel user/password fields for Service Principal to disambiguate from SQL Login
        // (PostgreSQL keeps "User name": it is the role, and the client ID has its own field).
        const userComp = this.state.formComponents["user"];
        if (userComp) {
            // Lazily cache the original capability-sourced label/tooltip the first time we see them
            if (userComp.label && !this._originalUserLabel) {
                this._originalUserLabel = userComp.label;
            }
            if (userComp.tooltip && !this._originalUserTooltip) {
                this._originalUserTooltip = userComp.tooltip;
            }
            userComp.label =
                isServicePrincipal && !isPostgres
                    ? LocalizedConstants.ConnectionDialog.applicationClientId
                    : this._originalUserLabel;
            userComp.tooltip =
                isServicePrincipal && !isPostgres
                    ? LocalizedConstants.ConnectionDialog.applicationClientIdTooltip
                    : isWindowsAuth
                      ? LocalizedConstants.ConnectionDialog.windowsUserNameTooltip
                      : this._originalUserTooltip;
            userComp.placeholder = isWindowsAuth
                ? LocalizedConstants.ConnectionDialog.windowsUserNamePlaceholder
                : undefined;
        }
        const passwordComp = this.state.formComponents["password"];
        if (passwordComp) {
            if (passwordComp.label && !this._originalPasswordLabel) {
                this._originalPasswordLabel = passwordComp.label;
            }
            if (passwordComp.tooltip && !this._originalPasswordTooltip) {
                this._originalPasswordTooltip = passwordComp.tooltip;
            }
            passwordComp.label = isServicePrincipal
                ? LocalizedConstants.ConnectionDialog.clientSecret
                : this._originalPasswordLabel;
            passwordComp.tooltip = isServicePrincipal
                ? LocalizedConstants.ConnectionDialog.clientSecretTooltip
                : this._originalPasswordTooltip;
        }
        const savePasswordComp = this.state.formComponents["savePassword"];
        if (savePasswordComp) {
            if (savePasswordComp.label && !this._originalSavePasswordLabel) {
                this._originalSavePasswordLabel = savePasswordComp.label;
            }
            savePasswordComp.label = isServicePrincipal
                ? LocalizedConstants.ConnectionDialog.saveSecret
                : this._originalSavePasswordLabel;
        }

        for (const component of Object.values(this.state.formComponents)) {
            component.hidden = hiddenProperties.includes(component.propertyName);
        }

        await this.checkReadyToConnect();
    }

    protected getActiveFormComponents(
        state: ConnectionDialogWebviewState,
    ): (keyof IConnectionDialogProfile)[] {
        return [...state.connectionComponents.mainOptions, "groupId"];
    }

    private async checkReadyToConnect(): Promise<void> {
        const fullValidation = await this.validateForm(
            this.state.connectionProfile,
            undefined,
            false,
        );
        this.state.readyToConnect = fullValidation.length === 0;
    }

    /** Returns a copy of `connection` with the values of hidden inputs cleared. */
    private cleanConnection(connection: IConnectionDialogProfile): IConnectionDialogProfile {
        const cleanedConnection = structuredClone(connection);

        // Clear values for inputs that are hidden due to form selections
        for (const option of Object.values(this.state.formComponents)) {
            if (option.hidden) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (cleanedConnection[option.propertyName] as any) = undefined;
            }
        }

        if (cleanedConnection.secureEnclaves !== "Enabled") {
            cleanedConnection.attestationProtocol = undefined;
            cleanedConnection.enclaveAttestationUrl = undefined;
        }

        return cleanedConnection;
    }

    private clearFormError() {
        this.state.formMessage = undefined;
        for (const component of this.getActiveFormComponents(this.state).map(
            (x) => this.state.formComponents[x],
        )) {
            component.validation = undefined;
        }
    }

    //#endregion

    //#region Saved and recent connections

    private async updateLoadedConnections(state: ConnectionDialogWebviewState) {
        const all = await this._store.readAllConnections(true /* includeRecentConnections */);
        const prepare = (conns: IConnectionProfileWithSource[]) =>
            Promise.all(conns.map((c) => this.initializeConnectionForDialog(c)));

        state.savedConnections = await prepare(
            all.filter((c) => c.profileSource === CredentialsQuickPickItemType.Profile),
        );
        state.recentConnections = await prepare(
            all.filter((c) => c.profileSource === CredentialsQuickPickItemType.Mru),
        );
    }

    private async loadConnectionToEdit(
        connectionToEdit: IConnectionProfile,
        openAsNewDraft: boolean = false,
    ): Promise<void> {
        await this.setConnectionForEdit(connectionToEdit, openAsNewDraft);
        await this.handleAzureMFAEdits("accountId");
        this.updateState();
        this.triggerDatabaseFetchIfReady();
    }

    private loadEmptyConnection() {
        this.state.connectionProfile = defaultConnectionFor(this._formProvider ?? "mssql");
        this._connectionBeingEdited = undefined;
        this.state.isEditingConnection = false;
        this.state.editingConnectionDisplayName = undefined;
    }

    private async setConnectionForEdit(
        connectionToLoad: IConnectionProfile,
        openAsNewDraft: boolean = false,
    ): Promise<void> {
        this.clearFormError();
        const initializedConnection = await this.initializeConnectionForDialog(
            structuredClone(connectionToLoad),
        );

        await this.loadFormComponents(currentProvider(initializedConnection));
        this.state.connectionProfile = initializedConnection;

        if (openAsNewDraft) {
            // pre-filling the form, but not editing an existing connection
            this.state.connectionProfile.id = undefined;
            this.state.connectionProfile.groupId = undefined;
            this._connectionBeingEdited = undefined;
            this.state.isEditingConnection = false;
            this.state.editingConnectionDisplayName = undefined;
        } else {
            // editing an existing connection
            this._connectionBeingEdited = structuredClone(initializedConnection);
            this.state.isEditingConnection = true;
            this.state.editingConnectionDisplayName =
                getConnectionDisplayName(initializedConnection);
        }

        await this.updateItemVisibility();
        this.triggerDatabaseFetchIfReady();
    }

    private async setConnectionAsNewDraft(connectionToCopy: IConnectionProfile): Promise<void> {
        this.clearFormError();
        const connectionDraft = await this.initializeConnectionForDialog(
            structuredClone(connectionToCopy),
        );
        // clear properties that will be unique for a cloned connection
        connectionDraft.id = undefined;
        connectionDraft.profileName = undefined;
        delete (connectionDraft as IConnectionProfile).order;
        delete (connectionDraft as IConnectionProfileWithSource).configSource;
        delete (connectionDraft as IConnectionProfileWithSource).profileSource;

        await this.loadFormComponents(currentProvider(connectionDraft));
        this._connectionBeingEdited = undefined;
        this.state.connectionProfile = connectionDraft;
        this.state.isEditingConnection = false;
        this.state.editingConnectionDisplayName = undefined;

        await this.updateItemVisibility();
        this.triggerDatabaseFetchIfReady();
    }

    private async initializeConnectionForDialog(
        connection: IConnectionProfile,
    ): Promise<IConnectionDialogProfile> {
        // Load the password if it's saved
        if (!connection.password) {
            connection.password = (await this._store.lookupPassword(connection)) ?? "";
        }
        splitServerAndPort(connection);
        return connection as IConnectionDialogProfile;
    }

    //#endregion

    //#region Submit

    private async submitConnectionAction(
        state: ConnectionDialogWebviewState,
        action: ConnectionSubmitAction,
    ): Promise<ConnectionDialogWebviewState> {
        this._lastSubmittedAction = action;
        this.state.connectionAction = action;
        this.state.testConnectionSucceeded = false;

        const cleanedConnection = await this.prepareConnectionForSubmit(state);
        if (!cleanedConnection) {
            return state;
        }

        try {
            if (action === ConnectionSubmitAction.TestConnection) {
                if (!(await this.testConnectionStep(cleanedConnection))) {
                    return state;
                }
                this.state.connectionStatus = ApiStatus.Loaded;
                this.state.testConnectionSucceeded = true;
                this.updateState();
                return state;
            }

            if (action === ConnectionSubmitAction.Connect) {
                if (!(await this.testConnectionStep(cleanedConnection))) {
                    return state;
                }
            }

            const savedProfile = await this.saveProfileStep(cleanedConnection, state);
            if (action === ConnectionSubmitAction.Connect) {
                await this._host.revealConnection(savedProfile);
            }

            this.state.connectionStatus = ApiStatus.Loaded;
            this.updateState();
            this.panel.dispose();
            this.dispose();
        } catch (error) {
            this.state.connectionStatus = ApiStatus.Error;
            this.state.formMessage = { message: getErrorMessage(error) };
            this.updateState();
        }
        return state;
    }

    private async prepareConnectionForSubmit(
        state: ConnectionDialogWebviewState,
    ): Promise<IConnectionDialogProfile | undefined> {
        this.clearFormError();
        this.state.connectionStatus = ApiStatus.Loading;
        this.updateState();

        const cleanedConnection = this.cleanConnection(this.state.connectionProfile);
        const erroredInputs = await this.validateForm(cleanedConnection, undefined, true);

        if (erroredInputs.length > 0) {
            this.state.connectionStatus = ApiStatus.Error;
            this.updateState(state);
            this.logger.debug("One more more inputs have errors: " + erroredInputs.join(", "));
            return undefined;
        }

        return cleanedConnection;
    }

    /** Opens and closes a connection; on failure, shows the error (or the trust certificate dialog). */
    private async testConnectionStep(connection: IConnectionDialogProfile): Promise<boolean> {
        try {
            const opened = await openConnection(toStoredProfile(connection));
            await opened.close().catch(() => undefined);
            return true;
        } catch (error) {
            const message = getErrorMessage(error);
            this.state.connectionStatus = ApiStatus.Error;
            if (isUntrustedCertificateError(connection, message)) {
                // connection failing because the user didn't trust the server cert is not an error worth logging;
                // just prompt the user to trust the cert
                this.state.dialog = {
                    type: "trustServerCert",
                    message,
                } as TrustServerCertDialogProps;
            } else {
                this.state.formMessage = { message };
            }
            this.updateState();
            return false;
        }
    }

    /** Saves the profile (replacing the one being edited) and returns it as stored. */
    private async saveProfileStep(
        connection: IConnectionDialogProfile,
        state: ConnectionDialogWebviewState,
    ): Promise<IConnectionProfile> {
        const profile = toStoredProfile(connection);

        if (this._connectionBeingEdited) {
            await this._host.disconnectConnection(this._connectionBeingEdited.id);
            await this._store.removeProfile(this._connectionBeingEdited as IConnectionProfile);
            this._connectionBeingEdited = undefined;
        }

        if (profile.configSource === undefined) {
            const group = this._store.connectionConfig.getGroupById(profile.groupId);
            profile.configSource = group?.configSource;
        }

        await this._store.saveProfile(profile);
        // An unsaved password still serves until VS Code closes, like vscode-mssql.
        if (!profile.savePassword && profile.password) {
            this._connector.rememberPassword(profile.id, profile.password);
        }

        await this.updateLoadedConnections(state);
        this.updateState(state);
        return profile;
    }

    //#endregion

    //#region Database list

    private triggerDatabaseFetchIfReady() {
        if (this.isConnectionReadyForDatabaseFetch(this.state.connectionProfile)) {
            const fetchKey = this.buildDatabaseFetchKey();

            if (fetchKey !== this._activeDbFetchKey) {
                void this.loadDatabaseList();
            }
        } else if (this._activeDbFetchKey !== "") {
            const dbComponent = this.getFormComponent(this.state, "database");

            if (dbComponent) {
                dbComponent.options = [];
                dbComponent.loadStatus = undefined;
            }

            this._activeDbFetchKey = "";
            this.updateState();
        }
    }

    private isConnectionReadyForDatabaseFetch(profile: IConnectionDialogProfile): boolean {
        if (!profile.server) {
            return false;
        }

        switch (profile.authenticationType) {
            case AuthenticationType.SqlLogin:
                return !!(profile.user && profile.password);
            case AuthenticationType.Integrated:
                return currentProvider(profile) !== "pg" && !!(profile.user && profile.password);
            case AuthenticationType.AzureMFA:
                return !!profile.accountId;
            case AuthenticationType.ActiveDirectoryDefault:
                return true;
            case AuthenticationType.ActiveDirectoryServicePrincipal:
                return !!(
                    profile.user &&
                    profile.password &&
                    profile.tenantId &&
                    (currentProvider(profile) !== "pg" || profile.clientId)
                );
            default:
                return false;
        }
    }

    private buildDatabaseFetchKey(): string {
        const p = this.state.connectionProfile;
        return [
            p.provider,
            p.server,
            p.port,
            p.authenticationType,
            p.user,
            p.password,
            p.accountId,
            p.tenantId,
            p.clientId,
            p.trustServerCertificate,
            p.encrypt,
            p.sslmode,
        ]
            .map((v) => String(v ?? ""))
            .join("|");
    }

    private async loadDatabaseList(): Promise<void> {
        const counter = ++this._dbFetchCounter;
        const fetchKey = this.buildDatabaseFetchKey();
        const dbComponent = this.getFormComponent(this.state, "database");
        const provider = currentProvider(this.state.connectionProfile);

        if (!dbComponent) {
            return;
        }

        const toOptions = (dbs: string[]) => buildDatabaseOptions(dbs, systemDatabases[provider]);

        // 1. Use cached list if available
        const cached = this._databaseListCache.get(fetchKey);
        if (cached) {
            this._activeDbFetchKey = fetchKey;
            dbComponent.options = toOptions(cached);
            dbComponent.loadStatus = undefined;
            this.updateState();
            return;
        }

        // 2. Display loading state
        this._activeDbFetchKey = fetchKey;
        dbComponent.options = [];
        dbComponent.loadStatus = { status: ApiStatus.Loading };
        this.updateState();

        // 3. Attempt to fetch database list
        try {
            const profile = toStoredProfile(this.cleanConnection(this.state.connectionProfile));
            profile.database = "";
            const connection = await openConnection(profile);
            let dbs: string[];
            try {
                dbs = await connection.listDatabases();
            } finally {
                await connection.close().catch(() => undefined);
            }

            // Check if this fetch attempt is out-of-date
            if (counter !== this._dbFetchCounter) {
                return;
            }

            this._databaseListCache.set(fetchKey, dbs);
            dbComponent.options = toOptions(dbs);
            dbComponent.loadStatus = undefined;
            this.updateState();
        } catch (err) {
            if (counter !== this._dbFetchCounter) {
                return;
            }

            const message = getErrorMessage(err);
            dbComponent.loadStatus = {
                status: ApiStatus.Error,
                message: LocalizedConstants.ConnectionDialog.unableToLoadDatabaseList(
                    isUntrustedCertificateError(this.state.connectionProfile, message)
                        ? LocalizedConstants.Connection.trustServerCertificateMustBeEnabledMessage
                        : message,
                ),
            };
            this._activeDbFetchKey = "";
            this.updateState();
        }
    }

    //#endregion

    //#region Options

    private async getConnectionGroupOptions(): Promise<FormItemOptions[]> {
        let connectionGroups = await this._store.connectionConfig.getGroups();
        connectionGroups = connectionGroups.filter((g) => g.id !== ConnectionConfig.ROOT_GROUP_ID);

        // Count occurrences of group names to handle naming conflicts
        const nameOccurrences = new Map<string, number>();
        for (const group of connectionGroups) {
            nameOccurrences.set(group.name, (nameOccurrences.get(group.name) || 0) + 1);
        }

        const groupById = new Map(connectionGroups.map((g) => [g.id, g]));
        const getParentPath = (group: IConnectionGroup): string => {
            if (!group.parentId || group.parentId === ConnectionConfig.ROOT_GROUP_ID) {
                return group.name;
            }
            const parent = groupById.get(group.parentId);
            return parent ? `${getParentPath(parent)} > ${group.name}` : group.name;
        };

        const result = connectionGroups
            .map((g) => ({
                // If there are naming conflicts, use the full path
                displayName: nameOccurrences.get(g.name) > 1 ? getParentPath(g) : g.name,
                value: g.id,
                color: g.color || undefined,
            }))
            .sort((a, b) => a.displayName.localeCompare(b.displayName));

        return [
            {
                displayName: LocalizedConstants.ConnectionDialog.default,
                value: ConnectionConfig.ROOT_GROUP_ID,
            },
            {
                displayName: LocalizedConstants.ConnectionDialog.createConnectionGroup,
                value: CREATE_NEW_GROUP_ID,
            },
            ...result,
        ];
    }

    /** Microsoft accounts signed in to VS Code. */
    private async getEntraAccountOptions(): Promise<FormItemOptions[]> {
        try {
            return await getVscodeEntraAccountOptions();
        } catch (err) {
            this.logger.error(`Could not list Microsoft accounts: ${getErrorMessage(err)}`);
            return [];
        }
    }

    private async getEntraTenantOptions(accountId?: string): Promise<FormItemOptions[]> {
        if (!accountId) {
            return [];
        }
        if (!this._cachedEntraTenants.has(accountId)) {
            this._cachedEntraTenants.set(accountId, await getVscodeEntraTenantOptions(accountId));
        }
        return this._cachedEntraTenants.get(accountId) ?? [];
    }

    /**
     * Keeps the account and tenant consistent when the authentication type, the account or the
     * tenant changes, or when a connection is loaded into the form.
     */
    private async handleAzureMFAEdits(propertyName: keyof IConnectionDialogProfile) {
        const mfaComponents: (keyof IConnectionDialogProfile)[] = [
            "accountId",
            "tenantId",
            "authenticationType",
        ];
        const profile = this.state.connectionProfile;
        const accountComponent = this.getFormComponent(this.state, "accountId");
        if (
            !mfaComponents.includes(propertyName) ||
            profile.authenticationType !== AuthenticationType.AzureMFA ||
            !accountComponent
        ) {
            return;
        }

        accountComponent.options = await this.getEntraAccountOptions();

        if (profile.accountId) {
            const match =
                accountComponent.options.find((a) => a.value === profile.accountId) ??
                accountComponent.options.find((a) =>
                    areCompatibleEntraAccountIds(a.value, profile.accountId),
                );
            if (match) {
                profile.accountId = match.value;
                // Shown in connection names, as Microsoft does.
                profile.email = match.displayName;
            } else {
                const accountDisplayString = profile.email ?? profile.accountId;
                profile.accountId = undefined;
                profile.tenantId = undefined;
                this.state.formMessage = {
                    message: LocalizedConstants.Azure.accountNotFound(accountDisplayString),
                    intent: "error",
                };
            }
        } else if (propertyName === "authenticationType") {
            // Only default to first account if none is already selected
            profile.accountId = accountComponent.options[0]?.value;
            profile.email = accountComponent.options[0]?.displayName;
        }

        if (propertyName !== "tenantId" && profile.accountId) {
            const tenants = await this.getEntraTenantOptions(profile.accountId);
            // A tenant typed in by hand is kept when the account changes back and forth.
            if (
                tenants.length > 0 &&
                !tenants.some((t) => t.value === profile.tenantId) &&
                (propertyName !== "accountId" || !profile.tenantId)
            ) {
                // if expected tenantId is not in the list of tenants, use the account's home tenant
                profile.tenantId = getDefaultTenantId(
                    profile.accountId,
                    tenants.map((t) => ({ tenantId: t.value, displayName: t.displayName })),
                );
            }
        }
    }

    private getAzureActionButtons(): FormItemActionButton[] {
        return [
            {
                label: LocalizedConstants.ConnectionDialog.signIn,
                id: "azureSignIn",
                callback: async () => {
                    const existingAccountIds = new Set(
                        (await this.getEntraAccountOptions()).map((a) => a.value),
                    );
                    // A management token lets the dialog list the account's tenants (read only).
                    await vscode.authentication.getSession(
                        "microsoft",
                        ["https://management.azure.com/.default"],
                        { createIfNone: true, clearSessionPreference: true },
                    );
                    this._cachedEntraTenants.clear();

                    const accountComponent = this.state.formComponents["accountId"];
                    if (accountComponent) {
                        accountComponent.options = await this.getEntraAccountOptions();
                        const newlyAddedAccount = accountComponent.options.find(
                            (a) => !existingAccountIds.has(a.value),
                        );
                        this.state.connectionProfile.accountId =
                            newlyAddedAccount?.value ??
                            this.state.connectionProfile.accountId ??
                            accountComponent.options[0]?.value;
                    }
                    this.state.formMessage = undefined;
                    await this.handleAzureMFAEdits("accountId");
                    this.updateState();
                },
            },
        ];
    }

    //#endregion
}

const CREATE_NEW_GROUP_ID = "CREATE_NEW_GROUP";

function currentProvider(profile: { provider?: DriverId }): DriverId {
    return profile.provider ?? "mssql";
}

/** Empty profile with the engine's defaults. */
function defaultConnectionFor(provider: DriverId): IConnectionDialogProfile {
    if (provider === "mssql") {
        return { ...getDefaultConnection(), provider };
    }
    const profile = {
        provider,
        server: "",
        database: "",
        user: "",
        password: "",
    } as IConnectionDialogProfile;
    for (const option of getDriver(provider).getConnectionOptions().options) {
        if (
            option.defaultValue !== null &&
            option.defaultValue !== undefined &&
            option.name !== "port"
        ) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (profile as any)[option.name] = option.defaultValue;
        }
    }
    profile.authenticationType ??= AuthenticationType.SqlLogin;
    return profile;
}

/** SQL Server profiles are saved with "server,port"; the dialog shows the port in its own box. */
function splitServerAndPort(connection: IConnectionDialogProfile): void {
    if (currentProvider(connection) !== "mssql" || !connection.server?.includes(",")) {
        return;
    }
    const commaIndex = connection.server.indexOf(",");
    const portString = connection.server.substring(commaIndex + 1).trim();
    const parsedPort = Number(portString);
    if (portString !== "" && !isNaN(parsedPort)) {
        connection.server = connection.server.substring(0, commaIndex).trim();
        connection.port = parsedPort;
    }
}

/** Profile as written to settings: undefined/empty values removed, SQL Server port folded into the server. */
function toStoredProfile(connection: IConnectionDialogProfile): IConnectionProfile {
    const profile: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(connection)) {
        if (value !== undefined && value !== null && value !== "") {
            profile[key] = value;
        }
    }
    // Keep an empty password explicit so that it is not asked again.
    profile.password = connection.password ?? "";
    const stored = profile as unknown as IConnectionProfile;
    if (currentProvider(stored) === "mssql") {
        const port = String(stored.port ?? "").trim();
        if (port && stored.server && !stored.server.includes(",")) {
            stored.server = `${stored.server},${port}`;
        }
        stored.port = undefined;
    }
    return stored;
}

function toOptionValues(connection: IConnectionDialogProfile) {
    const options: Record<string, string | number | boolean | undefined> = {};
    for (const [key, value] of Object.entries(connection)) {
        if (typeof value !== "object") {
            options[key] = value as string | number | boolean | undefined;
        }
    }
    return options;
}

function isTextField(component: ConnectionDialogFormItemSpec | undefined): boolean {
    return component?.type === "input" || component?.type === "password";
}

/** SQL Server refusing a self-signed certificate while "Trust server certificate" is off. */
function isUntrustedCertificateError(
    connection: IConnectionDialogProfile,
    message: string,
): boolean {
    return (
        currentProvider(connection) === "mssql" &&
        !connection.trustServerCertificate &&
        /certificate/i.test(message)
    );
}

function buildDatabaseOptions(databases: string[], system: string[]): FormItemOptions[] {
    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    const isSystem = (name: string) => system.includes(name.toLowerCase());
    const sorted = [...databases].sort((a, b) => collator.compare(a, b));
    return [
        ...sorted
            .filter((d) => !isSystem(d))
            .map((d) => ({
                displayName: d,
                value: d,
                groupName: LocalizedConstants.ConnectionDialog.userDatabasesGroup,
            })),
        ...sorted.filter(isSystem).map((d) => ({
            displayName: d,
            value: d,
            groupName: LocalizedConstants.ConnectionDialog.systemDatabasesGroup,
        })),
    ];
}
