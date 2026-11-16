/**
 * Who may read the environment through `${env:NAME}` references.
 *
 * A cloned repository can define a connection to its own server with `${env:SOME_SECRET}` in a
 * field, and would receive that secret. So references resolve directly only in a profile of the
 * user's own settings, or typed by the user in the connection dialog. Any other profile (from
 * the workspace settings, a recently used entry whose profile is gone or is not the user's...)
 * resolves only after a modal confirmation, remembered for that exact combination of engine,
 * server, port, authentication, transport security and fields holding references: a repository
 * that later changes one of them is asked about again. A refusal is not remembered.
 */

import * as vscode from "vscode";
import { getConnectionDisplayName } from "../models/connectionInfo";
import { IConnectionProfile } from "../models/interfaces";
import type { IConnectionConfig } from "../connectionconfig/connectionconfig";
import { environmentReferenceFields, referencedVariables } from "./environmentReferences";
import { toConnectionOptions } from "./connector";

const ALLOWED_KEY = "yast.environmentReferences.allowed";
/** Oldest allowed combinations are forgotten beyond this count. */
const MAX_ALLOWED = 200;

export interface EnvironmentAccessRequest {
    /** False for connections the user did not ask for (the dialog's database list): never prompt. */
    interactive: boolean;
    /**
     * Connection dialog only: the profile the form was loaded from, or null for a form the user
     * filled in. References are the user's when typed, or loaded from one of their own profiles.
     */
    formLoadedFrom?: IConnectionProfile | null;
}

export class EnvironmentConsent {
    /** Confirmations being shown, by combination: concurrent connections share one. */
    private readonly _pending = new Map<string, Promise<boolean>>();

    constructor(
        private readonly _globalState: vscode.Memento,
        private readonly _connectionConfig: Pick<IConnectionConfig, "getConnections">,
    ) {}

    /** Resolves when the profile may read the variables it references; rejects otherwise. */
    public async ensureAllowed(
        profile: IConnectionProfile,
        request: EnvironmentAccessRequest,
    ): Promise<void> {
        const fields = environmentReferenceFields(toConnectionOptions(profile));
        if (fields.length === 0) {
            return;
        }
        const key = combinationKey(profile, fields);
        if (request.formLoadedFrom !== undefined) {
            if (
                request.formLoadedFrom === null ||
                (await this.isUserProfile(request.formLoadedFrom))
            ) {
                // Typed by the user: the same combination saved in the workspace needs no question.
                // Only a Test Connection or Connect counts, not the database list fetched on blur.
                if (request.interactive) {
                    await this.remember(key);
                }
                return;
            }
        } else if (await this.isUserProfile(profile)) {
            return;
        }
        if (this.allowed().includes(key)) {
            return;
        }
        const name = getConnectionDisplayName(profile);
        if (!request.interactive) {
            throw new Error(
                vscode.l10n.t(
                    'The connection "{0}" reads environment variables: allow it first with Test Connection or Connect.',
                    name,
                ),
            );
        }
        let pending = this._pending.get(key);
        if (!pending) {
            pending = this.ask(profile, fields, key).finally(() => this._pending.delete(key));
            this._pending.set(key, pending);
        }
        if (!(await pending)) {
            throw new Error(
                vscode.l10n.t(
                    'Reading environment variables was not allowed for the connection "{0}".',
                    name,
                ),
            );
        }
    }

    /**
     * True when the user's settings hold a profile with the same id, engine, server, port,
     * authentication and transport security, and the same text in every field of `profile` that holds a reference.
     * Workspace profiles that reuse a user profile's id are dropped by ConnectionConfig.
     */
    private async isUserProfile(profile: IConnectionProfile): Promise<boolean> {
        if (!profile.id) {
            return false;
        }
        const saved = (await this._connectionConfig.getConnections()).find(
            (c) => c.id === profile.id && c.configSource === vscode.ConfigurationTarget.Global,
        );
        if (!saved || destinationOf(saved) !== destinationOf(profile)) {
            return false;
        }
        const savedOptions = toConnectionOptions(saved);
        return environmentReferenceFields(toConnectionOptions(profile)).every(
            ([field, text]) => savedOptions[field] === text,
        );
    }

    private allowed(): string[] {
        return this._globalState.get<string[]>(ALLOWED_KEY) ?? [];
    }

    private async remember(key: string): Promise<void> {
        const others = this.allowed().filter((k) => k !== key);
        await this._globalState.update(ALLOWED_KEY, [key, ...others].slice(0, MAX_ALLOWED));
    }

    private async ask(
        profile: IConnectionProfile,
        fields: [string, string][],
        key: string,
    ): Promise<boolean> {
        const variables = [...new Set(fields.flatMap(([, text]) => referencedVariables(text)))];
        const server = profile.port
            ? `${profile.server ?? ""}:${profile.port}`
            : String(profile.server ?? "");
        const lines = [
            vscode.l10n.t(
                "This connection, as it is being opened, is not one saved in your user settings (it may come from the workspace settings or from the recent connections). If you allow it, the values of these environment variables are sent to its server.",
            ),
            "",
            vscode.l10n.t("Server: {0}", server),
            vscode.l10n.t("Variables: {0}", variables.join(", ")),
        ];
        if (referencedVariables(profile.server).length > 0) {
            lines.push(vscode.l10n.t("The server name itself comes from an environment variable."));
        }
        const allow = vscode.l10n.t("Allow");
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                'Allow the connection "{0}" to read environment variables?',
                getConnectionDisplayName(profile),
            ),
            { modal: true, detail: lines.join("\n") },
            allow,
        );
        if (choice !== allow) {
            return false;
        }
        await this.remember(key);
        return true;
    }
}

/** Options that protect a connection's traffic: turning one off could expose the values sent. */
const transportOptions = [
    "encrypt",
    "trustServerCertificate",
    "hostNameInCertificate",
    "sslmode",
    "sslrootcert",
];

/** Where the connection goes, how it signs in and how its traffic is protected. */
function destinationOf(profile: IConnectionProfile): string {
    const options = toConnectionOptions(profile);
    return JSON.stringify([
        profile.provider ?? "mssql",
        profile.server ?? "",
        String(profile.port ?? ""),
        profile.authenticationType ?? "",
        ...transportOptions.map((option) => String(options[option] ?? "")),
    ]);
}

function combinationKey(profile: IConnectionProfile, fields: [string, string][]): string {
    const references = [...fields].sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([destinationOf(profile), references]);
}
