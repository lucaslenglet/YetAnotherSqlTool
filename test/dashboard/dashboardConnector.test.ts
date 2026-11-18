import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { Connector, openDashboardSession } from "../../src/connections/connector";
import { pgDriver } from "../../src/drivers/pg";
import type { ConnectParams, DashboardSession, Driver } from "../../src/drivers/types";
import type { IConnectionProfile } from "../../src/models/interfaces";

// The dashboard's connection goes through the connector, as every other connection: password
// lookup or prompt, environment references and the redaction of their values in errors.

const original = pgDriver.openDashboard;
let opened: ConnectParams[];

function fakeSession(params: ConnectParams): DashboardSession {
    return {
        charts: [],
        notices: [],
        sample: async () => {
            throw new Error(`permission denied for ${String(params.options.user)}`);
        },
        close: async () => undefined,
    };
}

beforeEach(() => {
    opened = [];
    (pgDriver as Driver).openDashboard = vi.fn(async (params: ConnectParams) => {
        opened.push(params);
        return fakeSession(params);
    });
});

afterEach(() => {
    (pgDriver as Driver).openDashboard = original;
    delete process.env.YAST_TEST_DASHBOARD_USER;
});

const profile = (overrides: Partial<IConnectionProfile> = {}) =>
    ({
        id: "pg-1",
        provider: "pg",
        server: "db.example",
        database: "postgres",
        user: "alice",
        authenticationType: "SqlLogin",
        ...overrides,
    }) as unknown as IConnectionProfile;

describe("openDashboardSession", () => {
    it("opens with the driver's openDashboard and the resolved options", async () => {
        const session = await openDashboardSession(profile({ password: "pw" }));
        expect(opened).toHaveLength(1);
        expect(opened[0].options).toMatchObject({
            server: "db.example",
            user: "alice",
            password: "pw",
        });
        expect(opened[0].options.provider).toBeUndefined();
        expect(opened[0].entraAllowedServers).toEqual([]);
        await session.close();
    });

    it("never shows a value read from the environment in an error of the session", async () => {
        process.env.YAST_TEST_DASHBOARD_USER = "secret-login";
        const session = await openDashboardSession(
            profile({ user: "${env:YAST_TEST_DASHBOARD_USER}", password: "pw" }),
            async () => undefined,
        );
        expect(opened[0].options.user).toBe("secret-login");
        await expect(session.sample(new AbortController().signal)).rejects.toThrow(
            "permission denied for ${env:YAST_TEST_DASHBOARD_USER}",
        );
    });

    it("refuses environment references the profile may not read", async () => {
        process.env.YAST_TEST_DASHBOARD_USER = "secret-login";
        await expect(
            openDashboardSession(profile({ user: "${env:YAST_TEST_DASHBOARD_USER}" })),
        ).rejects.toThrow("Environment variables cannot be read");
        expect(opened).toHaveLength(0);
    });

    it("rejects for an engine without a dashboard", async () => {
        (pgDriver as Driver).openDashboard = undefined;
        await expect(openDashboardSession(profile({ password: "pw" }))).rejects.toThrow(
            "PostgreSQL has no server dashboard.",
        );
    });
});

describe("Connector.openDashboard", () => {
    it("asks for a missing password, and gives up quietly when the prompt is cancelled", async () => {
        const prompt = vi.mocked(vscode.window.showInputBox);
        prompt.mockClear();
        prompt.mockResolvedValueOnce(undefined);
        const connector = new Connector();
        await expect(connector.openDashboard(profile())).resolves.toBeUndefined();
        expect(opened).toHaveLength(0);

        prompt.mockResolvedValueOnce("typed");
        const session = await connector.openDashboard(profile());
        expect(session).toBeDefined();
        expect(opened[0].options.password).toBe("typed");
        // Remembered for the session, as for the other connections.
        await connector.openDashboard(profile());
        expect(prompt).toHaveBeenCalledTimes(2);
        expect(opened[1].options.password).toBe("typed");
    });

    it("keeps a password known before when the dashboard fails for its own reasons", async () => {
        const prompt = vi.mocked(vscode.window.showInputBox);
        prompt.mockClear();
        const connector = new Connector();
        connector.rememberPassword("pg-1", "remembered");
        (pgDriver as Driver).openDashboard = async () => {
            throw new Error("This server has no dashboard.");
        };
        await expect(connector.openDashboard(profile())).rejects.toThrow("no dashboard");
        (pgDriver as Driver).openDashboard = async (params) => fakeSession(params);
        await connector.openDashboard(profile());
        expect(prompt).not.toHaveBeenCalled();
    });

    it("reuses the password the Object Explorer connection was opened with", async () => {
        const prompt = vi.mocked(vscode.window.showInputBox);
        prompt.mockClear();
        const connector = new Connector();
        connector.rememberPassword("pg-1", "remembered");
        await connector.openDashboard(profile());
        expect(prompt).not.toHaveBeenCalled();
        expect(opened[0].options.password).toBe("remembered");
    });
});
