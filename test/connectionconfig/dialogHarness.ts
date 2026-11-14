import { afterEach, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
    ConnectionDialogWebviewController,
    IConnectionDialogHost,
} from "../../src/connectionconfig/connectionDialogWebviewController";
import { ConnectionConfig, IConnectionConfig } from "../../src/connectionconfig/connectionconfig";
import { ConnectionStore } from "../../src/connections/connectionStore";
import { Connector } from "../../src/connections/connector";
import { IConnectionGroup, IConnectionProfile } from "../../src/models/interfaces";
import {
    ConnectionDialogWebviewState,
    IConnectionDialogProfile,
} from "../../src/sharedInterfaces/connectionDialog";

// Shared by connectionDialog.test.ts (no database) and connectionDialog.integration.test.ts:
// a connection dialog controller without a webview, over in-memory settings and secrets.

/** Settings-backed ConnectionConfig, kept in memory. */
class MemoryConnectionConfig {
    groups: IConnectionGroup[] = [
        {
            id: ConnectionConfig.ROOT_GROUP_ID,
            name: ConnectionConfig.ROOT_GROUP_ID,
        } as IConnectionGroup,
    ];
    connections: IConnectionProfile[] = [];

    async getGroups() {
        return this.groups;
    }
    getGroupById(id: string) {
        return this.groups.find((g) => g.id === id);
    }
    async getConnections() {
        return this.connections.map((c) => ({ ...c }));
    }
    populateMissingConnectionMetadata(profile: IConnectionProfile) {
        profile.groupId ??= ConnectionConfig.ROOT_GROUP_ID;
        profile.id ??= `id-${this.connections.length + 1}`;
        return true;
    }
    async addConnection(profile: IConnectionProfile) {
        this.connections = [...this.connections.filter((c) => c.id !== profile.id), { ...profile }];
    }
    async removeConnection(profile: IConnectionProfile) {
        const before = this.connections.length;
        this.connections = this.connections.filter((c) => c.id !== profile.id);
        return this.connections.length < before;
    }
    async addGroup(group: IConnectionGroup) {
        this.groups.push(group);
    }
}

class MemorySecrets {
    values = new Map<string, string>();
    async get(key: string) {
        return this.values.get(key);
    }
    async store(key: string, value: string) {
        this.values.set(key, value);
    }
    async delete(key: string) {
        this.values.delete(key);
    }
}

class MemoryMemento {
    values = new Map<string, unknown>();
    get<T>(key: string) {
        return this.values.get(key) as T;
    }
    async update(key: string, value: unknown) {
        this.values.set(key, value);
    }
}

const context = {
    extensionUri: vscode.Uri.file("/ext"),
    extensionPath: "/ext",
    subscriptions: [],
} as unknown as vscode.ExtensionContext;

/**
 * Call it at the top of a test file: every test then starts with empty settings and secrets
 * (`config`, `secrets`, `store`, `host`), and the dialog a test opens is disposed after it.
 */
export function setupDialog() {
    const harness = {
        config: undefined as MemoryConnectionConfig,
        secrets: undefined as MemorySecrets,
        store: undefined as ConnectionStore,
        host: undefined as IConnectionDialogHost & { revealed: IConnectionProfile[] },
        dialog: undefined as ConnectionDialogWebviewController,
        openDialog,
        state: (): ConnectionDialogWebviewState => harness.dialog.state,
        dispatch,
        setField,
        waitFor,
    };

    beforeEach(() => {
        harness.config = new MemoryConnectionConfig();
        harness.secrets = new MemorySecrets();
        harness.store = new ConnectionStore(
            harness.config as unknown as IConnectionConfig,
            harness.secrets as unknown as vscode.SecretStorage,
            new MemoryMemento() as unknown as vscode.Memento,
        );
        const revealed: IConnectionProfile[] = [];
        harness.host = {
            revealed,
            revealConnection: async (p) => void revealed.push(p),
            disconnectConnection: async () => undefined,
        };
    });

    afterEach(() => {
        if (!harness.dialog?.isDisposed) harness.dialog?.dispose();
    });

    async function openDialog(connectionToEdit?: IConnectionProfile) {
        const dialog = new ConnectionDialogWebviewController(
            context,
            harness.store,
            new Connector(harness.store),
            harness.host,
            connectionToEdit,
        );
        harness.dialog = dialog;
        // No real webview here: say it is ready, as the page would.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dialog as any).markWebviewReady();
        await dialog.initialized;
        return dialog;
    }

    /** Calls a reducer the way the webview does. */
    async function dispatch(type: string, payload: unknown = {}) {
        const dialog = harness.dialog;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reducer = (dialog as any)._reducerHandlers.get(type);
        const next = await reducer(dialog.state, payload);
        // A submit that succeeds closes the dialog; there is no page left to update then.
        if (!dialog.isDisposed) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (dialog as any).state = next;
        }
    }

    /** Sets a form field, as when the user types and leaves the field. */
    async function setField(propertyName: keyof IConnectionDialogProfile, value: unknown) {
        await dispatch("formAction", {
            event: { propertyName, value, isAction: false, updateValidation: true },
        });
    }

    async function waitFor(condition: () => boolean, what: string) {
        const deadline = Date.now() + 20000;
        while (!condition()) {
            if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
            await new Promise((r) => setTimeout(r, 20));
        }
    }

    return harness;
}
