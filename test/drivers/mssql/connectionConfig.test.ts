import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import {
    buildSqlConfig,
    parseServer,
    tokenExpiration,
} from "../../../src/drivers/mssql/connectionConfig";
import { withTokenCache } from "../../../src/drivers/entraCredentials";

describe("getConnectionOptions", () => {
    const reference = JSON.parse(
        readFileSync(resolve(__dirname, "../../../docs/reference/mssql-capabilities.json"), "utf8"),
    ).capabilities.connectionProvider;

    it("returns Microsoft's options in the same order, with the same names, groups and display names", () => {
        const options = mssqlDriver.getConnectionOptions();
        const summary = (list: { name: string; groupName: string; displayName: string }[]) =>
            list.map((o) => [o.name, o.groupName, o.displayName]);
        expect(summary(options.options)).toEqual(summary(reference.options));
        expect(options.groupDisplayNames).toEqual(reference.groupDisplayNames);
    });

    it("only offers the methods we implement, keeping their display names", () => {
        const authentication = mssqlDriver
            .getConnectionOptions()
            .options.find((o) => o.name === "authenticationType");
        expect(authentication?.categoryValues).toEqual([
            { displayName: "SQL Login", name: "SqlLogin" },
            { displayName: "Windows Authentication", name: "Integrated" },
            { displayName: "Microsoft Entra ID - Universal with MFA support", name: "AzureMFA" },
            { displayName: "Microsoft Entra ID - Default", name: "ActiveDirectoryDefault" },
            {
                displayName: "Microsoft Entra ID - Service Principal",
                name: "ActiveDirectoryServicePrincipal",
            },
        ]);
    });

    it("returns a copy that callers can modify freely", () => {
        mssqlDriver.getConnectionOptions().options.length = 0;
        expect(mssqlDriver.getConnectionOptions().options.length).toBeGreaterThan(0);
    });
});

describe("parseServer", () => {
    it("understands host, host,port, tcp: prefix and instance names", () => {
        expect(parseServer("localhost")).toMatchObject({
            host: "localhost",
            port: undefined,
            displayName: "localhost",
        });
        expect(parseServer("localhost,11433")).toMatchObject({
            host: "localhost",
            port: 11433,
            displayName: "localhost,11433",
        });
        expect(parseServer("tcp:db.example.com,1444")).toMatchObject({
            host: "db.example.com",
            port: 1444,
        });
        expect(parseServer("host\\SQLEXPRESS")).toMatchObject({
            host: "host",
            instanceName: "SQLEXPRESS",
        });
    });

    it("uses the port option when the server text has none", () => {
        expect(parseServer("localhost", 1500)).toMatchObject({
            host: "localhost",
            port: 1500,
            displayName: "localhost,1500",
        });
        expect(parseServer("localhost,1433", 1500)).toMatchObject({
            port: 1433,
            displayName: "localhost,1433",
        });
    });
});

