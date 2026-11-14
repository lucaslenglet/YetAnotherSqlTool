import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { Connector } from "../../src/connections/connector";
import type { IConnectionProfile } from "../../src/models/interfaces";
import { getConnectionDisplayString, getTooltip } from "../../src/models/connectionInfo";
import { FakeTdsServer } from "../support/fakeTdsServer";

// Passwords of Windows Authentication (NTLM) are asked and remembered like SQL logins'.

let server: FakeTdsServer;
beforeEach(async () => {
    server = await new FakeTdsServer().start();
    server.windowsLogins.set("CORP\\alice", "s3cret");
});
afterEach(() => server.stop());

function profile(overrides: Partial<IConnectionProfile> = {}): IConnectionProfile {
    return {
        id: "win",
        provider: "mssql",
        server: `127.0.0.1,${server.port}`,
        authenticationType: "Integrated",
        user: "CORP\\alice",
        password: "",
        trustServerCertificate: true,
        connectTimeout: 5,
        ...overrides,
    } as unknown as IConnectionProfile;
}

describe("Connector with Windows Authentication", () => {
    it("asks for the password once, naming the account, and signs in with it", async () => {
        const prompt = vi.mocked(vscode.window.showInputBox);
        prompt.mockClear();
        prompt.mockResolvedValueOnce("s3cret");
        const connector = new Connector();

        const first = await connector.connect(profile());
        const second = await connector.connect(profile());

        expect(prompt).toHaveBeenCalledTimes(1);
        expect(prompt.mock.calls[0][0]).toMatchObject({
            prompt: "Password for CORP\\alice",
            password: true,
        });
        expect(server.logins.length).toBeGreaterThanOrEqual(2);
        expect(server.logins.every((login) => login.ntlm?.proofValid === true)).toBe(true);
        await first!.close();
        await second!.close();
    });

    it("gives up quietly when the password prompt is cancelled", async () => {
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

        await expect(new Connector().connect(profile())).resolves.toBeUndefined();
        expect(server.logins).toHaveLength(0);
    });

    it("asks again after a wrong password", async () => {
        const prompt = vi.mocked(vscode.window.showInputBox);
        prompt.mockClear();
        prompt.mockResolvedValueOnce("wrong").mockResolvedValueOnce("s3cret");
        const connector = new Connector();

        await expect(connector.connect(profile())).rejects.toThrow(/Login failed/);
        await (await connector.connect(profile()))!.close();

        expect(prompt).toHaveBeenCalledTimes(2);
    });

    it("shows the account as typed in the connection descriptions", () => {
        expect(getConnectionDisplayString(profile())).toContain("CORP\\alice");
        expect(getTooltip(profile())).toContain("User: CORP\\alice");
    });
});
