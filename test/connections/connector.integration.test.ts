import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConnectionStore } from "../../src/connections/connectionStore";
import { Connector } from "../../src/connections/connector";
import type { IConnectionConfig } from "../../src/connectionconfig/connectionconfig";
import type { IConnectionProfile } from "../../src/models/interfaces";
import { dockerOptions } from "../drivers/mssql/helpers";

class MemoryMemento {
    values = new Map<string, unknown>();
    get<T>(key: string) {
        return this.values.get(key) as T;
    }
    async update(key: string, value: unknown) {
        this.values.set(key, value);
    }
}

const secrets = {
    values: new Map<string, string>(),
    async get(key: string) {
        return this.values.get(key);
    },
    async store(key: string, value: string) {
        this.values.set(key, value);
    },
    async delete(key: string) {
        this.values.delete(key);
    },
};

describe("Connector", () => {
    it("takes the password of the saved profile when connecting with a recently used entry", async () => {
        // A profile with its password written in settings, like dev-workspace's.
        const saved = {
            id: "dev-mssql",
            provider: "mssql",
            ...dockerOptions(),
        } as unknown as IConnectionProfile;
        const config = {
            getConnections: async () => [{ ...saved }],
        } as unknown as IConnectionConfig;
        const store = new ConnectionStore(config, secrets as never, new MemoryMemento() as never);
        const connector = new Connector(store);

        await (await connector.connect(saved))!.close();
        const [recent] = store.getRecentlyUsedConnections();
        expect(recent.password).toBe("");

        const prompt = vi.mocked(vscode.window.showInputBox);
        prompt.mockClear();
        const connection = await connector.connect(recent);
        expect(connection).toBeDefined();
        expect(prompt).not.toHaveBeenCalled();
        await connection!.close();
    });
});
