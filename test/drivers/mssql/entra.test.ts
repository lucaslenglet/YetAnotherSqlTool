import { randomUUID } from "node:crypto";
import * as tls from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { Connector, openConnection } from "../../../src/connections/connector";
import { mssqlDriver } from "../../../src/drivers/mssql";
import type { DriverConnection, ExecuteEvent, ObjectNode } from "../../../src/drivers/types";
import type { IConnectionProfile } from "../../../src/models/interfaces";
import {
    FakeClientSecretCredential,
    forgeAccessToken,
    startManagedIdentityEndpoint,
    type ManagedIdentityEndpoint,
} from "../../support/entraFakes";
import { FakeTdsServer, type FakeTdsServerOptions } from "../../support/fakeTdsServer";

// Microsoft Entra ID sign-ins to SQL Server, checked on the wire, with no Azure resource.
//
// No local SQL Server takes an Entra ID token, so the real driver (mssql + tedious) connects to
// test/support/fakeTdsServer.ts, which plays Azure SQL's side of the login and records what it
// receives. This proves what the client sends, to whom and over what; whether Azure accepts the
// token is Azure's business and is not tested here.

// The token request of a service principal can only go to Microsoft: it is replaced. The
// DefaultAzureCredential is the real one (see startManagedIdentityEndpoint).
vi.mock("@azure/identity", async (importOriginal) => {
    const { FakeClientSecretCredential } = await import("../../support/entraFakes");
    return {
        ...(await importOriginal<object>()),
        ClientSecretCredential: FakeClientSecretCredential,
    };
});

const AZURE_SQL_SCOPE = "https://database.windows.net/.default";
const HOST = "127.0.0.1";

let server: FakeTdsServer;
const servers: FakeTdsServer[] = [];
const connections: DriverConnection[] = [];

async function startServer(options?: FakeTdsServerOptions): Promise<FakeTdsServer> {
    const started = await new FakeTdsServer(options).start();
    servers.push(started);
    return started;
}

beforeEach(async () => {
    server = await startServer();
    FakeClientSecretCredential.reset();
    vi.mocked(vscode.authentication.getSession).mockReset();
    vi.mocked(vscode.authentication.getAccounts).mockReset();
});

afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()));
    await Promise.all(servers.splice(0).map((started) => started.stop()));
    vi.restoreAllMocks();
});

/** Connection options for a fake server; its certificate is self-signed, so it is trusted explicitly. */
function options(overrides: Record<string, string | number | boolean> = {}, target = server) {
    return {
        server: `${HOST},${target.port}`,
        trustServerCertificate: true,
        connectTimeout: 5,
        ...overrides,
    };
}

async function connect(
    params: Parameters<typeof mssqlDriver.connect>[0],
): Promise<DriverConnection> {
    const connection = await mssqlDriver.connect(params);
    connections.push(connection);
    return connection;
}

async function run(connection: DriverConnection, text: string): Promise<ExecuteEvent[]> {
    const events: ExecuteEvent[] = [];
    await connection.execute(
        { text, startLine: 0 },
        (event) => events.push(event),
        new AbortController().signal,
    );
    return events;
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
function setAllowedServersSetting(names: string[]): void {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
        get: (key: string, fallback?: unknown) =>
            key === "entraId.allowedServers" ? names : fallback,
    } as never);
}

