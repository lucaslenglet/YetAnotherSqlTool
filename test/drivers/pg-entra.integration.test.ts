import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { Connector, openConnection } from "../../src/connections/connector";
import { getDriver } from "../../src/drivers";
import type { DriverConnection, ExecuteEvent, ObjectNode } from "../../src/drivers/types";
import type { IConnectionProfile } from "../../src/models/interfaces";
import { pgEntra } from "../support/databases";
import {
    FakeClientSecretCredential,
    forgeAccessToken,
    startManagedIdentityEndpoint,
    type ManagedIdentityEndpoint,
} from "../support/entraFakes";
import { createSelfSignedCertificate } from "../support/selfSignedCertificate";

// Microsoft Entra ID sign-ins to PostgreSQL, end to end, with no Azure resource.
//
// Azure Database for PostgreSQL takes the access token as the password, over TLS, for a role
// named after the identity. The PostgreSQL of test/fixtures/postgres-entra does the same, except
// that it compares the token with the role's password instead of validating it: a connection
// succeeds only when the driver sends, over TLS, exactly the token the test gave that role.

// The token request of a service principal can only go to Microsoft: it is replaced. The
// DefaultAzureCredential is the real one (see startManagedIdentityEndpoint).
vi.mock("@azure/identity", async (importOriginal) => {
    const { FakeClientSecretCredential } = await import("../support/entraFakes");
    return {
        ...(await importOriginal<object>()),
        ClientSecretCredential: FakeClientSecretCredential,
    };
});

const POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";
const pgDriver = getDriver("pg");

let admin: Client;
const connections: DriverConnection[] = [];

beforeAll(async () => {
    const { host, port, user, password, database } = pgEntra();
    admin = new Client({ host, port, user, password, database });
    await admin.connect();
});

afterAll(async () => {
    await admin.end();
});

beforeEach(() => {
    FakeClientSecretCredential.reset();
    vi.mocked(vscode.authentication.getSession).mockReset();
    vi.mocked(vscode.authentication.getAccounts).mockReset();
});

afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()));
    vi.restoreAllMocks();
});

/** Creates the role of an Entra identity, or gives it a new token, the way a new sign-in would. */
async function setRoleToken(role: string, token: string): Promise<void> {
    const name = pgDriver.quoteIdentifier(role);
    const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    await admin.query(
        existing.rowCount
            ? `ALTER ROLE ${name} PASSWORD '${token}'`
            : `CREATE ROLE ${name} LOGIN IN ROLE azure_ad_user PASSWORD '${token}'`,
    );
}

/** Physical connections currently open by a role, as the server sees them. */
async function openConnectionsOf(role: string): Promise<number> {
    const result = await admin.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename = $1",
        [role],
    );
    return result.rows[0].count;
}

function entraOptions(overrides: Record<string, string | number | boolean> = {}) {
    const { host, port, database } = pgEntra();
    return { server: host, port, database, ...overrides };
}

/** The server as the user must list it in `yast.entraId.allowedServers`. */
const allowed = () => [pgEntra().host];

async function connect(params: Parameters<typeof pgDriver.connect>[0]): Promise<DriverConnection> {
    const connection = await pgDriver.connect(params);
    connections.push(connection);
    return connection;
}

async function run(
    connection: DriverConnection,
    text: string,
    signal = new AbortController().signal,
): Promise<ExecuteEvent[]> {
    const events: ExecuteEvent[] = [];
    await connection.execute({ text, startLine: 0 }, (event) => events.push(event), signal);
    return events;
}

/** First value of the first row a query returns. */
async function scalar(connection: DriverConnection, text: string): Promise<string | undefined> {
    for (const event of await run(connection, text)) {
        if (event.type === "rows") return event.rows[0][0].displayValue;
    }
    return undefined;
}

async function childNamed(
    connection: DriverConnection,
    parent: ObjectNode,
    label: string,
): Promise<ObjectNode> {
    const children = await connection.expandNode(parent);
    const child = children.find((node) => node.label === label);
    if (!child)
        throw new Error(
            `No "${label}" under "${parent.label}": ${children.map((node) => node.label).join(", ")}`,
        );
    return child;
}

/** Makes `yast.entraId.allowedServers` return the given names; other settings keep their default. */
function setAllowedServersSetting(servers: string[]): void {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
        get: (key: string, fallback?: unknown) =>
            key === "entraId.allowedServers" ? servers : fallback,
    } as never);
}

