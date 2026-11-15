/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql: connection options come from our drivers
// (Driver.getConnectionOptions) instead of sqltoolsservice capabilities, and a
// "provider" dropdown selects the database engine. Telemetry removed.

import * as vscode from "vscode";
import { ConnectionOption } from "vscode-mssql";
import {
    AuthenticationType,
    ConnectionComponentGroup,
    ConnectionComponentsInfo,
    ConnectionDialogFormItemSpec,
    ConnectionDialogWebviewState,
    IConnectionDialogProfile,
} from "../sharedInterfaces/connectionDialog";
import {
    FormItemActionButton,
    FormItemOptions,
    FormItemSpec,
    FormItemType,
} from "../sharedInterfaces/form";
import { Common, ConnectionDialog as Loc } from "../constants/locConstants";
import { getErrorMessage } from "../utils/utils";
import { getLogger } from "../models/logger";
import { getDriver, getDrivers } from "../drivers";
import type { DriverId } from "../drivers/types";

const logger = getLogger("ConnectionComponents");

/** Options shown on the main form (not in Advanced), in display order, per engine. */
export const mainOptionsByProvider: Record<DriverId, readonly (keyof IConnectionDialogProfile)[]> =
    {
        mssql: [
            "provider",
            "server",
            "port",
            "trustServerCertificate",
            "authenticationType",
            "user",
            "password",
            "savePassword",
            "accountId",
            "tenantId",
            "database",
            "encrypt",
        ],
        pg: [
            "provider",
            "server",
            "port",
            "authenticationType",
            "user",
            "clientId",
            "password",
            "savePassword",
            "accountId",
            "tenantId",
            "database",
            "sslmode",
        ],
    };

/** Port placeholder shown next to the server, per engine. */
const defaultPorts: Record<DriverId, string> = { mssql: "1433", pg: "5432" };

export async function generateConnectionComponents(
    provider: DriverId,
    azureAccountOptions: Promise<FormItemOptions[]>,
    azureActionButtons: Promise<FormItemActionButton[]>,
    connectionGroupOptions: Promise<FormItemOptions[]>,
): Promise<Record<keyof IConnectionDialogProfile, ConnectionDialogFormItemSpec>> {
    const providerOptions = getDriver(provider).getConnectionOptions();
    const connectionOptions: ConnectionOption[] = providerOptions.options;
    const groupNames = providerOptions.groupDisplayNames ?? {};

    const result: Record<
        keyof IConnectionDialogProfile,
        ConnectionDialogFormItemSpec
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    > = {} as any; // force empty record for intial blank state

    const _mainOptionNames = new Set<string>([
        ...mainOptionsByProvider[provider],
        "profileName",
        "groupId",
    ]);

    for (const option of connectionOptions) {
        try {
            result[option.name as keyof IConnectionDialogProfile] = {
                ...convertToFormComponent(option),
                isAdvancedOption: !_mainOptionNames.has(option.name),
                optionCategory: option.groupName,
                optionCategoryLabel: groupNames[option.groupName] ?? option.groupName,
            };
        } catch (err) {
            logger.error(
                `Error loading connection option '${option.name}': ${getErrorMessage(err)}`,
            );
        }
    }

    result["provider"] = {
        propertyName: "provider",
        label: vscode.l10n.t("Database type"),
        required: true,
        type: FormItemType.Dropdown,
        options: getDrivers().map((d) => ({ displayName: d.displayName, value: d.id })),
        isAdvancedOption: false,
    };
    if (result["port"]) {
        result["port"].placeholder = defaultPorts[provider];
    }

    await completeFormComponents(
        result,
        await azureAccountOptions,
        await azureActionButtons,
        await connectionGroupOptions,
        provider,
    );

    return result;
}

export function groupAdvancedOptions(
    components: Record<keyof IConnectionDialogProfile, ConnectionDialogFormItemSpec>,
    componentsInfo: ConnectionComponentsInfo,
): ConnectionComponentGroup[] {
    const groupMap: Map<string, ConnectionComponentGroup> = new Map([
        // initialize with display order; any that aren't pre-defined will be appended
        // these values must match the GroupName defined in SQL Tools Service.
        ["general", undefined],
        ["security", undefined],
        ["resiliency", undefined],
        ["failover", undefined],
        ["pooling", undefined],
        ["context", undefined],
    ]);

    const optionsToGroup = Object.values(components).filter(
        (c) => c.isAdvancedOption && !componentsInfo.mainOptions.includes(c.propertyName),
    );

    for (const option of optionsToGroup) {
        if (
            // new group ID or group ID hasn't been initialized yet
            !groupMap.has(option.optionCategory) ||
            groupMap.get(option.optionCategory) === undefined
        ) {
            groupMap.set(option.optionCategory, {
                groupName: option.optionCategoryLabel,
                options: [option.propertyName],
            });
        } else {
            groupMap.get(option.optionCategory).options.push(option.propertyName);
        }
    }

    // Pre-declared groups that the engine has no option for stay empty: drop them.
    return Array.from(groupMap.values()).filter((group) => group !== undefined);
}