describe("SQL Server with a Microsoft account of VS Code (AzureMFA)", () => {
    it("logs in over TLS with the Entra ID feature of the protocol and sends the account's token as is", async () => {
        const token = forgeAccessToken({ upn: "someone@contoso.com" });
        const getAccessToken = vi.fn(async () => token);

        const connection = await connect({
            options: options({
                authenticationType: "AzureMFA",
                database: "sales",
                user: "someone@contoso.com",
            }),
            getAccessToken,
            entraAllowedServers: [HOST],
        });

        expect(connection.serverInfo).toMatchObject({
            productName: "SQL Server",
            isCloud: true,
            userName: "someone@contoso.com",
        });
        // mssql checks the configuration with a first connection, closes it, then opens the pool's.
        expect(server.logins).toHaveLength(2);
        for (const login of server.logins) {
            expect(login).toMatchObject({
                encrypted: true,
                tlsFirst: false,
                tdsVersion: "7.4",
                fedAuth: { library: "MSAL", echo: true, workflow: "integrated" },
                // Nothing but the token identifies the user.
                userName: "",
                hasPassword: false,
                database: "sales",
                appName: "YetAnotherSqlTool",
                accepted: true,
            });
            expect(login.token).toBe(token);
        }
        // One request per login, for the audience the server announced: Azure SQL's.
        expect(getAccessToken.mock.calls).toEqual([[AZURE_SQL_SCOPE], [AZURE_SQL_SCOPE]]);
        // A real token does not fit in one packet of the protocol either.
        expect(Buffer.byteLength(token, "ucs2")).toBeGreaterThan(4096);

        server.answer = (sql) =>
            sql === "SELECT 42 AS answer" ? { columns: ["answer:int"], rows: [[42]] } : undefined;
        expect(await run(connection, "SELECT 42 AS answer")).toContainEqual({
            type: "rows",
            rows: [[{ displayValue: "42", isNull: false }]],
        });
    });

    it("asks for a token again for every physical connection", async () => {
        const issued: string[] = [];
        const getAccessToken = vi.fn(async () => {
            issued.push(forgeAccessToken({ upn: "someone@contoso.com" }));
            return issued.at(-1)!;
        });
        server.answer = (sql) =>
            sql.includes("FROM sys.databases")
                ? {
                      columns: ["name", "databaseId:int"],
                      rows: [
                          ["master", 1],
                          ["sales", 5],
                      ],
                  }
                : undefined;

        // The query session.
        const connection = await connect({
            options: options({ authenticationType: "AzureMFA" }),
            getAccessToken,
            entraAllowedServers: [HOST],
        });
        expect(server.tokens).toEqual(issued);
        const sessionLogins = server.logins.length;

        // Object Explorer: its own connections, and on Azure SQL Database one set per database.
        const databases = await childNamed(connection, connection.getRootNode(), "Databases");
        const sales = await childNamed(connection, databases, "sales");
        const serverLevelLogins = server.logins.length;
        expect(serverLevelLogins).toBeGreaterThan(sessionLogins);
        await connection.expandNode(await childNamed(connection, sales, "Tables"));
        expect(server.logins.length).toBeGreaterThan(serverLevelLogins);
        expect(server.logins.at(-1)).toMatchObject({
            database: "sales",
            encrypted: true,
            accepted: true,
        });

        // Each login carried the token issued for it, never one kept from an earlier login.
        expect(server.tokens).toEqual(issued);
        expect(new Set(issued).size).toBe(server.logins.length);
        expect(getAccessToken.mock.calls.every(([scope]) => scope === AZURE_SQL_SCOPE)).toBe(true);
    });

    it("signs in again with a new token when the server has closed the connection", async () => {
        const issued: string[] = [];
        const getAccessToken = async () => {
            issued.push(forgeAccessToken({ upn: "someone@contoso.com" }));
            return issued.at(-1)!;
        };
        server.answer = (sql) =>
            sql === "SELECT 1 AS alive" ? { columns: ["alive:int"], rows: [[1]] } : undefined;
        const connection = await connect({
            options: options({ authenticationType: "AzureMFA" }),
            getAccessToken,
            entraAllowedServers: [HOST],
        });
        const loginsBefore = server.logins.length;

        // What happens to a session left idle, typically after its token has expired.
        server.dropConnections();
        await vi.waitFor(async () => {
            expect(await run(connection, "SELECT 1 AS alive")).toContainEqual({
                type: "rows",
                rows: [[{ displayValue: "1", isNull: false }]],
            });
        }, 4000);

        expect(server.logins.length).toBeGreaterThan(loginsBefore);
        expect(server.tokens).toEqual(issued);
        expect(new Set(issued).size).toBe(issued.length);
    });

    it("follows Azure SQL's redirection and signs in again on the server it names, with a new token", async () => {
        const node = await startServer({ identity: { serverName: "the-node" } });
        server.redirectTo = { host: HOST, port: node.port };
        const issued: string[] = [];
        const getAccessToken = async () => {
            issued.push(forgeAccessToken());
            return issued.at(-1)!;
        };

        const connection = await connect({
            options: options({ authenticationType: "AzureMFA", database: "sales" }),
            getAccessToken,
            entraAllowedServers: [HOST],
        });

        // Every login goes through the gateway first, then to the node, where the queries run.
        expect(node.logins.length).toBe(server.logins.length);
        expect(node.logins.at(-1)).toMatchObject({
            encrypted: true,
            database: "sales",
            accepted: true,
        });
        expect(node.logins.at(-1)!.requests.some((sql) => sql.includes("SERVERPROPERTY"))).toBe(
            true,
        );
        expect(server.logins.flatMap((login) => login.requests)).toEqual([]);
        expect(connection.serverInfo.userName).toBe("someone@contoso.com");
        expect([...server.tokens, ...node.tokens].sort()).toEqual([...issued].sort());
        expect(new Set(issued).size).toBe(issued.length);
    });

    it("sends no token to a redirection target that does not encrypt the connection", async () => {
        const node = await startServer({ encryption: "notSupported" });
        server.redirectTo = { host: HOST, port: node.port };

        const attempt = mssqlDriver.connect({
            options: options({ authenticationType: "AzureMFA" }),
            getAccessToken: async () => forgeAccessToken(),
            entraAllowedServers: [HOST],
        });

        await expect(attempt).rejects.toThrow(
            /does not support encryption.*The login was not sent/,
        );
        expect(node.logins).toEqual([]);
        expect(node.tokens).toEqual([]);
    });

    // tls.setDefaultCACertificates: Node.js 22.19 / 24.5 and later.
    it.runIf(typeof tls.setDefaultCACertificates === "function")(
        "does the same when TLS comes first (encrypt: Strict, TDS 8.0)",
        async () => {
            const token = forgeAccessToken();
            const getAccessToken = vi.fn(async () => token);
            const params = {
                options: options({ authenticationType: "AzureMFA", encrypt: "Strict" }),
                getAccessToken,
                entraAllowedServers: [HOST],
            };

            // Strict always checks the certificate, whatever trustServerCertificate says.
            await expect(mssqlDriver.connect(params)).rejects.toThrow(/self-signed certificate/);
            expect(getAccessToken).not.toHaveBeenCalled();

            const trusted = tls.getCACertificates("default");
            tls.setDefaultCACertificates([...trusted, server.certificate]);
            try {
                await connect(params);
            } finally {
                tls.setDefaultCACertificates(trusted);
            }
            expect(server.logins.length).toBeGreaterThan(0);
            for (const login of server.logins) {
                expect(login).toMatchObject({
                    encrypted: true,
                    tlsFirst: true,
                    fedAuth: { library: "MSAL" },
                    token,
                });
            }
        },
    );

    it("asks for the audience the server announces, as on the sovereign clouds", async () => {
        const usGovernment = await startServer({ spn: "https://database.usgovcloudapi.net/" });
        const getAccessToken = vi.fn(async () => forgeAccessToken());

        await connect({
            options: options({ authenticationType: "AzureMFA" }, usGovernment),
            getAccessToken,
            entraAllowedServers: [HOST],
        });

        expect(getAccessToken).toHaveBeenCalledWith("https://database.usgovcloudapi.net/.default");
    });

    it("explains a token the server refuses, such as an expired one", async () => {
        const expired = forgeAccessToken({}, -600);
        server.rejectToken = (token) =>
            token === expired
                ? "Login failed for user '<token-identified principal>'. Token is expired."
                : undefined;
        const params = (database?: string) => ({
            options: options({ authenticationType: "AzureMFA", ...(database ? { database } : {}) }),
            getAccessToken: async () => expired,
            entraAllowedServers: [HOST],
        });

        await expect(mssqlDriver.connect(params("sales"))).rejects.toThrow(
            new Error(
                `Cannot connect to ${HOST},${server.port}: Login failed for user '<token-identified principal>'. Token is expired.`,
            ),
        );
        // Without a database, the usual cause is a user that exists in one database only.
        await expect(mssqlDriver.connect(params())).rejects.toThrow(
            /Token is expired\. If this account is a user of a single database, enter that database in the connection\.$/,
        );
    });

    it("explains that the sign-in failed when VS Code gives no token", async () => {
        const attempt = mssqlDriver.connect({
            options: options({ authenticationType: "AzureMFA" }),
            getAccessToken: async () => {
                throw new Error(
                    "The Microsoft account someone@contoso.com is not signed in to VS Code.",
                );
            },
            entraAllowedServers: [HOST],
        });

        await expect(attempt).rejects.toThrow(
            `Cannot connect to ${HOST},${server.port}: Security token could not be authenticated or authorized.; The Microsoft account someone@contoso.com is not signed in to VS Code.`,
        );
        expect(server.tokens).toEqual([]);
    });

    it("refuses a server that is neither Azure's nor allowed by the user, before asking for any token", async () => {
        const getAccessToken = vi.fn(async () => forgeAccessToken());
        const params = { options: options({ authenticationType: "AzureMFA" }), getAccessToken };

        await expect(mssqlDriver.connect(params)).rejects.toThrow(/yast\.entraId\.allowedServers/);
        await expect(
            mssqlDriver.connect({
                ...params,
                entraAllowedServers: ["localhost", ".corp.example.com"],
            }),
        ).rejects.toThrow(`To use it with "${HOST}"`);

        expect(getAccessToken).not.toHaveBeenCalled();
        // Not even a connection attempt.
        expect(server.logins).toEqual([]);
    });

    it("asks for no token when the server's certificate is not trusted", async () => {
        const getAccessToken = vi.fn(async () => forgeAccessToken());

        const attempt = mssqlDriver.connect({
            options: options({ authenticationType: "AzureMFA", trustServerCertificate: false }),
            getAccessToken,
            entraAllowedServers: [HOST],
        });

        await expect(attempt).rejects.toThrow(/self-signed certificate/);
        expect(getAccessToken).not.toHaveBeenCalled();
        expect(server.logins).toEqual([]);
    });

    it("sends no token on a connection the server did not encrypt", async () => {
        // What someone sitting between the client and the server can answer in its place: the
        // negotiation of encryption happens in clear text, before TLS.
        const withoutTls = await startServer({ encryption: "notSupported" });
        const getAccessToken = vi.fn(async () => forgeAccessToken());

        for (const encrypt of ["Mandatory", "Optional"]) {
            const attempt = mssqlDriver.connect({
                options: options({ authenticationType: "AzureMFA", encrypt }, withoutTls),
                getAccessToken,
                entraAllowedServers: [HOST],
            });
            const message =
                encrypt === "Mandatory"
                    ? /does not support encryption.*The login was not sent/
                    : /did not encrypt the connection/;
            await expect(attempt, encrypt).rejects.toThrow(message);
        }

        expect(getAccessToken).not.toHaveBeenCalled();
        expect(withoutTls.logins.length).toBeGreaterThan(0);
        expect(withoutTls.tokens).toEqual([]);
    });
});

