import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConnectionStore } from "../../src/connections/connectionStore";
import { Connector, openConnection } from "../../src/connections/connector";
import type { IConnectionConfig } from "../../src/connectionconfig/connectionconfig";
import type { IConnectionProfile } from "../../src/models/interfaces";
import { FakeTdsServer } from "../support/fakeTdsServer";

// `${env:NAME}` references against a SQL Server stand-in: who may read the environment, and
// where the values never go.

class MemoryMemento {
    values = new Map<string, unknown>();
    get<T>(key: string) {
        return this.values.get(key) as T;
    }
    async update(key: string, value: unknown) {
        this.values.set(key, value);
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

const SECRET = "Secr3t-from-the-env!";
const variables = ["YAST_TEST_PASSWORD", "YAST_TEST_USER", "YAST_TEST_HOST"];

let server: FakeTdsServer;
let settings: IConnectionProfile[];
let memento: MemoryMemento;
let secrets: MemorySecrets;
let store: ConnectionStore;
let connector: Connector;
const warning = vi.mocked(vscode.window.showWarningMessage);
const prompt = vi.mocked(vscode.window.showInputBox);

beforeEach(async () => {
    server = await new FakeTdsServer().start();
    server.sqlLogins.set("sa", SECRET);
    process.env.YAST_TEST_PASSWORD = SECRET;
    process.env.YAST_TEST_USER = "sa";
    process.env.YAST_TEST_HOST = "127.0.0.1";
    settings = [];
    memento = new MemoryMemento();
    secrets = new MemorySecrets();
    const config = {
        getConnections: async () => settings.map((c) => ({ ...c })),
        populateMissingConnectionMetadata: () => false,
        addConnection: async (p: IConnectionProfile) => {
            settings = [...settings.filter((c) => c.id !== p.id), { ...p }];
        },
    } as unknown as IConnectionConfig;
    store = new ConnectionStore(
        config,
        secrets as unknown as vscode.SecretStorage,
        memento as unknown as vscode.Memento,
    );
    connector = new Connector(store);
    warning.mockReset();
    warning.mockResolvedValue(undefined);
    prompt.mockClear();
});

afterEach(async () => {
    await server.stop();
    for (const name of variables) delete process.env[name];
});

function profile(
    overrides: Partial<IConnectionProfile> = {},
    configSource = vscode.ConfigurationTarget.Global,
): IConnectionProfile {
    return {
        id: "p1",
        provider: "mssql",
        profileName: "Team database",
        server: `127.0.0.1,${server.port}`,
        authenticationType: "SqlLogin",
        user: "sa",
        password: "${env:YAST_TEST_PASSWORD}",
        savePassword: false,
        trustServerCertificate: true,
        connectTimeout: 5,
        configSource,
        ...overrides,
    } as unknown as IConnectionProfile;
}

const allow = () => warning.mockResolvedValueOnce("Allow" as never);

describe("a profile of the user's settings", () => {
    it("connects with the variable's value, without any prompt", async () => {
        settings.push(profile());

        const connection = await connector.connect(profile());
        await connection!.close();

        expect(server.logins.at(-1)).toMatchObject({ userName: "sa", password: SECRET });
        expect(warning).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
    });

    it("resolves references in the server and user fields too", async () => {
        const p = profile({
            server: `\${env:YAST_TEST_HOST},${server.port}`,
            user: "${env:YAST_TEST_USER}",
        });
        settings.push(p);

        await (await connector.connect(p))!.close();

        expect(server.logins.at(-1)).toMatchObject({ userName: "sa", password: SECRET });
    });

    it("fails naming an unset variable before any network attempt", async () => {
        delete process.env.YAST_TEST_PASSWORD;
        settings.push(profile());

        await expect(connector.connect(profile())).rejects.toThrow(
            "Environment variable YAST_TEST_PASSWORD is not set",
        );
        expect(server.logins).toHaveLength(0);
    });

    it("sends an empty variable as an empty password", async () => {
        process.env.YAST_TEST_PASSWORD = "";
        settings.push(profile());

        await expect(connector.connect(profile())).rejects.toThrow(/Login failed/);
        expect(server.logins.at(-1)).toMatchObject({ password: "" });
        expect(prompt).not.toHaveBeenCalled();
    });

    it("keeps an escaped reference as a literal password", async () => {
        server.sqlLogins.set("sa", "${env:YAST_TEST_PASSWORD}");
        const p = profile({ password: "$${env:YAST_TEST_PASSWORD}" });

        await (await new Connector().connect(p))!.close();

        expect(server.logins.at(-1)?.password).toBe("${env:YAST_TEST_PASSWORD}");
    });

    it("shows the reference, never the value, in a connection error", async () => {
        process.env.YAST_TEST_USER = "someone-else";
        const p = profile({ user: "${env:YAST_TEST_USER}" });
        settings.push(p);

        const failure = connector.connect(p);

        await expect(failure).rejects.toThrow("Login failed for user '${env:YAST_TEST_USER}'");
        await expect(failure).rejects.not.toThrow(/someone-else/);
    });
});

describe("what is kept", () => {
    it("writes a password holding a reference to settings as typed, never to SecretStorage", async () => {
        await store.saveProfile(profile({ savePassword: true }));

        expect(settings[0].password).toBe("${env:YAST_TEST_PASSWORD}");
        expect(secrets.values.size).toBe(0);
    });

    it("keeps an ordinary password out of settings, as before", async () => {
        await store.saveProfile(profile({ password: "typed", savePassword: true }));

        expect(settings[0].password).toBe("");
        expect([...secrets.values.values()]).toEqual(["typed"]);
    });

    it("never writes a resolved value to the recently used list", async () => {
        const p = profile({ user: "${env:YAST_TEST_USER}" });
        settings.push(p);

        await (await connector.connect(p))!.close();

        const stored = JSON.stringify([...memento.values.values()]);
        expect(stored).not.toContain(SECRET);
        expect(store.getRecentlyUsedConnections()[0]).toMatchObject({
            user: "${env:YAST_TEST_USER}",
            password: "",
        });
    });

    it("connects a recently used entry with its profile's reference, without a prompt", async () => {
        settings.push(profile());
        await (await connector.connect(profile()))!.close();
        const [recent] = store.getRecentlyUsedConnections();

        await (await connector.connect(recent))!.close();

        expect(server.logins.at(-1)?.password).toBe(SECRET);
        expect(prompt).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
    });
});

describe("a profile of the workspace settings", () => {
    const workspace = (overrides: Partial<IConnectionProfile> = {}) =>
        profile({ id: "w1", ...overrides }, vscode.ConfigurationTarget.Workspace);

    it("asks first, naming the connection, the server and the variables", async () => {
        settings.push(workspace());
        allow();

        await (await connector.connect(workspace()))!.close();

        expect(warning).toHaveBeenCalledTimes(1);
        const [message, options] = warning.mock.calls[0] as unknown as [
            string,
            vscode.MessageOptions,
        ];
        expect(message).toContain('"Team database"');
        expect(options.modal).toBe(true);
        expect(options.detail).toContain(`Server: 127.0.0.1,${server.port}`);
        expect(options.detail).toContain("Variables: YAST_TEST_PASSWORD");
        expect(options.detail).not.toContain(SECRET);
        expect(server.logins.at(-1)?.password).toBe(SECRET);
    });

    it("remembers an allowed combination", async () => {
        settings.push(workspace());
        allow();

        await (await connector.connect(workspace()))!.close();
        await (await connector.connect(workspace()))!.close();
        await (await new Connector(store).connect(workspace()))!.close();

        expect(warning).toHaveBeenCalledTimes(1);
    });

    it("fails without sending anything when refused, and asks again next time", async () => {
        settings.push(workspace());

        await expect(connector.connect(workspace())).rejects.toThrow(
            'Reading environment variables was not allowed for the connection "Team database".',
        );
        expect(server.logins).toHaveLength(0);

        allow();
        await (await connector.connect(workspace()))!.close();
        expect(warning).toHaveBeenCalledTimes(2);
    });

    it("asks again when the server or the references change after being allowed", async () => {
        settings.push(workspace());
        allow();
        await (await connector.connect(workspace()))!.close();

        const otherServer = await new FakeTdsServer().start();
        try {
            otherServer.sqlLogins.set("sa", SECRET);
            await expect(
                connector.connect(workspace({ server: `127.0.0.1,${otherServer.port}` })),
            ).rejects.toThrow(/not allowed/);
            expect(otherServer.logins).toHaveLength(0);
        } finally {
            await otherServer.stop();
        }
        await expect(
            connector.connect(workspace({ user: "${env:YAST_TEST_USER}" })),
        ).rejects.toThrow(/not allowed/);
        // Weaker transport security could expose the values to the network.
        await expect(connector.connect(workspace({ encrypt: "Optional" }))).rejects.toThrow(
            /not allowed/,
        );
        expect(warning).toHaveBeenCalledTimes(4);
    });

    it("says when the server name itself comes from the environment", async () => {
        const p = workspace({ server: `\${env:YAST_TEST_HOST},${server.port}` });
        settings.push(p);

        await expect(connector.connect(p)).rejects.toThrow(/not allowed/);

        const options = warning.mock.calls[0][1] as vscode.MessageOptions;
        expect(options.detail).toContain(`Server: \${env:YAST_TEST_HOST},${server.port}`);
        expect(options.detail).toContain("Variables: YAST_TEST_HOST, YAST_TEST_PASSWORD");
        expect(options.detail).toContain("comes from an environment variable");
    });

    it("asks once for connections opened at the same time", async () => {
        settings.push(workspace());
        let answer: (value: string) => void = () => undefined;
        warning.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);

        const both = Promise.all([connector.connect(workspace()), connector.connect(workspace())]);
        await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
        answer("Allow");
        for (const connection of await both) await connection!.close();

        expect(warning).toHaveBeenCalledTimes(1);
    });

    it("asks for a recently used entry whose profile came from the workspace", async () => {
        settings.push(workspace());
        allow();
        await (await connector.connect(workspace()))!.close();
        const [recent] = store.getRecentlyUsedConnections();
        // The repository is closed: the profile is gone, the recent entry stays.
        settings = [];
        memento.values.delete("yast.environmentReferences.allowed");

        const fromRecent = { ...recent, password: "${env:YAST_TEST_PASSWORD}" };
        await expect(connector.connect(fromRecent)).rejects.toThrow(/not allowed/);
        expect(warning).toHaveBeenCalledTimes(2);
    });

    it("asks when a profile claims a user profile's id but holds other references", async () => {
        settings.push(profile({ password: "typed" }));

        await expect(connector.connect(profile({ configSource: undefined }))).rejects.toThrow(
            /not allowed/,
        );
        expect(server.logins).toHaveLength(0);
    });

    it("asks when a user profile's id comes with another server", async () => {
        settings.push(profile({ server: "elsewhere" }));

        await expect(connector.connect(profile())).rejects.toThrow(/not allowed/);
        expect(server.logins).toHaveLength(0);
    });
});

describe("openConnection", () => {
    it("refuses references unless the caller says they may be read", async () => {
        await expect(openConnection(profile())).rejects.toThrow(
            "Environment variables cannot be read for this connection.",
        );
        expect(server.logins).toHaveLength(0);
        await (await openConnection(profile({ password: SECRET })))!.close();
        expect(server.logins.at(-1)?.password).toBe(SECRET);
    });
});
