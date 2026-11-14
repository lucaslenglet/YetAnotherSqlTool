import { describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { connectToDocker, dockerOptions, runBatch } from "./helpers";

// SQL Server on Linux has no Active Directory domain: a Windows Authentication sign-in cannot
// succeed. What matters is that it fails cleanly, with a readable message, and that nothing is
// left in a bad state (the next connection works).

describe("Windows Authentication against SQL Server on Linux", () => {
    const windowsOptions = (overrides: Record<string, string | number | boolean> = {}) =>
        dockerOptions({
            authenticationType: "Integrated",
            user: "CORP\\alice",
            password: "not-a-domain-password",
            connectTimeout: 15,
            ...overrides,
        });

    it("fails with a readable error, without hanging", async () => {
        const error = await mssqlDriver.connect({ options: windowsOptions() }).then(
            () => undefined,
            (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toMatch(/^Cannot connect to /);
        expect(message).not.toMatch(/undefined|\[object Object\]/);
        // SQL Server's own answer: it read the NTLM message and found no such domain.
        expect(message).toMatch(/Login failed\. The login is from an untrusted domain/);
        // The explanation of what this kind of sign-in is, and is not.
        expect(message).toMatch(/NTLM with the user name and password entered \(DOMAIN\\user\)/);
        expect(message).toMatch(/Kerberos.*current Windows session, are not supported/);
    });

    it("fails the same way for a user principal name", async () => {
        await expect(
            mssqlDriver.connect({ options: windowsOptions({ user: "alice@corp.example.com" }) }),
        ).rejects.toThrow(/^Cannot connect to /);
    });

    it("leaves the driver usable: SQL Login still works afterwards", async () => {
        await expect(mssqlDriver.connect({ options: windowsOptions() })).rejects.toThrow();

        const connection = await connectToDocker();
        try {
            const events = await runBatch(connection, "SELECT 1 AS one");
            expect(events.some((event) => event.type === "rows")).toBe(true);
        } finally {
            await connection.close();
        }
    });

    it("does not leak an unhandled rejection", async () => {
        const unhandled: unknown[] = [];
        const listener = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", listener);
        try {
            await Promise.allSettled([
                mssqlDriver.connect({ options: windowsOptions() }),
                mssqlDriver.connect({ options: windowsOptions({ user: "CORP\\bob" }) }),
            ]);
            await new Promise((resolve) => setTimeout(resolve, 200));
        } finally {
            process.off("unhandledRejection", listener);
        }
        expect(unhandled).toEqual([]);
    });
});