describe("SQL Server through the connector, with VS Code's account provider", () => {
    const account = {
        id: "33333333-3333-4333-8333-333333333333.11111111-1111-4111-8111-111111111111",
        label: "someone@contoso.com",
    };
    const tenantId = "55555555-5555-4555-8555-555555555555";
    const profile = () =>
        ({
            id: "entra-mssql",
            ...options({ authenticationType: "AzureMFA" }),
            user: account.label,
            accountId: account.id,
            tenantId,
        }) as unknown as IConnectionProfile;

    it("sends the token VS Code gives for the profile's account and tenant", async () => {
        const token = forgeAccessToken({ upn: account.label, tid: tenantId });
        setAllowedServersSetting([HOST]);
        vi.mocked(vscode.authentication.getAccounts).mockResolvedValue([account]);
        vi.mocked(vscode.authentication.getSession).mockResolvedValue({
            accessToken: token,
        } as never);

        connections.push(await openConnection(profile()));

        expect(server.tokens).toEqual([token, token]);
        const request = [
            "microsoft",
            [AZURE_SQL_SCOPE, `VSCODE_TENANT:${tenantId}`],
            { account, silent: true },
        ];
        expect(vi.mocked(vscode.authentication.getSession).mock.calls).toEqual([request, request]);
    });

    it("does not ask VS Code for a token when the server is not in yast.entraId.allowedServers", async () => {
        vi.mocked(vscode.authentication.getAccounts).mockResolvedValue([account]);

        await expect(new Connector().connect(profile())).rejects.toThrow(
            /yast\.entraId\.allowedServers/,
        );

        expect(vscode.authentication.getAccounts).not.toHaveBeenCalled();
        expect(vscode.authentication.getSession).not.toHaveBeenCalled();
        expect(server.logins).toEqual([]);
    });
});

