/**
 * Opens driver connections for saved connection profiles.
 *
 * The password comes from, in order: the profile itself (typed in the connection
 * dialog, or written in plain text in settings), SecretStorage when the profile
 * saves its password, then a prompt whose answer is kept in memory for the rest
 * of the VS Code session, and also saved to SecretStorage once the connection succeeds when the
 * profile saves its password.
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
    "databaseFilter",
    "color",
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
        let typedPassword: string | undefined;
        if (needsPassword(profile)) {
            const answer = await this.getPassword(profile);
            if (answer === undefined) {
                return undefined;
            }
            profile = { ...profile, password: answer.password };
            typedPassword = answer.typed ? answer.password : undefined;
        }

        try {
            const connection = await openConnection(profile);
            await this._store?.addRecentlyUsed(profile);
            await this.savePasswordAfterSuccess(profile, typedPassword);
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

    /**
     * Saves a password typed at the prompt once the connection it opened has succeeded, when the
     * saved profile asks for its password to be saved: a wrong password never gets here.
     */
    private async savePasswordAfterSuccess(
        profile: IConnectionProfile,
        typedPassword: string | undefined,
    ): Promise<void> {
        if (!typedPassword || !this._store) {
            return;
        }
        try {
            const saved = (await this._store.findSavedProfile(profile)) ?? profile;
            if (saved.savePassword && saved.id) {
                await this._store.storePassword(saved, typedPassword);
            }
        } catch {
            // The connection works; the password is asked again next session.
        }
    }

    /** `typed` is true when the user just typed the password at the prompt. */
    private async getPassword(
        profile: IConnectionProfile,
    ): Promise<{ password: string; typed: boolean } | undefined> {
        if (profile.password || profile.emptyPasswordInput) {
            return { password: profile.password ?? "", typed: false };
        }
        // A recently used entry has no password: take it from its saved profile.
        const saved = await this._store?.findSavedProfile(profile);
        if (saved?.password || saved?.emptyPasswordInput) {
            return { password: saved.password ?? "", typed: false };
        }
        const known =
            this._passwords.get(profile.id) ??
            (saved && this._passwords.get(saved.id)) ??
            (await this._store?.lookupPassword(saved ?? profile));
        if (known !== undefined) {
            return { password: known, typed: false };
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
        if (typed === undefined) {
            return undefined;
        }
        this._passwords.set(profile.id, typed);
        return { password: typed, typed: true };
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
