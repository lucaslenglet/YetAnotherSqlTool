import { describe, expect, it } from "vitest";
import { entraUserName, resolveOptions } from "../../src/drivers/pg/clients";

const jwt = (claims: object) =>
    ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("entraUserName", () => {
    it("takes the sign-in name from an Entra access token", () => {
        expect(entraUserName(jwt({ upn: "me@contoso.com", preferred_username: "other" }))).toBe(
            "me@contoso.com",
        );
        // Guest accounts have no upn.
        expect(entraUserName(jwt({ preferred_username: "guest@fabrikam.com" }))).toBe(
            "guest@fabrikam.com",
        );
        expect(entraUserName("not-a-jwt")).toBeUndefined();
    });
});

describe("resolveOptions with Microsoft Entra ID", () => {
    const server = "x.postgres.database.azure.com";

    it("uses no token for SQL logins", () => {
        expect(
            resolveOptions({ options: { server, authenticationType: "SqlLogin", user: "u" } })
                .getEntraToken,
        ).toBeUndefined();
    });

    it("gets tokens from VS Code, the machine or a service principal, always over TLS", () => {
        const mfa = resolveOptions({
            options: { server, authenticationType: "AzureMFA" },
            getAccessToken: async () => "T",
        });
        const machine = resolveOptions({
            options: { server, authenticationType: "ActiveDirectoryDefault" },
        });
        const app = resolveOptions({
            options: {
                server,
                authenticationType: "ActiveDirectoryServicePrincipal",
                user: "my-app",
                clientId: "app-id",
                password: "secret",
                tenantId: "tenant",
            },
        });
        for (const options of [mfa, machine, app]) {
            expect(options.getEntraToken).toBeTypeOf("function");
            expect(options.sslMode).toBe("require");
        }
        expect(() =>
            resolveOptions({ options: { server, authenticationType: "AzureMFA" } }),
        ).toThrow(/access token provider/);
    });

    it("never goes below TLS for a token, and keeps the certificate checks the user asked for", () => {
        const sslModeFor = (sslmode: string) =>
            resolveOptions({
                options: { server, authenticationType: "AzureMFA", sslmode },
                getAccessToken: async () => "T",
            }).sslMode;
        for (const sslmode of ["disable", "allow", "prefer", "require", ""])
            expect(sslModeFor(sslmode), sslmode).toBe("require");
        expect(sslModeFor("verify-ca")).toBe("verify-ca");
        expect(sslModeFor("verify-full")).toBe("verify-full");
    });

    it("sends Entra ID tokens only to Azure servers or to the servers the user allows", () => {
        const mfa = { authenticationType: "AzureMFA" };
        const getAccessToken = async () => "T";
        expect(() =>
            resolveOptions({
                options: { ...mfa, server: "x.postgres.cosmos.azure.com" },
                getAccessToken,
            }),
        ).not.toThrow();
        for (const authenticationType of [
            "AzureMFA",
            "ActiveDirectoryDefault",
            "ActiveDirectoryServicePrincipal",
        ]) {
            const options = {
                server: "evil.example.com",
                authenticationType,
                user: "my-app",
                clientId: "app-id",
                password: "secret",
                tenantId: "tenant",
            };
            expect(() => resolveOptions({ options, getAccessToken }), authenticationType).toThrow(
                /yast\.entraId\.allowedServers/,
            );
        }
        expect(() =>
            resolveOptions({
                options: { ...mfa, server: "localhost" },
                getAccessToken,
                entraAllowedServers: ["localhost"],
            }),
        ).not.toThrow();
        expect(() =>
            resolveOptions({
                options: { server: "localhost", authenticationType: "SqlLogin", user: "u" },
            }),
        ).not.toThrow();
    });

    it("requires the role, client ID and tenant of a service principal", () => {
        const sp = {
            server,
            authenticationType: "ActiveDirectoryServicePrincipal",
            user: "my-app",
            clientId: "app-id",
            password: "secret",
            tenantId: "tenant",
        };
        expect(() => resolveOptions({ options: { ...sp, user: "" } })).toThrow(/role/);
        expect(() => resolveOptions({ options: { ...sp, clientId: "" } })).toThrow(/Client\) ID/);
        expect(() => resolveOptions({ options: { ...sp, tenantId: undefined } })).toThrow(/tenant/);
    });
});
