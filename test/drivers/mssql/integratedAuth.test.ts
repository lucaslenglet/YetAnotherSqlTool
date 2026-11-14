import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { assertSupportedAuthenticationType } from "../../../src/drivers/mssql/connectionOptions";
import { pgDriver } from "../../../src/drivers/pg";

// "Integrated" (Windows Authentication) is NTLM with a typed DOMAIN\user and password: it is
// offered and accepted (see windowsAuth.test.ts for the handshake). The authentication types that
// remain unsupported must still fail clearly, and the dialog and the settings schema must agree
// with the driver.
describe("authentication types", () => {
    const supported = [
        "SqlLogin",
        "Integrated",
        "AzureMFA",
        "ActiveDirectoryDefault",
        "ActiveDirectoryServicePrincipal",
    ];

    it("accepts the implemented types, and no type at all as SQL Login", () => {
        for (const authenticationType of [...supported, undefined, null, ""]) {
            expect(
                () => assertSupportedAuthenticationType(authenticationType),
                String(authenticationType),
            ).not.toThrow();
        }
    });

    it("names the unsupported Entra ID methods and the alternatives", () => {
        expect(() => assertSupportedAuthenticationType("ActiveDirectoryIntegrated")).toThrow(
            "Authentication type 'ActiveDirectoryIntegrated' is not supported yet. Use one of: SQL Login, " +
                "Windows Authentication, Microsoft Entra ID - Universal with MFA support, Microsoft Entra ID - Default, Microsoft Entra ID - Service Principal.",
        );
    });

    it("rejects the other types a connection string can carry", () => {
        const { authenticationType } = mssqlDriver.parseConnectionString(
            "Server=h;Authentication=Active Directory Password;User Id=u;Password=p",
        );
        expect(authenticationType).toBe("ActiveDirectoryPassword");
        expect(() => assertSupportedAuthenticationType(authenticationType)).toThrow(
            /^Authentication type 'ActiveDirectoryPassword' is not supported yet\./,
        );
    });

    it("fails before any network access when the account is missing", async () => {
        const options = mssqlDriver.parseConnectionString(
            "Server=host.invalid;Integrated Security=True",
        );
        expect(options.authenticationType).toBe("Integrated");
        await expect(mssqlDriver.connect({ options })).rejects.toThrow(
            /Windows Authentication needs a user name such as DOMAIN\\user and its password: signing in with the current Windows session is not supported/,
        );
    });

    it("is offered by the connection dialog for SQL Server only, and by the settings schema", () => {
        const offered = (driver: typeof mssqlDriver) =>
            driver
                .getConnectionOptions()
                .options.find((option) => option.name === "authenticationType")
                ?.categoryValues.map((value) => value.name);
        expect(offered(mssqlDriver)).toEqual(supported);
        expect(offered(pgDriver)).not.toContain("Integrated");
        expect(
            mssqlDriver
                .getConnectionOptions()
                .options.find((option) => option.name === "authenticationType")
                ?.categoryValues.find((value) => value.name === "Integrated")?.displayName,
        ).toBe("Windows Authentication");

        const manifest = JSON.parse(
            readFileSync(resolve(__dirname, "../../../package.json"), "utf8"),
        );
        const schema =
            manifest.contributes.configuration.properties["yast.connections"].items.properties
                .authenticationType;
        expect(schema.enum).toEqual(supported);
    });
});