describe("buildSqlConfig", () => {
    const base = {
        server: "localhost,11433",
        authenticationType: "SqlLogin",
        user: "sa",
        password: "pw",
    };

    it("maps SQL login options", () => {
        const config = buildSqlConfig({
            ...base,
            database: "yast",
            applicationName: "app",
            trustServerCertificate: true,
            applicationIntent: "ReadOnly",
            multiSubnetFailover: true,
        });
        expect(config).toMatchObject({
            server: "localhost",
            port: 11433,
            database: "yast",
            user: "sa",
            password: "pw",
        });
        expect(config.options).toMatchObject({
            appName: "app",
            trustServerCertificate: true,
            readOnlyIntent: true,
            multiSubnetFailover: true,
        });
    });

    it("maps encrypt: Optional / Mandatory / Strict", () => {
        expect(buildSqlConfig({ ...base, encrypt: "Optional" }).options?.encrypt).toBe(false);
        expect(buildSqlConfig({ ...base, encrypt: "Mandatory" }).options?.encrypt).toBe(true);
        expect(buildSqlConfig({ ...base, encrypt: "Strict" }).options?.encrypt).toBe("strict");
        expect(buildSqlConfig(base).options?.encrypt).toBe(true);
    });

    it("converts timeouts from seconds to milliseconds, 0 meaning no command timeout", () => {
        const config = buildSqlConfig({ ...base, connectTimeout: 15, commandTimeout: 60 });
        expect(config.connectionTimeout).toBe(15000);
        expect(config.requestTimeout).toBe(60000);
        expect(buildSqlConfig({ ...base, commandTimeout: 0 }).requestTimeout).toBe(0);
        expect(buildSqlConfig(base)).toMatchObject({
            connectionTimeout: 30000,
            requestTimeout: 30000,
        });
    });

    it("uses exactly one connection that is never closed while idle", () => {
        const pool = buildSqlConfig(base).pool;
        expect(pool).toMatchObject({ min: 1, max: 1 });
        expect(pool?.idleTimeoutMillis).toBeGreaterThan(24 * 3600 * 1000);
    });

    it("asks the token provider on every login for AzureMFA", async () => {
        const scopes: string[] = [];
        const config = buildSqlConfig(
            { server: "x.database.windows.net", authenticationType: "AzureMFA", user: "me@x.com" },
            async (scope) => {
                scopes.push(scope);
                return "TOKEN";
            },
        );
        expect(config.authentication?.type).toBe("token-credential");
        const credential = (
            config.authentication?.options as {
                credential: { getToken(scope: string): Promise<{ token: string }> };
            }
        ).credential;
        await expect(
            credential.getToken("https://database.windows.net/.default"),
        ).resolves.toMatchObject({ token: "TOKEN" });
        await credential.getToken("https://database.windows.net/.default");
        expect(scopes).toHaveLength(2);
        expect(config.user).toBeUndefined();
        expect(config.password).toBeUndefined();
        expect(() =>
            buildSqlConfig({ server: "x.database.windows.net", authenticationType: "AzureMFA" }),
        ).toThrow(/access token provider/);
    });

    it("uses a shared credential for ActiveDirectoryDefault and service principals", () => {
        const defaultConfig = buildSqlConfig({
            server: "x.database.windows.net",
            authenticationType: "ActiveDirectoryDefault",
        });
        expect(defaultConfig.authentication?.type).toBe("token-credential");
        const credentialOf = (config: ReturnType<typeof buildSqlConfig>) =>
            (config.authentication?.options as { credential: unknown }).credential;
        // Kept for the session: the next login reuses its token instead of walking the chain again.
        expect(
            credentialOf(
                buildSqlConfig({
                    server: "y.database.windows.net",
                    authenticationType: "ActiveDirectoryDefault",
                }),
            ),
        ).toBe(credentialOf(defaultConfig));

        const sp = {
            server: "x.database.windows.net",
            authenticationType: "ActiveDirectoryServicePrincipal",
            user: "app-id",
            password: "secret",
            tenantId: "tenant",
        };
        expect(buildSqlConfig(sp).authentication?.type).toBe("token-credential");
        expect(credentialOf(buildSqlConfig({ ...sp, password: "other" }))).not.toBe(
            credentialOf(buildSqlConfig(sp)),
        );
        expect(buildSqlConfig(sp).user).toBeUndefined();
        expect(() => buildSqlConfig({ ...sp, tenantId: undefined })).toThrow(/tenant/);
    });

    it("sends Entra ID tokens only to Azure servers or to the servers the user allows", () => {
        const mfa = { authenticationType: "AzureMFA" };
        const token = async () => "TOKEN";
        for (const server of [
            "tcp:x.database.windows.net,1433",
            "X.Database.Windows.Net.",
            "x.sql.azuresynapse.net",
            "x.database.usgovcloudapi.net",
        ]) {
            expect(() => buildSqlConfig({ ...mfa, server }, token)).not.toThrow();
        }
        for (const authenticationType of [
            "AzureMFA",
            "ActiveDirectoryDefault",
            "ActiveDirectoryServicePrincipal",
        ]) {
            for (const server of [
                "localhost",
                "evil.example.com",
                "x.database.windows.net.evil.com",
                "evildatabase.windows.net",
            ]) {
                const options = {
                    server,
                    authenticationType,
                    user: "app-id",
                    password: "secret",
                    tenantId: "tenant",
                };
                expect(
                    () => buildSqlConfig(options, token),
                    `${authenticationType} to ${server}`,
                ).toThrow(/yast\.entraId\.allowedServers/);
            }
        }
        expect(() =>
            buildSqlConfig({ ...mfa, server: "localhost,1433" }, token, ["LocalHost"]),
        ).not.toThrow();
        expect(() =>
            buildSqlConfig({ ...mfa, server: "sql.corp.example.com" }, token, [
                ".corp.example.com",
            ]),
        ).not.toThrow();
        expect(() =>
            buildSqlConfig({ ...mfa, server: "corp.example.com.evil.com" }, token, [
                ".corp.example.com",
            ]),
        ).toThrow();
        // SQL logins are not concerned.
        expect(() =>
            buildSqlConfig({ server: "localhost", authenticationType: "SqlLogin", user: "sa" }),
        ).not.toThrow();
    });

    it("reuses a token until shortly before it expires", async () => {
        let calls = 0;
        const credential = withTokenCache({
            async getToken() {
                calls++;
                return { token: `T${calls}`, expiresOnTimestamp: Date.now() + 60 * 60 * 1000 };
            },
        });
        await credential.getToken("scope");
        await expect(credential.getToken("scope")).resolves.toMatchObject({ token: "T1" });
        expect(calls).toBe(1);
        // A token about to expire is refreshed.
        const soon = withTokenCache({
            async getToken() {
                calls++;
                return { token: `T${calls}`, expiresOnTimestamp: Date.now() + 1000 };
            },
        });
        await soon.getToken("scope");
        await soon.getToken("scope");
        expect(calls).toBe(3);
    });

    it("reads the expiry of a JWT access token", () => {
        const jwt = [
            "header",
            Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url"),
            "sig",
        ].join(".");
        expect(tokenExpiration(jwt)).toBe(1_800_000_000_000);
        expect(tokenExpiration("not-a-jwt")).toBeGreaterThan(Date.now());
    });
});
