import { afterEach, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { PLAN_CONNECTION_LOST_MESSAGE } from "../../../src/drivers/mssql/execute";
import type { DriverConnection, ExecuteEvent, ExecutionPlanKind } from "../../../src/drivers/types";
import { FakeTdsServer } from "../../support/fakeTdsServer";

// The session's physical connection breaks after SET SHOWPLAN_XML ON was acknowledged and before
// the batch is sent. mssql's pool would replace it with a new connection, where the option is off:
// an estimated plan sent there would run the batch. The real driver talks to
// test/support/fakeTdsServer.ts, which closes the connection right after acknowledging the SET.

const BATCH = "DELETE FROM dbo.yast_oi_precious";
const servers: FakeTdsServer[] = [];
const connections: DriverConnection[] = [];

afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()));
    await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function setUp(option: string) {
    const server = await new FakeTdsServer({
        identity: { version: "16.0.4295.3", edition: "Developer Edition", engineEdition: 3 },
    }).start();
    servers.push(server);
    server.sqlLogins.set("user", "pw");
    server.answer = (sql) => {
        // Acknowledged (the default empty answer is sent first), then the connection is closed.
        if (sql === `SET ${option} ON`) setImmediate(() => server.dropConnections());
        return undefined;
    };
    const connection = await mssqlDriver.connect({
        options: {
            server: `127.0.0.1,${server.port}`,
            authenticationType: "SqlLogin",
            user: "user",
            password: "pw",
            database: "yast",
            trustServerCertificate: true,
            connectTimeout: 5,
        },
    });
    connections.push(connection);
    return { server, connection };
}

/** Runs a plan; a rejection is kept as an error message. */
async function runAfterDrop(
    connection: DriverConnection,
    kind: ExecutionPlanKind,
): Promise<ExecuteEvent[]> {
    const events: ExecuteEvent[] = [];
    await connection.executeForPlan!(
        { text: BATCH, startLine: 0 },
        kind,
        (event) => void events.push(event),
        new AbortController().signal,
    ).catch((error: Error) => events.push({ type: "message", text: error.message, isError: true }));
    return events;
}

describe("a plan run whose connection breaks after the option is turned on", () => {
    for (const [kind, option] of [
        ["estimated", "SHOWPLAN_XML"],
        ["actual", "STATISTICS XML"],
    ] as const) {
        it(`${kind}: the batch never reaches a connection without the option, and the user is told`, async () => {
            const { server, connection } = await setUp(option);

            const events = await runAfterDrop(connection, kind);

            // The batch was not sent anywhere: the only connection that could take it was gone.
            const logins = server.logins.filter((login) =>
                login.requests.includes(`SET ${option} ON`),
            );
            expect(logins).toHaveLength(1);
            for (const login of server.logins) {
                const index = login.requests.indexOf(BATCH);
                if (index >= 0) {
                    // Only possible on the connection that had the option on, after the SET.
                    expect(login).toBe(logins[0]);
                    expect(login.requests.indexOf(`SET ${option} ON`)).toBeLessThan(index);
                }
            }
            expect(server.logins.flatMap((login) => login.requests)).not.toContain(BATCH);
            // Reported as a message (lost before the batch) or as the rejection (lost while
            // sending it), depending on when the client notices the closed socket.
            const errors = events.flatMap((e) =>
                e.type === "message" && e.isError ? [e.text] : [],
            );
            expect(errors).toHaveLength(1);
            expect(errors[0].startsWith(PLAN_CONNECTION_LOST_MESSAGE)).toBe(true);
            // OFF is not sent: a new connection has the option off.
            expect(server.logins.flatMap((login) => login.requests)).not.toContain(
                `SET ${option} OFF`,
            );

            // The session works again, on a new connection, without the option.
            server.answer = () => undefined;
            const after: ExecuteEvent[] = [];
            await connection.execute(
                { text: "SELECT 1", startLine: 0 },
                (event) => void after.push(event),
                new AbortController().signal,
            );
            expect(after.filter((e) => e.type === "message" && e.isError)).toEqual([]);
            expect(server.logins.at(-1)?.requests).toContain("SELECT 1");
        });
    }
});