describe("PostgreSQL with a Microsoft account of VS Code (AzureMFA)", () => {
    it("signs in over TLS as the name read from the token when no user is typed", async () => {
        const token = forgeAccessToken({ upn: "someone@contoso.com" });
        await setRoleToken("someone@contoso.com", token);
        const getAccessToken = vi.fn(async () => token);

        // Even with "disable" in the profile: an Entra ID token never travels in clear text.
        const connection = await connect({
            options: entraOptions({ authenticationType: "AzureMFA", sslmode: "disable" }),
            getAccessToken,
            entraAllowedServers: allowed(),
        });

        expect(connection.serverInfo.userName).toBe("someone@contoso.com");
        expect(getAccessToken.mock.calls).toEqual([[POSTGRES_SCOPE]]);
        expect(
            await scalar(connection, "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"),
        ).toBe("true");
    });

    it("reads the name of a guest account, which has no upn", async () => {
        const token = forgeAccessToken({ preferred_username: "guest@fabrikam.com" });
        await setRoleToken("guest@fabrikam.com", token);

        const connection = await connect({
            options: entraOptions({ authenticationType: "AzureMFA" }),
            getAccessToken: async () => token,
            entraAllowedServers: allowed(),
        });

        expect(connection.serverInfo.userName).toBe("guest@fabrikam.com");
    });

    it("signs in as the typed role with the token of the account, as members of an Entra group do", async () => {
        const token = forgeAccessToken({ upn: "member@contoso.com" });
        await setRoleToken("Database Admins", token);

        const connection = await connect({
            options: entraOptions({ authenticationType: "AzureMFA", user: "Database Admins" }),
            getAccessToken: async () => token,
            entraAllowedServers: allowed(),
        });

        expect(connection.serverInfo.userName).toBe("Database Admins");
    });

    it("asks for a token again for every physical connection", async () => {
        const role = "rotating@contoso.com";
        const issued: string[] = [];
        // Every sign-in gets a new token and the server stops accepting the previous one, so a
        // connection opened with a token kept from an earlier one would be refused.
        const getAccessToken = vi.fn(async () => {
            const token = forgeAccessToken({ upn: role });
            issued.push(token);
            await setRoleToken(role, token);
            return token;
        });

        // The query session.
        const connection = await connect({
            options: entraOptions({ authenticationType: "AzureMFA" }),
            getAccessToken,
            entraAllowedServers: allowed(),
        });
        expect(getAccessToken).toHaveBeenCalledTimes(1);
        expect(await openConnectionsOf(role)).toBe(1);

        // Object Explorer: one connection for the server-level lists...
        const databases = await childNamed(connection, connection.getRootNode(), "Databases");
        const sales = await childNamed(connection, databases, "sales");
        expect(getAccessToken).toHaveBeenCalledTimes(2);
        // ...then one per database.
        await connection.expandNode(await childNamed(connection, sales, "Schemas"));
        expect(getAccessToken).toHaveBeenCalledTimes(3);
        expect(await openConnectionsOf(role)).toBe(3);

        // Changing the database of the editor replaces the session with a new connection.
        await connection.changeDatabase("sales");
        expect(await scalar(connection, "SELECT current_database()")).toBe("sales");
        expect(getAccessToken).toHaveBeenCalledTimes(4);

        // Canceling a query goes through a short-lived connection of its own.
        const controller = new AbortController();
        const running = run(connection, "SELECT pg_sleep(60)", controller.signal);
        await vi.waitFor(async () => {
            const active = await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND query = 'SELECT pg_sleep(60)' AND state = 'active'",
                [role],
            );
            expect(active.rowCount).toBe(1);
        }, 10000);
        controller.abort();
        const events = await running;
        expect(events).toContainEqual({
            type: "message",
            text: "Query was canceled by user.",
            isError: true,
        });
        expect(getAccessToken).toHaveBeenCalledTimes(5);

        expect(new Set(issued).size).toBe(5);
        expect(getAccessToken.mock.calls.every(([scope]) => scope === POSTGRES_SCOPE)).toBe(true);
    });

    it("explains a token the server refuses, such as an expired one", async () => {
        await setRoleToken("late@contoso.com", forgeAccessToken({ upn: "late@contoso.com" }));
        const expired = forgeAccessToken({ upn: "late@contoso.com" }, -600);

        const attempt = pgDriver.connect({
            options: entraOptions({ authenticationType: "AzureMFA" }),
            getAccessToken: async () => expired,
            entraAllowedServers: allowed(),
        });

        await expect(attempt).rejects.toThrow(
            'Authentication failed for user "late@contoso.com": password authentication failed for user "late@contoso.com"',
        );
    });

    it("explains that the sign-in failed when VS Code gives no token", async () => {
        const attempt = pgDriver.connect({
            options: entraOptions({ authenticationType: "AzureMFA" }),
            getAccessToken: async () => {
                throw new Error(
                    "The Microsoft account someone@contoso.com is not signed in to VS Code.",
                );
            },
            entraAllowedServers: allowed(),
        });

        await expect(attempt).rejects.toThrow(
            "The Microsoft account someone@contoso.com is not signed in to VS Code.",
        );
    });

    it("refuses a server that is neither Azure's nor allowed by the user, before asking for any token", async () => {
        const getAccessToken = vi.fn(async () => forgeAccessToken({ upn: "someone@contoso.com" }));
        const options = entraOptions({ authenticationType: "AzureMFA" });

        await expect(pgDriver.connect({ options, getAccessToken })).rejects.toThrow(
            /yast\.entraId\.allowedServers/,
        );
        await expect(
            pgDriver.connect({
                options,
                getAccessToken,
                entraAllowedServers: ["other.example.com", ".corp.example.com"],
            }),
        ).rejects.toThrow(`To use it with "${pgEntra().host}"`);

        expect(getAccessToken).not.toHaveBeenCalled();
    });

    describe("certificate checks asked by the user", () => {
        let folder: string;
        beforeAll(() => {
            folder = mkdtempSync(join(tmpdir(), "yast-entra-"));
            writeFileSync(join(folder, "server.crt"), pgEntra().certificate);
            writeFileSync(join(folder, "other.crt"), createSelfSignedCertificate().cert);
        });
        afterAll(() => rmSync(folder, { recursive: true, force: true }));

        it("keeps verify-full, and sends no token to a server whose certificate is not the expected one", async () => {
            const token = forgeAccessToken({ upn: "careful@contoso.com" });
            await setRoleToken("careful@contoso.com", token);
            const params = (certificate: string) => ({
                options: entraOptions({
                    authenticationType: "AzureMFA",
                    sslmode: "verify-full",
                    sslrootcert: join(folder, certificate),
                }),
                getAccessToken: async () => token,
                entraAllowedServers: allowed(),
            });

            const connection = await connect(params("server.crt"));
            expect(connection.serverInfo.userName).toBe("careful@contoso.com");

            await expect(pgDriver.connect(params("other.crt"))).rejects.toThrow(/certificate/);
            // Only the connection above ever authenticated.
            expect(await openConnectionsOf("careful@contoso.com")).toBe(1);
        });
    });
});

