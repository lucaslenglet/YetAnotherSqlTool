import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { IConnectionConfig } from "../../src/connectionconfig/connectionconfig";
import { ConnectionStore } from "../../src/connections/connectionStore";
import { Connector } from "../../src/connections/connector";
import type { IConnectionProfile } from "../../src/models/interfaces";
import { FakeTdsServer } from "../support/fakeTdsServer";

// A password typed at the prompt is saved once the connection has succeeded, for a profile
// that saves its password. This is how an imported profile (which cannot bring its password)
// ends up with a saved one.

let server: FakeTdsServer;
let saved: IConnectionProfile[];
let secrets: Map<string, string>;

beforeEach(async () => {
    server = await new FakeTdsServer().start();
    server.sqlLogins.set("alice", "s3cret");
    saved = [];
    secrets = new Map();
    vi.mocked(vscode.window.showInputBox).mockReset();
});
afterEach(() => server.stop());

function profile(overrides: Partial<IConnectionProfile> = {}): IConnectionProfile {
    return {
        id: "p1",
        provider: "mssql",
        server: `127.0.0.1,${server.port}`,
        authenticationType: "SqlLogin",
        user: "alice",
        password: "",
        trustServerCertificate: true,
        connectTimeout: 5,
        savePassword: true,
        ...overrides,
    } as unknown as IConnectionProfile;
}

function newConnector(): Connector {
    const config = { getConnections: async () => saved } as unknown as IConnectionConfig;
    const memento = { get: () => undefined, update: async () => undefined };
    const secretStorage = {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => void secrets.set(key, value),
        delete: async (key: string) => void secrets.delete(key),
    };
    return new Connector(new ConnectionStore(config, secretStorage as never, memento as never));
}

describe("Connector saves a typed password", () => {
    it("after a successful connection, when the profile saves its password", async () => {
        saved = [profile()];
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("s3cret");

        const connection = await newConnector().connect(profile());
        await connection!.close();
        expect([...secrets.values()]).toEqual(["s3cret"]);

        // The saved password is used by a later session: no prompt.
        const prompt = vi.mocked(vscode.window.showInputBox);
        prompt.mockClear();
        const again = await newConnector().connect(profile());
        await again!.close();
        expect(prompt).not.toHaveBeenCalled();
    });

    it("never when the password is wrong", async () => {
        saved = [profile()];
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("wrong");

        await expect(newConnector().connect(profile())).rejects.toThrow(/Login failed/);
        expect(secrets.size).toBe(0);
    });

    it("not when the profile does not save its password", async () => {
        saved = [profile({ savePassword: false })];
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("s3cret");

        const connection = await newConnector().connect(profile({ savePassword: false }));
        await connection!.close();
        expect(secrets.size).toBe(0);
    });

    it("saves it for the saved profile when the connection comes from the recently used list", async () => {
        saved = [profile({ profileName: "Prod" })];
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("s3cret");
        // A recently used entry has neither id nor password flag of its own.
        const recent = profile({ id: "", savePassword: false, profileName: "Prod" });

        const connection = await newConnector().connect(recent);
        await connection!.close();
        expect([...secrets.keys()]).toEqual(["yast:profile:p1"]);
    });
});
