/**
 * Saved connections, their passwords and the recently used list.
 *
 * Follows vscode-mssql's ConnectionStore: profiles live in settings (through
 * ConnectionConfig) without their password; a password is kept in VS Code's
 * SecretStorage when the profile's "Save Password" is checked; the recently used
 * connections are kept in globalState, without passwords.
 */

import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import { IConnectionConfig } from "../connectionconfig/connectionconfig";
import { IConnectionProfile, IConnectionProfileWithSource } from "../models/interfaces";
import { CredentialsQuickPickItemType } from "../models/interfaces";

const RECENT_CONNECTIONS_KEY = `${Constants.extensionName}.${Constants.configRecentConnections}`;
const DEFAULT_MAX_RECENT_CONNECTIONS = 5;

export class ConnectionStore {
    constructor(
        public readonly connectionConfig: IConnectionConfig,
        private readonly _secrets: vscode.SecretStorage,
        private readonly _globalState: vscode.Memento,
    ) {}

    // -- passwords --------------------------------------------------------

    private static credentialId(profile: IConnectionProfile): string {
        return `${Constants.extensionName}:profile:${profile.id}`;
    }

    /** Saved password of a profile; undefined when none is saved. */
    public async lookupPassword(profile: IConnectionProfile): Promise<string | undefined> {
        if (!profile.id || !profile.savePassword) {
            return undefined;
        }
        return this._secrets.get(ConnectionStore.credentialId(profile));
    }

    private async savePassword(profile: IConnectionProfile, password: string | undefined) {
        const key = ConnectionStore.credentialId(profile);
        if (profile.savePassword && password) {
            await this._secrets.store(key, password);
        } else {
            await this._secrets.delete(key);
        }
    }

    // -- saved profiles -------------------------------------------------------

    /**
     * Saves a profile to settings (without its password) and its password to SecretStorage
     * when requested. Assigns id, group and config source when missing.
     */
    public async saveProfile(profile: IConnectionProfile): Promise<IConnectionProfile> {
        this.connectionConfig.populateMissingConnectionMetadata(profile);
        const password = profile.password;
        await this.connectionConfig.addConnection({ ...profile, password: "" });
        await this.savePassword(profile, password);
        return profile;
    }

    /** Removes a profile from settings, the recently used list and SecretStorage. */
    public async removeProfile(profile: IConnectionProfile): Promise<boolean> {
        const found = await this.connectionConfig.removeConnection(profile);
        if (found) {
            await this.removeRecentlyUsed(profile);
            await this._secrets.delete(ConnectionStore.credentialId(profile));
        }
        return found;
    }

    /** Saved profiles followed by recently used connections, each tagged with its source. */
    public async readAllConnections(
        includeRecentConnections = false,
    ): Promise<IConnectionProfileWithSource[]> {
        const saved = (await this.connectionConfig.getConnections()).map(
            (c) =>
                ({
                    ...c,
                    profileSource: CredentialsQuickPickItemType.Profile,
                }) as IConnectionProfileWithSource,
        );
        if (!includeRecentConnections) {
            return saved;
        }
        const recent = this.getRecentlyUsedConnections().map(
            (c) =>
                ({
                    ...c,
                    profileSource: CredentialsQuickPickItemType.Mru,
                }) as IConnectionProfileWithSource,
        );
        return [...saved, ...recent];
    }

    /**
     * The saved profile a connection comes from: same id, else same engine, server,
     * database, login and authentication. Recently used entries are kept without
     * their password, so connecting with one must go through its saved profile.
     */
    public async findSavedProfile(
        profile: IConnectionProfile,
    ): Promise<IConnectionProfile | undefined> {
        const saved = await this.connectionConfig.getConnections();
        return (
            (profile.id ? saved.find((c) => c.id === profile.id) : undefined) ??
            saved.find((c) =>
                isSameRecentEntry({ ...c, profileName: profile.profileName }, profile),
            )
        );
    }

    // -- recently used --------------------------------------------------------

    public getMaxRecentConnectionsCount(): number {
        const max = vscode.workspace
            .getConfiguration(Constants.extensionName)
            .get<number>(Constants.configMaxRecentConnections, DEFAULT_MAX_RECENT_CONNECTIONS);
        return max >= 0 ? max : DEFAULT_MAX_RECENT_CONNECTIONS;
    }

    public getRecentlyUsedConnections(): IConnectionProfile[] {
        const all = this._globalState.get<IConnectionProfile[]>(RECENT_CONNECTIONS_KEY) ?? [];
        return all.slice(0, this.getMaxRecentConnectionsCount());
    }

    /** Puts a connection at the top of the recently used list (without its password). */
    public async addRecentlyUsed(profile: IConnectionProfile): Promise<void> {
        const entries = this.getRecentlyUsedConnections().filter(
            (c) => !isSameRecentEntry(c, profile),
        );
        entries.unshift(stripForRecent(profile));
        await this._globalState.update(
            RECENT_CONNECTIONS_KEY,
            entries.slice(0, this.getMaxRecentConnectionsCount()),
        );
    }

    public async removeRecentlyUsed(profile: IConnectionProfile): Promise<void> {
        const entries = this.getRecentlyUsedConnections().filter(
            (c) => !isSameRecentEntry(c, profile),
        );
        await this._globalState.update(RECENT_CONNECTIONS_KEY, entries);
    }
}

function stripForRecent(profile: IConnectionProfile): IConnectionProfile {
    const entry = { ...profile, password: "" } as IConnectionProfile & {
        profileSource?: unknown;
    };
    delete entry.profileSource;
    delete entry.configSource;
    return entry;
}

/** Same engine, server, database, login and authentication. */
function isSameRecentEntry(a: IConnectionProfile, b: IConnectionProfile): boolean {
    return (
        (a.provider ?? "mssql") === (b.provider ?? "mssql") &&
        a.server === b.server &&
        (a.port ?? "") === (b.port ?? "") &&
        (a.database ?? "") === (b.database ?? "") &&
        (a.authenticationType ?? "") === (b.authenticationType ?? "") &&
        (a.user ?? "") === (b.user ?? "") &&
        (a.accountId ?? "") === (b.accountId ?? "") &&
        (a.tenantId ?? "") === (b.tenantId ?? "") &&
        (a.profileName ?? "") === (b.profileName ?? "")
    );
}