describe("PostgreSQL through the connector, with VS Code's account provider", () => {
    const account = {
        id: "33333333-3333-4333-8333-333333333333.11111111-1111-4111-8111-111111111111",
        label: "someone@contoso.com",
    };
    const tenantId = "55555555-5555-4555-8555-555555555555";
    const profile = () =>
        ({
            id: "entra-pg",
            provider: "pg",
            ...entraOptions({ authenticationType: "AzureMFA" }),
            user: "",
            accountId: account.id,
            tenantId,
        }) as unknown as IConnectionProfile;

    it("signs in with the token VS Code gives for the profile's account and tenant", async () => {
        const token = forgeAccessToken({ upn: "viacode@contoso.com", tid: tenantId });
        await setRoleToken("viacode@contoso.com", token);
        setAllowedServersSetting(allowed());
        vi.mocked(vscode.authentication.getAccounts).mockResolvedValue([account]);
        vi.mocked(vscode.authentication.getSession).mockResolvedValue({
            accessToken: token,
        } as never);

        const connection = await openConnection(profile());
        connections.push(connection);

        expect(connection.serverInfo.userName).toBe("viacode@contoso.com");
        expect(vi.mocked(vscode.authentication.getSession).mock.calls).toEqual([
            ["microsoft", [POSTGRES_SCOPE, `VSCODE_TENANT:${tenantId}`], { account, silent: true }],
        ]);
    });

    it("does not ask VS Code for a token when the server is not in yast.entraId.allowedServers", async () => {
        vi.mocked(vscode.authentication.getAccounts).mockResolvedValue([account]);

        await expect(new Connector().connect(profile())).rejects.toThrow(
            /yast\.entraId\.allowedServers/,
        );

        expect(vscode.authentication.getAccounts).not.toHaveBeenCalled();
        expect(vscode.authentication.getSession).not.toHaveBeenCalled();
    });
});

