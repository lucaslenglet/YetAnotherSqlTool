import { createServer, type Server, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { ConnectionStore } from "../../src/connections/connectionStore";
import { Connector } from "../../src/connections/connector";
import type { IConnectionConfig } from "../../src/connectionconfig/connectionconfig";
import type { IConnectionProfile } from "../../src/models/interfaces";
import { mssqlOptions, pgOptions } from "../support/databases";

// A password given as `${env:NAME}`, against the real servers.

const VARIABLE = "YAST_IT_ENV_PASSWORD";

class MemoryMemento {
    values = new Map<string, unknown>();
    get<T>(key: string) {
        return this.values.get(key) as T;
    }
    async update(key: string, value: unknown) {
        this.values.set(key, value);
    }
}

/** A connector whose store holds `profile` in the user's settings. */
function connectorFor(profile: IConnectionProfile): Connector {
    const config = {
        getConnections: async () => [
            { ...profile, configSource: vscode.ConfigurationTarget.Global },
        ],
    } as unknown as IConnectionConfig;
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    return new Connector(
        new ConnectionStore(
            config,
            secrets as unknown as vscode.SecretStorage,
            new MemoryMemento() as unknown as vscode.Memento,
        ),
    );
}

afterEach(() => {
    delete process.env[VARIABLE];
});

const engines = [
    { provider: "mssql", options: () => mssqlOptions(), otherDatabase: "master" },
    { provider: "pg", options: () => pgOptions(), otherDatabase: "postgres" },
] as const;

for (const engine of engines) {
    describe(`${engine.provider}: password from an environment variable`, () => {
        it("connects, runs queries and changes database with the variable's value", async () => {
            const { password, ...options } = engine.options();
            process.env[VARIABLE] = String(password);
            const profile = {
                id: `env-${engine.provider}`,
                provider: engine.provider,
                ...options,
                password: `\${env:${VARIABLE}}`,
            } as unknown as IConnectionProfile;

            const connection = await connectorFor(profile).connect(profile);
            try {
                expect(await connection!.listDatabases()).toContain(engine.otherDatabase);
                // PostgreSQL opens a new physical connection here, with the same resolved options.
                await connection!.changeDatabase(engine.otherDatabase);
                expect(await connection!.getCurrentDatabase()).toBe(engine.otherDatabase);
            } finally {
                await connection!.close();
            }
            expect(profile.password).toBe(`\${env:${VARIABLE}}`);
        });

        it("fails with a wrong value, showing the reference rather than the value", async () => {
            const { user, ...options } = engine.options();
            process.env[VARIABLE] = String(user);
            const profile = {
                id: `env-${engine.provider}`,
                provider: engine.provider,
                ...options,
                user: `\${env:${VARIABLE}}`,
                password: "not-the-password",
            } as unknown as IConnectionProfile;

            const failure = connectorFor(profile).connect(profile);

            await expect(failure).rejects.toThrow(`\${env:${VARIABLE}}`);
        });
    });
}

describe("unset variable", () => {
    let listener: Server | undefined;
    afterEach(async () => {
        await new Promise((resolve) => listener?.close(resolve));
    });

    it("fails before any network attempt, for both engines", async () => {
        let accepted = 0;
        listener = createServer((socket) => {
            accepted++;
            socket.destroy();
        });
        await new Promise<void>((resolve) => listener!.listen(0, "127.0.0.1", resolve));
        const port = (listener.address() as AddressInfo).port;

        for (const profile of [
            { ...mssqlOptions(), provider: "mssql", server: `127.0.0.1,${port}` },
            { ...pgOptions(), provider: "pg", server: "127.0.0.1", port },
        ]) {
            const p = {
                id: "unset",
                ...profile,
                password: `\${env:${VARIABLE}}`,
            } as unknown as IConnectionProfile;
            await expect(connectorFor(p).connect(p)).rejects.toThrow(
                `Environment variable ${VARIABLE} is not set`,
            );
        }
        expect(accepted).toBe(0);
    });
});
