import * as tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { buildSqlConfig } from "../../../src/drivers/mssql/connectionConfig";
import {
    parseWindowsUserName,
    WINDOWS_AUTHENTICATION_NEEDS_PASSWORD,
    WINDOWS_AUTHENTICATION_NEEDS_USER,
} from "../../../src/drivers/mssql/windowsAuthentication";
import type { DriverConnection } from "../../../src/drivers/types";
import { FakeTdsServer } from "../../support/fakeTdsServer";
import { md4, ntlmV2Proof, ntowfV2 } from "../../support/ntlm";

// Windows Authentication ("Integrated") is NTLM with a domain, user name and password typed by
// the user. No Active Directory is needed here: the real driver (mssql + tedious) logs in to
// test/support/fakeTdsServer.ts, which plays SQL Server's side of the NTLM handshake and records
// what the client sent. test/support/ntlm.ts computes the expected NTLMv2 response from the
// specification, independently of tedious.

const HOST = "127.0.0.1";
const servers: FakeTdsServer[] = [];
const connections: DriverConnection[] = [];

async function startServer(): Promise<FakeTdsServer> {
    const started = await new FakeTdsServer({
        identity: { serverName: "SQLHOST", edition: "Developer Edition", engineEdition: 3 },
    }).start();
    started.windowsLogins.set("CORP\\alice", "P@ss w0rd!é");
    servers.push(started);
    return started;
}

function options(server: FakeTdsServer, overrides: Record<string, string | number | boolean> = {}) {
    return {
        server: `${HOST},${server.port}`,
        authenticationType: "Integrated",
        user: "CORP\\alice",
        password: "P@ss w0rd!é",
        trustServerCertificate: true,
        connectTimeout: 5,
        ...overrides,
    };
}

async function connect(
    server: FakeTdsServer,
    overrides: Record<string, string | number | boolean> = {},
): Promise<DriverConnection> {
    const connection = await mssqlDriver.connect({ options: options(server, overrides) });
    connections.push(connection);
    return connection;
}

afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()));
    await Promise.all(servers.splice(0).map((started) => started.stop()));
});

describe("the NTLM primitives of the test support (MS-NLMP test vectors)", () => {
    it("MD4 matches RFC 1320", () => {
        expect(md4(Buffer.alloc(0)).toString("hex")).toBe("31d6cfe0d16ae931b73c59d7e0c089c0");
        expect(md4(Buffer.from("abc")).toString("hex")).toBe("a448017aaf21d8525fc10ae87aa6729d");
        expect(
            md4(
                Buffer.from(
                    "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
                ),
            ).toString("hex"),
        ).toBe("e33b4ddc9c38f2199c3e7b164fcc0536");
    });

    it("NTOWFv2 and NTProofStr match MS-NLMP 4.2.4", () => {
        expect(ntowfV2("Password", "User", "Domain").toString("hex")).toBe(
            "0c868a403bfd7a93a3001ef22ef02e3f",
        );
        const pairs = Buffer.from(
            "0200" +
                "0c00" +
                Buffer.from("Domain", "ucs2").toString("hex") +
                "0100" +
                "0c00" +
                Buffer.from("Server", "ucs2").toString("hex") +
                "00000000",
            "hex",
        );
        const temp = Buffer.concat([
            Buffer.from(
                "0101000000000000" + "0000000000000000" + "aaaaaaaaaaaaaaaa" + "00000000",
                "hex",
            ),
            pairs,
            Buffer.alloc(4),
        ]);
        expect(
            ntlmV2Proof(
                "Password",
                "User",
                "Domain",
                Buffer.from("0123456789abcdef", "hex"),
                temp,
            ).toString("hex"),
        ).toBe("68cd0ab851e51c96aabc927bebef6a1c");
    });
});