describe("SQL Server with the identity of the machine (Default)", () => {
    let endpoint: ManagedIdentityEndpoint;
    beforeAll(async () => {
        endpoint = await startManagedIdentityEndpoint();
    });
    afterAll(() => endpoint.stop());
    beforeEach(() => {
        endpoint.requests.length = 0;
    });

    // First of this group: once a token is kept, the following logins without a client ID reuse it.
    it("asks no token for a server that is not allowed", async () => {
        await expect(
            mssqlDriver.connect({
                options: options({ authenticationType: "ActiveDirectoryDefault" }),
            }),
        ).rejects.toThrow(/yast\.entraId\.allowedServers/);

        expect(endpoint.requests).toEqual([]);
        expect(server.logins).toEqual([]);
    });

    it("sends the token of the managed identity, asked once and kept while it is valid", async () => {
        const token = forgeAccessToken({ appid: "99999999-9999-4999-8999-999999999999" });
        endpoint.issue = () => token;
        const params = {
            options: options({ authenticationType: "ActiveDirectoryDefault" }),
            entraAllowedServers: [HOST],
        };

        await connect(params);
        await connect(params);

        expect(server.logins).toHaveLength(4);
        expect(server.tokens).toEqual([token, token, token, token]);
        expect(endpoint.requests).toEqual([
            { resource: "https://database.windows.net", clientId: undefined },
        ]);
        expect(server.logins[0]).toMatchObject({
            encrypted: true,
            userName: "",
            hasPassword: false,
            fedAuth: { library: "MSAL" },
        });
    });

    it("picks the user-assigned managed identity whose client ID is typed as the user", async () => {
        const clientId = "99999999-9999-4999-8999-999999999999";
        const token = forgeAccessToken({ appid: clientId });
        endpoint.issue = () => token;

        await connect({
            options: options({ authenticationType: "ActiveDirectoryDefault", user: clientId }),
            entraAllowedServers: [HOST],
        });

        expect(server.tokens).toEqual([token, token]);
        expect(endpoint.requests).toEqual([{ resource: "https://database.windows.net", clientId }]);
        // The client ID picks the identity; it is not a login name.
        expect(server.logins[0]).toMatchObject({ userName: "", hasPassword: false });
    });
});