describe("PostgreSQL with the identity of the machine (Default)", () => {
    const AUDIENCE = "https://ossrdbms-aad.database.windows.net";
    let endpoint: ManagedIdentityEndpoint;
    beforeAll(async () => {
        endpoint = await startManagedIdentityEndpoint();
    });
    afterAll(() => endpoint.stop());
    beforeEach(() => {
        endpoint.requests.length = 0;
    });

    // First of this group: once a token is kept, the following connections reuse it.
    it("asks no token for a server that is not allowed", async () => {
        const options = entraOptions({
            authenticationType: "ActiveDirectoryDefault",
            user: "yast-managed-identity",
        });

        await expect(pgDriver.connect({ options })).rejects.toThrow(
            /yast\.entraId\.allowedServers/,
        );

        expect(endpoint.requests).toEqual([]);
    });

    it("signs in with the token of the managed identity, kept until it is about to expire", async () => {
        const role = "yast-managed-identity";
        const params = {
            options: entraOptions({ authenticationType: "ActiveDirectoryDefault", user: role }),
            entraAllowedServers: allowed(),
        };
        const issue = async (lifetimeSeconds: number) => {
            const token = forgeAccessToken({ aud: AUDIENCE }, lifetimeSeconds);
            endpoint.issue = () => token;
            await setRoleToken(role, token);
        };

        // A token about to expire is not kept: the next connection asks for a new one.
        await issue(120);
        const first = await connect(params);
        expect(first.serverInfo.userName).toBe(role);
        expect(endpoint.requests).toEqual([{ resource: AUDIENCE, clientId: undefined }]);

        await issue(3600);
        await connect(params);
        expect(endpoint.requests).toHaveLength(2);

        // This one is valid for an hour: the following physical connections reuse it.
        const third = await connect(params);
        await third.changeDatabase("sales");
        expect(endpoint.requests).toHaveLength(2);
        expect(await openConnectionsOf(role)).toBe(3);
    });

    it("asks for the role when the token names no user, instead of trying the operating system's user name", async () => {
        const attempt = pgDriver.connect({
            options: entraOptions({ authenticationType: "ActiveDirectoryDefault" }),
            entraAllowedServers: allowed(),
        });

        await expect(attempt).rejects.toThrow(
            "The user name is required: this Microsoft Entra ID token does not name a user.",
        );
    });
});

describe("PostgreSQL with a service principal", () => {
    // A new application for every test: credentials are kept for the session, by client ID.
    let clientId: string;
    beforeEach(() => {
        clientId = randomUUID();
    });
    const profile = (overrides: Record<string, string> = {}) =>
        ({
            id: "entra-pg-app",
            provider: "pg",
            ...entraOptions({ authenticationType: "ActiveDirectoryServicePrincipal" }),
            // The role is named freely on Azure, usually after the application.
            user: "yast-app",
            clientId,
            tenantId: "55555555-5555-4555-8555-555555555555",
            password: "the-client-secret",
            ...overrides,
        }) as unknown as IConnectionProfile;

    it("signs in as the application's role with the token obtained from its client ID, tenant and secret", async () => {
        const token = forgeAccessToken({
            aud: "https://ossrdbms-aad.database.windows.net",
            appid: clientId,
        });
        await setRoleToken("yast-app", token);
        FakeClientSecretCredential.issue = () => token;
        setAllowedServersSetting(allowed());
        const connector = new Connector();

        const connection = (await connector.connect(profile()))!;
        connections.push(connection);

        expect(connection.serverInfo.userName).toBe("yast-app");
        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
        expect(FakeClientSecretCredential.created).toHaveLength(1);
        expect(FakeClientSecretCredential.created[0]).toMatchObject({
            tenantId: "55555555-5555-4555-8555-555555555555",
            clientId,
            clientSecret: "the-client-secret",
            scopes: [POSTGRES_SCOPE],
        });

        // The credential and its token are kept for the next connections of the session.
        connections.push((await connector.connect(profile()))!);
        expect(FakeClientSecretCredential.created).toHaveLength(1);
        expect(FakeClientSecretCredential.created[0].scopes).toEqual([POSTGRES_SCOPE]);
    });

    it("asks no token for a server that is not allowed", async () => {
        await expect(new Connector().connect(profile())).rejects.toThrow(
            /yast\.entraId\.allowedServers/,
        );

        expect(
            FakeClientSecretCredential.created.flatMap((credential) => credential.scopes),
        ).toEqual([]);
    });

    it("explains a token the server refuses", async () => {
        await setRoleToken("yast-other-app", forgeAccessToken());
        setAllowedServersSetting(allowed());

        const attempt = new Connector().connect(profile({ user: "yast-other-app" }));

        await expect(attempt).rejects.toThrow(
            'Authentication failed for user "yast-other-app": password authentication failed for user "yast-other-app"',
        );
    });
});