describe("Windows user names", () => {
    it("splits DOMAIN\\user into the domain and the user name", () => {
        expect(parseWindowsUserName("CORP\\alice")).toEqual({ domain: "CORP", userName: "alice" });
        expect(parseWindowsUserName("  corp.example.com\\Alice Smith ")).toEqual({
            domain: "corp.example.com",
            userName: "Alice Smith",
        });
    });

    it("sends a user principal name whole, with no domain", () => {
        expect(parseWindowsUserName("alice@corp.example.com")).toEqual({
            domain: "",
            userName: "alice@corp.example.com",
        });
    });

    it("explains what is expected when there is no user or no domain", () => {
        for (const missing of [undefined, null, "", "   ", 42]) {
            expect(() => parseWindowsUserName(missing), String(missing)).toThrow(
                WINDOWS_AUTHENTICATION_NEEDS_USER,
            );
        }
        for (const typed of ["alice", "\\alice", "CORP\\", "a\\b\\c", "@corp.com", "alice@"]) {
            expect(() => parseWindowsUserName(typed), typed).toThrow(
                /is not a Windows account name\. Windows Authentication expects the domain and the user name, as DOMAIN\\user/,
            );
        }
        expect(WINDOWS_AUTHENTICATION_NEEDS_USER).toMatch(
            /DOMAIN\\user.*current Windows session is not supported/,
        );
    });
});

describe("tedious configuration for Windows Authentication", () => {
    const base = { server: "h", authenticationType: "Integrated" };

    it("is NTLM, with no SQL login and no token", () => {
        const config = buildSqlConfig({ ...base, user: "CORP\\alice", password: "pw" });
        expect(config.authentication).toEqual({
            type: "ntlm",
            options: { domain: "CORP", userName: "alice", password: "pw" },
        });
        expect(config.user).toBeUndefined();
        expect(config.password).toBeUndefined();
    });

    it("keeps an empty password the user chose, and refuses a missing one", () => {
        expect(
            buildSqlConfig({ ...base, user: "CORP\\alice", password: "" }).authentication,
        ).toMatchObject({
            options: { password: "" },
        });
        expect(() => buildSqlConfig({ ...base, user: "CORP\\alice" })).toThrow(
            WINDOWS_AUTHENTICATION_NEEDS_PASSWORD,
        );
    });

    it("fails before any network access, with a readable message", async () => {
        const connecting = mssqlDriver.connect({
            options: { server: "host.invalid", authenticationType: "Integrated", password: "x" },
        });
        await expect(connecting).rejects.toThrow(WINDOWS_AUTHENTICATION_NEEDS_USER);
        await expect(
            mssqlDriver.connect({
                options: {
                    server: "host.invalid",
                    authenticationType: "Integrated",
                    user: "alice",
                    password: "x",
                },
            }),
        ).rejects.toThrow(/expects the domain and the user name, as DOMAIN\\user/);
    });
});

