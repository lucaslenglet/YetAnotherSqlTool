/**
 * Opens driver connections for saved connection profiles.
 *
 * The password comes from, in order: the profile itself (typed in the connection
 * dialog, or written in plain text in settings), SecretStorage when the profile
 * saves its password, then a prompt whose answer is kept in memory for the rest
 * of the VS Code session.
 */

import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import { getConnectionDisplayName } from "../models/connectionInfo";
import { IConnectionProfile } from "../models/interfaces";
import { getDriver } from "../drivers";
import {
    AuthenticationType,
    type ConnectionOptionValues,
    type DriverConnection,
} from "../drivers/types";
import { ConnectionStore } from "./connectionStore";
import { acquireTokenFromVscodeAccount } from "../azure/vscodeEntraMfaUtils";

/** Profile fields that describe the profile itself rather than how to connect. */
const profileOnlyKeys = new Set([
    "id",
    "groupId",
    "profileName",
    "provider",
    "savePassword",
    "emptyPasswordInput",
    "azureAuthType",
    "accountId",
    "accountStore",
    "configSource",
    "order",
    "connectionString",
    "containerName",
]);

export class Connector {
    /** Passwords typed by the user, by profile id. */
    private readonly _passwords = new Map<string, string>();

    constructor(private readonly _store?: ConnectionStore) {}

    /**
     * Connects with the given profile. Returns undefined when the user cancels the
     * password prompt. Rejects with the driver's error when the connection fails.
     */
    public async connect(profile: IConnectionProfile): Promise<DriverConnection | undefined> {
        if (needsPassword(profile)) {
            const password = await this.getPassword(profile);
            if (password === undefined) {
                return undefined;
            }
            profile = { ...profile, password };
        }

        try {
            const connection = await openConnection(profile);
            await this._store?.addRecentlyUsed(profile);
            return connection;
        } catch (error) {
            // The typed password may be the cause: ask again next time.
            this._passwords.delete(profile.id);
            throw error;
        }
    }

    /** Keeps a password for this VS Code session (profiles that don't save their password). */
    public rememberPassword(profileId: string, password: string): void {
        this._passwords.set(profileId, password);
    }

    private async getPassword(profile: IConnectionProfile): Promise<string | undefined> {
        if (profile.password || profile.emptyPasswordInput) {
            return profile.password ?? "";
        }
        // A recently used entry has no password: take it from its saved profile.
        const saved = await this._store?.findSavedProfile(profile);
        if (saved?.password || saved?.emptyPasswordInput) {
            return saved.password ?? "";
        }
        const known =
            this._passwords.get(profile.id) ??
            (saved && this._passwords.get(saved.id)) ??
            (await this._store?.lookupPassword(saved ?? profile));
        if (known !== undefined) {
            return known;
        }
        const typed = await vscode.window.showInputBox({
            title: getConnectionDisplayName(profile),
            prompt:
                profile.authenticationType === AuthenticationType.ActiveDirectoryServicePrincipal
                    ? vscode.l10n.t("Client secret for {0}", profile.user ?? "")
                    : vscode.l10n.t("Password for {0}", profile.user ?? ""),
            password: true,
            ignoreFocusOut: true,
        });
        if (typed !== undefined) {
            this._passwords.set(profile.id, typed);
        }
        return typed;
    }
}

/** SQL logins, Windows accounts (NTLM) and service principals (their secret) need a password; other methods don't. */
function needsPassword(profile: IConnectionProfile): boolean {
    return (
        (profile.authenticationType ?? AuthenticationType.SqlLogin) ===
            AuthenticationType.SqlLogin ||
        profile.authenticationType === AuthenticationType.Integrated ||
        profile.authenticationType === AuthenticationType.ActiveDirectoryServicePrincipal
    );
}

/** Opens a connection with the profile as is: no password lookup or prompt. */
export function openConnection(profile: IConnectionProfile): Promise<DriverConnection> {
    const options = toConnectionOptions(profile);
    // Application scope: only the user's own settings, never a workspace's, can widen this list.
    const entraAllowedServers = vscode.workspace
        .getConfiguration(Constants.extensionName)
        .get<string[]>("entraId.allowedServers", []);
    if (profile.authenticationType === Constants.azureMfa) {
        // Asked again for every physical connection: VS Code refreshes the token when it expires.
        const getAccessToken = (scope: string) =>
            acquireTokenFromVscodeAccount(scope, profile.accountId, profile.tenantId);
        return getDriver(profile.provider).connect({
            options,
            getAccessToken,
            entraAllowedServers,
        });
    }
    return getDriver(profile.provider).connect({ options, entraAllowedServers });
}

export function toConnectionOptions(profile: IConnectionProfile): ConnectionOptionValues {
    const options: ConnectionOptionValues = {};
    for (const [key, value] of Object.entries(profile)) {
        if (profileOnlyKeys.has(key) || typeof value === "object" || typeof value === "function") {
            continue;
        }
        options[key] = value as string | number | boolean | undefined;
    }
    return options;
}