describe("SQL Server with a service principal", () => {
    // A new application for every test: credentials are kept for the session, by client ID.
    let clientId: string;
    beforeEach(() => {
        clientId = randomUUID();
    });
    const profile = (overrides: Record<string, string> = {}) =>
        ({
            id: "entra-mssql-app",
            ...options({ authenticationType: "ActiveDirectoryServicePrincipal" }),
            // For SQL Server the client ID is typed as the user.
            user: clientId,
            tenantId: "55555555-5555-4555-8555-555555555555",
            password: "the-client-secret",
            ...overrides,
        }) as unknown as IConnectionProfile;

    it("sends the token obtained from the application's client ID, tenant and secret", async () => {
        const token = forgeAccessToken({ appid: clientId });
        FakeClientSecretCredential.issue = () => token;
        setAllowedServersSetting([HOST]);

        connections.push((await new Connector().connect(profile()))!);

        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
        expect(FakeClientSecretCredential.created).toHaveLength(1);
        expect(FakeClientSecretCredential.created[0]).toMatchObject({
            tenantId: "55555555-5555-4555-8555-555555555555",
            clientId,
            clientSecret: "the-client-secret",
            // Asked once: the token is kept for the following logins while it is valid.
            scopes: [AZURE_SQL_SCOPE],
        });
        expect(server.tokens).toEqual([token, token]);
        // The client ID and the secret go to Microsoft's sign-in service only, never to the database server.
        expect(server.logins[0]).toMatchObject({
            encrypted: true,
            userName: "",
            hasPassword: false,
            fedAuth: { library: "MSAL" },
        });
    });

    it("asks no token for a server that is not allowed", async () => {
        await expect(new Connector().connect(profile())).rejects.toThrow(
            /yast\.entraId\.allowedServers/,
        );

        expect(FakeClientSecretCredential.created).toEqual([]);
        expect(server.logins).toEqual([]);
    });

    it("explains a secret that Microsoft refuses", async () => {
        FakeClientSecretCredential.issue = () => {
            throw new Error("AADSTS7000215: Invalid client secret provided.");
        };
        setAllowedServersSetting([HOST]);

        const attempt = new Connector().connect(profile({ password: "a-wrong-secret" }));

        await expect(attempt).rejects.toThrow(
            `Cannot connect to ${HOST},${server.port}: Security token could not be authenticated or authorized.; AADSTS7000215: Invalid client secret provided.`,
        );
        expect(server.tokens).toEqual([]);
    });
});