describe("Windows Authentication handshake with a SQL Server stand-in", () => {
    it("sends the domain and user name, and the right NTLMv2 response", async () => {
        const server = await startServer();

        const connection = await connect(server);

        const login = server.logins.at(-1)!;
        expect(login.accepted).toBe(true);
        // NEGOTIATE (in LOGIN7's SSPI field): the domain, upper case, in OEM characters.
        expect(login.ntlm?.negotiate.domain).toBe("CORP");
        // AUTHENTICATE: domain and user name in UTF-16.
        expect(login.ntlm?.authenticate).toMatchObject({ domain: "CORP", userName: "alice" });
        const { authenticate, serverChallenge } = login.ntlm!;
        // The response proves knowledge of the password for this very challenge: it is computed here
        // from the specification, not by the server stand-in's own check.
        expect(authenticate!.ntProof).toHaveLength(16);
        expect(
            authenticate!.ntProof.equals(
                ntlmV2Proof("P@ss w0rd!é", "alice", "CORP", serverChallenge, authenticate!.temp),
            ),
        ).toBe(true);
        expect(
            authenticate!.ntProof.equals(
                ntlmV2Proof("wrong", "alice", "CORP", serverChallenge, authenticate!.temp),
            ),
        ).toBe(false);
        // The temp structure carries the server's target information back.
        expect(authenticate!.temp.subarray(0, 8).toString("hex")).toBe("0101000000000000");
        expect(authenticate!.temp.includes(Buffer.from("SQLHOST", "ucs2"))).toBe(true);
        expect(login.ntlm?.proofValid).toBe(true);

        // The session works, and the server sees the Windows account.
        expect(connection.serverInfo.userName).toBe("CORP\\alice");
    });

    it("puts no SQL login in LOGIN7 and sends no token", async () => {
        const server = await startServer();

        await connect(server);

        const login = server.logins.at(-1)!;
        expect(login).toMatchObject({ userName: "", hasPassword: false, password: "" });
        expect(login.fedAuth).toBeUndefined();
        expect(login.token).toBeUndefined();
        // The password itself never travels: only the response derived from it.
        expect(JSON.stringify(login.ntlm?.authenticate)).not.toContain("w0rd");
    });

    it("negotiates encryption as the other authentication types do", async () => {
        const server = await startServer();

        await connect(server);
        expect(server.logins.at(-1)).toMatchObject({ encrypted: true, tdsVersion: "7.4" });
    });

    // tls.setDefaultCACertificates: Node.js 22.19 / 24.5 and later.
    it.runIf(typeof tls.setDefaultCACertificates === "function")(
        "does the same when TLS comes first (encrypt: Strict, TDS 8.0)",
        async () => {
            const server = await startServer();
            // Strict always checks the certificate, whatever trustServerCertificate says.
            await expect(connect(server, { encrypt: "Strict" })).rejects.toThrow(
                /self-signed certificate/,
            );
            expect(server.logins).toEqual([]);

            const trusted = tls.getCACertificates("default");
            tls.setDefaultCACertificates([...trusted, server.certificate]);
            try {
                await connect(server, { encrypt: "Strict" });
            } finally {
                tls.setDefaultCACertificates(trusted);
            }
            expect(server.logins.at(-1)).toMatchObject({
                encrypted: true,
                tlsFirst: true,
                accepted: true,
            });
            expect(server.logins.at(-1)?.ntlm?.proofValid).toBe(true);
        },
    );

    it("sends nothing to a server that does not encrypt, unless the connection says Encrypt: Optional", async () => {
        const server = await startServer();
        server.encryption = "notSupported";

        await expect(connect(server)).rejects.toThrow(/Nothing was sent/);
        expect(server.logins).toEqual([]);

        await connect(server, { encrypt: "Optional" });
        expect(server.logins.at(-1)).toMatchObject({ encrypted: false, accepted: true });
    });

    it("accepts a user principal name, sent whole with an empty domain", async () => {
        const server = await startServer();
        server.windowsLogins.set("alice@corp.example.com", "upn-secret");

        await connect(server, { user: "alice@corp.example.com", password: "upn-secret" });

        const login = server.logins.at(-1)!;
        expect(login.ntlm?.negotiate.domain).toBe("");
        expect(login.ntlm?.authenticate).toMatchObject({
            domain: "",
            userName: "alice@corp.example.com",
        });
        expect(login.accepted).toBe(true);
    });

    it("reads a wrong password as a login failure, with a readable error that explains the limits", async () => {
        const server = await startServer();

        const error = await connect(server, { password: "nope" }).catch((e: Error) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
            /^Cannot connect to 127\.0\.0\.1,\d+: Login failed for user 'CORP\\alice'\./,
        );
        expect((error as Error).message).toMatch(
            /NTLM with the user name and password entered \(DOMAIN\\user\)/,
        );
        expect((error as Error).message).toMatch(
            /Kerberos.*current Windows session, are not supported/,
        );
        expect(server.logins.at(-1)?.ntlm?.proofValid).toBe(false);
        expect(server.logins.at(-1)?.accepted).toBe(false);
    });

    it("refuses an unknown account, and still connects afterwards", async () => {
        const server = await startServer();

        await expect(connect(server, { user: "CORP\\bob", password: "x" })).rejects.toThrow(
            /Login failed for user 'CORP\\bob'/,
        );

        await expect(connect(server)).resolves.toBeDefined();
    });
});

describe("password-less requests of the shared helper", () => {
    it("keeps ntowfV2 upper-casing only the user name", () => {
        expect(ntowfV2("p", "alice", "CORP").equals(ntowfV2("p", "ALICE", "CORP"))).toBe(true);
        expect(ntowfV2("p", "alice", "CORP").equals(ntowfV2("p", "alice", "corp"))).toBe(false);
    });
});
