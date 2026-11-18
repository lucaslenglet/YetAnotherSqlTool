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
    type ConnectParams,
    type DashboardSession,
    type Driver,
    type DriverConnection,
} from "../drivers/types";
import { ConnectionStore } from "./connectionStore";
import { acquireTokenFromVscodeAccount } from "../azure/vscodeEntraMfaUtils";
import type { EnvironmentAccessRequest } from "./environmentConsent";
import {
    environmentReferenceFields,
    hasEnvironmentReferences,
    redactConnectionErrors,
    redactError,
    resolveConnectionOptions,
} from "./environmentReferences";

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
    public connect(profile: IConnectionProfile): Promise<DriverConnection | undefined> {
        return this.withPassword(profile, async (p) => {
            const connection = await this.open(p, { interactive: true });
            await this._store?.addRecentlyUsed(p);
            return connection;
        });
    }

    /**
     * Opens the server dashboard's own connection, with the password, Entra ID and environment
     * handling of `connect`. Resolves undefined when the user cancels the password prompt.
     * The connection is not added to the recently used ones: the dashboard is not a connection
     * the user picks.
     */
    public openDashboard(profile: IConnectionProfile): Promise<DashboardSession | undefined> {
        // A dashboard can fail for reasons of its own (a server without one, a statistics view
        // it cannot read): the password the Object Explorer connected with stays remembered.
        return this.withPassword(
            profile,
            (p) => openDashboardSession(p, (q) => this.allowEnvironment(q, { interactive: true })),
            true,
        );
    }

    /**
     * Gets the password of the profile when it needs one (saved, remembered or asked), then opens
     * with it. Undefined when the prompt is cancelled.
     */
    private async withPassword<T>(
        profile: IConnectionProfile,
        open: (profile: IConnectionProfile) => Promise<T>,
        /** Forget only a password typed for this opening when it fails, not one known before. */
        forgetOnlyTyped = false,
    ): Promise<T | undefined> {
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
            const opened = await open(profile);
            await this.savePasswordAfterSuccess(profile, typedPassword);
            return opened;
        } catch (error) {
            // The typed password may be the cause: ask again next time.
            if (!forgetOnlyTyped || typedPassword !== undefined) {
                this._passwords.delete(profile.id);
            }
            throw error;
        }
    }

    /**
     * Opens a connection with the profile as is (no password lookup or prompt), once the profile
     * may read the environment variables it references.
     */
    public open(
        profile: IConnectionProfile,
        request: EnvironmentAccessRequest,
    ): Promise<DriverConnection> {
        return openConnection(profile, (p) => this.allowEnvironment(p, request));
    }

    private allowEnvironment(
        profile: IConnectionProfile,
        request: EnvironmentAccessRequest,
    ): Promise<void> {
        const consent = this._store?.environmentConsent;
        return consent ? consent.ensureAllowed(profile, request) : refuseEnvironment();
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
        // A reference to environment variables is not a secret and never goes to SecretStorage.
        if (!typedPassword || !this._store || hasEnvironmentReferences(typedPassword)) {
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

/**
 * Opens a connection with the profile as is: no password lookup or prompt. `${env:NAME}`
 * references are resolved here, after `allowEnvironment`, and only the driver sees the values.
 */
export function openConnection(
    profile: IConnectionProfile,
    allowEnvironment: (profile: IConnectionProfile) => Promise<void> = refuseEnvironment,
): Promise<DriverConnection> {
    return openWithDriver(profile, allowEnvironment, (driver, params) => driver.connect(params));
}

/** `openConnection` for the connection of a server dashboard (`Driver.openDashboard`). */
export function openDashboardSession(
    profile: IConnectionProfile,
    allowEnvironment: (profile: IConnectionProfile) => Promise<void> = refuseEnvironment,
): Promise<DashboardSession> {
    return openWithDriver(profile, allowEnvironment, (driver, params) => {
        if (!driver.openDashboard) {
            throw new Error(vscode.l10n.t("{0} has no server dashboard.", driver.displayName));
        }
        return driver.openDashboard(params);
    });
}

async function openWithDriver<T extends object>(
    profile: IConnectionProfile,
    allowEnvironment: (profile: IConnectionProfile) => Promise<void>,
    open: (driver: Driver, params: ConnectParams) => Promise<T>,
): Promise<T> {
    const typed = toConnectionOptions(profile);
    if (environmentReferenceFields(typed).length > 0) {
        await allowEnvironment(profile);
    }
    // Before any network attempt: an unset variable fails here.
    const { options, redact } = resolveConnectionOptions(typed);
    if (!redact) {
        return open(getDriver(profile.provider), connectParams(profile, options));
    }
    try {
        return redactConnectionErrors(
            await open(getDriver(profile.provider), connectParams(profile, options)),
            redact,
        );
    } catch (error) {
        throw redactError(error, redact);
    }
}

function refuseEnvironment(): Promise<void> {
    return Promise.reject(
        new Error(vscode.l10n.t("Environment variables cannot be read for this connection.")),
    );
}

function connectParams(
    profile: IConnectionProfile,
    options: ConnectionOptionValues,
): ConnectParams {
    // Application scope: only the user's own settings, never a workspace's, can widen this list.
    const entraAllowedServers = vscode.workspace
        .getConfiguration(Constants.extensionName)
        .get<string[]>("entraId.allowedServers", []);
    if (options.authenticationType === Constants.azureMfa) {
        const tenantId = options.tenantId === undefined ? undefined : String(options.tenantId);
        // Asked again for every physical connection: VS Code refreshes the token when it expires.
        const getAccessToken = (scope: string) =>
            acquireTokenFromVscodeAccount(scope, profile.accountId, tenantId);
        return { options, getAccessToken, entraAllowedServers };
    }
    return { options, entraAllowedServers };
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