export function convertToFormComponent(
    connOption: ConnectionOption,
): FormItemSpec<
    IConnectionDialogProfile,
    ConnectionDialogWebviewState,
    ConnectionDialogFormItemSpec
> {
    switch (connOption.valueType) {
        case "boolean":
            return {
                propertyName: connOption.name as keyof IConnectionDialogProfile,
                label: connOption.displayName,
                required: connOption.isRequired,
                type: FormItemType.Checkbox,
                tooltip: connOption.description,
            };
        case "string":
            return {
                propertyName: connOption.name as keyof IConnectionDialogProfile,
                label: connOption.displayName,
                required: connOption.isRequired,
                type: FormItemType.Input,
                tooltip: connOption.description,
            };
        case "password":
            return {
                propertyName: connOption.name as keyof IConnectionDialogProfile,
                label: connOption.displayName,
                required: connOption.isRequired,
                type: FormItemType.Password,
                tooltip: connOption.description,
            };

        case "number":
            return {
                propertyName: connOption.name as keyof IConnectionDialogProfile,
                label: connOption.displayName,
                required: connOption.isRequired,
                type: FormItemType.Input,
                tooltip: connOption.description,
            };
        case "category":
            return {
                propertyName: connOption.name as keyof IConnectionDialogProfile,
                label: connOption.displayName,
                required: connOption.isRequired,
                type: FormItemType.Dropdown,
                tooltip: connOption.description,
                options: connOption.categoryValues.map((v) => {
                    return {
                        displayName: v.displayName ?? v.name, // Use name if displayName is not provided
                        value: v.name,
                    };
                }),
            };
        default:
            throw new Error(`Unhandled connection option type: ${connOption.valueType}`);
    }
}

