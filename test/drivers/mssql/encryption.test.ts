import { Connection as TediousConnection } from "tedious";
import { afterEach, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import type { DriverConnection } from "../../../src/drivers/types";
import { FakeTdsServer, type FakeTdsServerOptions } from "../../support/fakeTdsServer";

// "Encrypt: Mandatory" must hold against a server (or someone in between) that answers "encryption
// not supported": tedious would log in anyway, in clear text. The driver stops the login by
// wrapping a private method of tedious (protectLogin in src/drivers/mssql/connectionConfig.ts);
// these tests fail if a tedious upgrade removes that method or stops going through it.

const HOST = "127.0.0.1";
const servers: FakeTdsServer[] = [];
const connections: DriverConnection[] = [];

async function startServer(options?: FakeTdsServerOptions): Promise<FakeTdsServer> {
    const started = await new FakeTdsServer(options).start();
    started.sqlLogins.set("app", "secret");
    servers.push(started);
    return started;
}

function connect(server: FakeTdsServer, encrypt?: string): Promise<DriverConnection> {
    const options = {
        server: `${HOST},${server.port}`,
        authenticationType: "SqlLogin",
        user: "app",
        password: "secret",
        trustServerCertificate: true,
        connectTimeout: 5,
        ...(encrypt === undefined ? {} : { encrypt }),
    };
    return mssqlDriver.connect({ options }).then((connection) => {
        connections.push(connection);
        return connection;
    });
}

afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()));
    await Promise.all(servers.splice(0).map((started) => started.stop()));
});

describe("SQL Server login and encryption", () => {
    it("tedious still has the private method the protection wraps", () => {
        expect(
            typeof (TediousConnection.prototype as unknown as { sendLogin7Packet?: unknown })
                .sendLogin7Packet,
        ).toBe("function");
    });

    it("logs in over TLS when the server supports encryption", async () => {
        const server = await startServer();

        await connect(server, "Mandatory");

        expect(server.logins.at(-1)).toMatchObject({
            encrypted: true,
            userName: "app",
            accepted: true,
        });
    });

    it("sends no login to a server that does not encrypt (Encrypt: Mandatory, also the default)", async () => {
        const server = await startServer({ encryption: "notSupported" });

        for (const encrypt of ["Mandatory", undefined]) {
            await expect(connect(server, encrypt), String(encrypt)).rejects.toThrow(
                /does not support encryption, but this connection requires it \(Encrypt: Mandatory\)\. Nothing was sent/,
            );
        }

        expect(server.logins).toEqual([]);
    });

    it("logs in unprotected only when the connection says Encrypt: Optional", async () => {
        const server = await startServer({ encryption: "notSupported" });

        await connect(server, "Optional");

        expect(server.logins.at(-1)).toMatchObject({
            encrypted: false,
            userName: "app",
            accepted: true,
        });
    });
});