export async function completeFormComponents(
    components: Partial<Record<keyof IConnectionDialogProfile, ConnectionDialogFormItemSpec>>,
    azureAccountOptions: FormItemOptions[],
    azureActionButtons: FormItemActionButton[],
    connectionGroupOptions: FormItemOptions[],
    provider: DriverId = "mssql",
) {
    // Add additional components that are not part of the connection options
    components["profileName"] = {
        propertyName: "profileName",
        label: Loc.profileName,
        required: false,
        type: FormItemType.Input,
        isAdvancedOption: false,
    };

    components["groupId"] = getGroupIdFormItem(
        connectionGroupOptions,
    ) as ConnectionDialogFormItemSpec;

    components["databaseFilter"] = {
        propertyName: "databaseFilter",
        label: Loc.databaseFilter,
        required: false,
        type: FormItemType.Input,
        placeholder: Loc.databaseFilterPlaceholder,
        tooltip: Loc.databaseFilterTooltip,
        isAdvancedOption: false,
    };

    components["savePassword"] = {
        propertyName: "savePassword",
        label: Loc.savePassword,
        required: false,
        type: FormItemType.Checkbox,
        isAdvancedOption: false,
    };

    components["accountId"] = {
        propertyName: "accountId",
        label: Loc.microsoftAccount,
        required: true,
        type: FormItemType.Dropdown,
        options: azureAccountOptions,
        placeholder: Loc.selectAnAccount,
        actionButtons: azureActionButtons,
        validate: (state: ConnectionDialogWebviewState, value: string) => {
            if (
                state.connectionProfile.authenticationType === AuthenticationType.AzureMFA &&
                !value
            ) {
                return {
                    isValid: false,
                    validationMessage: Loc.microsoftAccountIsRequired,
                };
            }
            return {
                isValid: true,
                validationMessage: "",
            };
        },
        isAdvancedOption: false,
    };

    components["tenantId"] = {
        propertyName: "tenantId",
        label: Loc.tenantId,
        required: true,
        // Becomes a free text field when the tenant list is unknown (see updateItemVisibility).
        type: FormItemType.Dropdown,
        options: [],
        hidden: true,
        placeholder: Loc.selectATenant,
        validate: (state: ConnectionDialogWebviewState, value: string) => {
            if (
                (state.connectionProfile.authenticationType === AuthenticationType.AzureMFA ||
                    state.connectionProfile.authenticationType ===
                        AuthenticationType.ActiveDirectoryServicePrincipal) &&
                !value
            ) {
                return {
                    isValid: false,
                    validationMessage: Loc.tenantIdIsRequired,
                };
            }
            return {
                isValid: true,
                validationMessage: "",
            };
        },
        isAdvancedOption: false,
    };

    components["connectionString"] = {
        type: FormItemType.TextArea,
        propertyName: "connectionString",
        label: Loc.connectionString,
        required: true,
        isAdvancedOption: false,
    };

    // add info tooltips to Entra auth type options
    if (components["authenticationType"]?.options) {
        for (const option of components["authenticationType"]?.options) {
            if (option.value === AuthenticationType.ActiveDirectoryDefault) {
                option.infoTooltip = Loc.entraDefaultAuthTooltip;
            } else if (option.value === AuthenticationType.AzureMFA) {
                option.infoTooltip = Loc.entraMfaAuthTooltip;
            } else if (option.value === AuthenticationType.ActiveDirectoryServicePrincipal) {
                // Microsoft's text says the client ID goes in the user name, which PostgreSQL keeps for the role.
                option.infoTooltip =
                    provider === "pg"
                        ? vscode.l10n.t(
                              "Authenticate using a Microsoft Entra service principal: enter its Application (client) ID, its client secret, and the PostgreSQL role created for it as the user name.",
                          )
                        : Loc.entraServicePrincipalAuthTooltip;
            } else if (option.value === AuthenticationType.Integrated && provider !== "pg") {
                // Ours is NTLM with a typed account, not Kerberos or the current session.
                option.infoTooltip = Loc.windowsAuthTooltip;
            }
        }
    }

    // add missing validation functions for generated components
    if (components["database"]) {
        components["database"] = {
            ...components["database"],
            type: FormItemType.Combobox,
            options: [],
            freeform: true, // allow users to enter a database that isn't populated automatically (e.g. user doesn't have LIST permission)
            placeholder: Loc.selectDatabase,
        };
    }

    components["server"].validate = (state: ConnectionDialogWebviewState, value: string) => {
        if (!value) {
            return {
                isValid: false,
                validationMessage: Loc.serverIsRequired,
            };
        }
        return {
            isValid: true,
            validationMessage: "",
        };
    };

    if (components["port"]) {
        components["port"].validate = (_state: ConnectionDialogWebviewState, value) => {
            const portValue = String(value ?? "").trim();
            const port = Number(portValue);
            const isValid =
                portValue.length === 0 || (Number.isInteger(port) && port >= 1 && port <= 65535);

            return {
                isValid,
                validationMessage: isValid ? "" : Common.invalidPort,
            };
        };
    }

    components["user"].validate = (state: ConnectionDialogWebviewState, value: string) => {
        if (
            (state.connectionProfile.authenticationType === AuthenticationType.SqlLogin ||
                (state.connectionProfile.authenticationType === AuthenticationType.Integrated &&
                    state.connectionProfile.provider !== "pg") ||
                state.connectionProfile.authenticationType ===
                    AuthenticationType.ActiveDirectoryServicePrincipal) &&
            !value
        ) {
            return {
                isValid: false,
                validationMessage:
                    state.connectionProfile.authenticationType === AuthenticationType.Integrated
                        ? Loc.windowsUserNameIsRequired
                        : state.connectionProfile.authenticationType ===
                                AuthenticationType.ActiveDirectoryServicePrincipal &&
                            state.connectionProfile.provider !== "pg"
                          ? Loc.applicationClientIdIsRequired
                          : Loc.usernameIsRequired,
            };
        }
        return {
            isValid: true,
            validationMessage: "",
        };
    };

    if (components["clientId"]) {
        components["clientId"].validate = (state: ConnectionDialogWebviewState, value: string) => {
            const isValid =
                state.connectionProfile.authenticationType !==
                    AuthenticationType.ActiveDirectoryServicePrincipal || !!value;
            return {
                isValid,
                validationMessage: isValid ? "" : Loc.applicationClientIdIsRequired,
            };
        };
    }

    if (components["password"]) {
        components["password"].validate = (state: ConnectionDialogWebviewState, value: string) => {
            if (
                state.connectionProfile.authenticationType ===
                    AuthenticationType.ActiveDirectoryServicePrincipal &&
                !value &&
                !state.connectionProfile.emptyPasswordInput
            ) {
                return {
                    isValid: false,
                    validationMessage: Loc.clientSecretIsRequired,
                };
            }
            return {
                isValid: true,
                validationMessage: "",
            };
        };
    }
}

export function getGroupIdFormItem(connectionGroupOptions: FormItemOptions[]) {
    return {
        propertyName: "groupId",
        label: Loc.connectionGroup,
        required: false,
        type: FormItemType.SearchableDropdown,
        options: connectionGroupOptions,
        isAdvancedOption: false,
        placeholder: Loc.selectConnectionGroup,
        searchBoxPlaceholder: Loc.searchConnectionGroups,
    };
}
