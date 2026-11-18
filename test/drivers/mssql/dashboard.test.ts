import { afterEach, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import {
    AZURE_SQL_DATABASE_NOTICE,
    counterSeriesValues,
    MISSING_DATABASE_PERMISSION_NOTICE,
    MISSING_SERVER_PERMISSION_NOTICE,
    MSSQL_DASHBOARD_CHARTS,
    recordsetsToSample,
    unreadableSeriesNotice,
    type CounterRow,
} from "../../../src/drivers/mssql/dashboard";
import type { DashboardSession } from "../../../src/drivers/types";
import { FakeTdsServer, type FakeResultSet } from "../../support/fakeTdsServer";

const row = (
    object_name: string,
    counter_name: string,
    cntr_value: number | string,
    instance_name = "",
): CounterRow => ({ object_name, counter_name, instance_name, cntr_value });

describe("counterSeriesValues", () => {
    it("reads the counters of a default instance and of a named one alike", () => {
        const rows = [
            row("SQLServer:Buffer Manager", "Page reads/sec", 10),
            row("MSSQL$PROD:Buffer Manager", "Page writes/sec", 20),
            row("MSSQL$PROD:SQL Statistics", "Batch Requests/sec", 30),
            row("SQLServer:Buffer Manager", "Page life expectancy", 4000),
        ];
        const values = counterSeriesValues(rows);
        expect(values["pageIo.reads"]).toBe(10);
        expect(values["pageIo.writes"]).toBe(20);
        expect(values["requests.batches"]).toBe(30);
        expect(values["pageLifeExpectancy.seconds"]).toBe(4000);
    });

    it("takes the _Total instance of the per-database counter, not the sum of the rows", () => {
        const values = counterSeriesValues([
            row("SQLServer:Databases", "Transactions/sec", 100, "master"),
            row("SQLServer:Databases", "Transactions/sec", 50, "yast"),
            row("SQLServer:Databases", "Transactions/sec", 150, "_Total"),
        ]);
        expect(values["requests.transactions"]).toBe(150);
    });

    it("adds up the databases when there is no _Total row", () => {
        const values = counterSeriesValues([
            row("SQLServer:Databases", "Transactions/sec", 100, "master"),
            row("SQLServer:Databases", "Transactions/sec", "50", "yast"),
        ]);
        expect(values["requests.transactions"]).toBe(150);
    });

    it("ignores a counter of the same name in another object", () => {
        const values = counterSeriesValues([
            row("SQLServer:Buffer Node", "Page life expectancy", 1),
            row("SQLServer:Buffer Manager", "Page life expectancy", 9),
        ]);
        expect(values["pageLifeExpectancy.seconds"]).toBe(9);
    });

    it("computes a ratio counter from its base counter, in percent", () => {
        const values = counterSeriesValues([
            row("SQLServer:Buffer Manager", "Buffer cache hit ratio", 981),
            row("SQLServer:Buffer Manager", "Buffer cache hit ratio base", 1000),
        ]);
        expect(values["bufferCacheHitRatio.ratio"]).toBeCloseTo(98.1);
    });

    it("leaves a ratio undefined when its base is missing or zero", () => {
        const noBase = counterSeriesValues([
            row("SQLServer:Buffer Manager", "Buffer cache hit ratio", 981),
        ]);
        expect(noBase["bufferCacheHitRatio.ratio"]).toBeUndefined();
        const zeroBase = counterSeriesValues([
            row("SQLServer:Buffer Manager", "Buffer cache hit ratio", 0),
            row("SQLServer:Buffer Manager", "Buffer cache hit ratio base", 0),
        ]);
        expect(zeroBase["bufferCacheHitRatio.ratio"]).toBeUndefined();
    });

    it("leaves a missing counter undefined, never 0", () => {
        const values = counterSeriesValues([row("SQLServer:Buffer Manager", "Page reads/sec", 0)]);
        expect(values["pageIo.reads"]).toBe(0);
        expect(values["pageIo.writes"]).toBeUndefined();
        expect(values["requests.batches"]).toBeUndefined();
        expect(counterSeriesValues([])["requests.transactions"]).toBeUndefined();
    });
});

describe("recordsetsToSample", () => {
    const seriesIds = MSSQL_DASHBOARD_CHARTS.flatMap((chart) => chart.series.map((s) => s.id));

    it("has unique chart and series ids", () => {
        expect(new Set(MSSQL_DASHBOARD_CHARTS.map((c) => c.id)).size).toBe(
            MSSQL_DASHBOARD_CHARTS.length,
        );
        expect(new Set(seriesIds).size).toBe(seriesIds.length);
    });

    it("gives every series a key, undefined when it could not be read", () => {
        const sample = recordsetsToSample([[{ time: "1700000000123" }]]);
        expect(sample.time).toBe(1700000000123);
        expect(Object.keys(sample.values).sort()).toEqual([...seriesIds].sort());
        expect(Object.values(sample.values).every((v) => v === undefined)).toBe(true);
    });

    it("derives idle sessions and reads the file totals", () => {
        const sample = recordsetsToSample([
            [{ time: "5", sessions_total: "7", sessions_active: "2" }],
            [row("SQLServer:SQL Statistics", "Batch Requests/sec", 12)],
            [{ bytes_read: "100", bytes_written: "200" }],
        ]);
        expect(sample.values["sessions.idle"]).toBe(5);
        expect(sample.values["requests.batches"]).toBe(12);
        expect(sample.values["fileIo.read"]).toBe(100);
        expect(sample.values["fileIo.written"]).toBe(200);
    });
});

describe("unreadableSeriesNotice", () => {
    it("names the charts that have a series without a value, and only those", () => {
        const sample = recordsetsToSample([
            [{ time: "1", sessions_total: 1, sessions_active: 1 }],
            [],
            [{ bytes_read: 1, bytes_written: 1 }],
        ]);
        const notice = unreadableSeriesNotice(MSSQL_DASHBOARD_CHARTS, sample)!;
        expect(notice).toContain("Requests per second");
        expect(notice).toContain("Page I/O");
        expect(notice).not.toContain("User sessions");
        expect(notice).not.toContain("File I/O");
    });

    it("says nothing when every series has a value", () => {
        const values = Object.fromEntries(
            MSSQL_DASHBOARD_CHARTS.flatMap((c) => c.series.map((s) => [s.id, 1])),
        );
        expect(unreadableSeriesNotice(MSSQL_DASHBOARD_CHARTS, { time: 1, values })).toBeUndefined();
    });
});

// -- Opening and sampling against a fake server --------------------------------------------------

const servers: FakeTdsServer[] = [];
const sessions: DashboardSession[] = [];

afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    await Promise.all(servers.splice(0).map((server) => server.stop()));
});

interface Opening {
    engineEdition: number;
    serverState?: number;
    databaseState?: number;
}

async function startServer(opening: Opening): Promise<FakeTdsServer> {
    const server = await new FakeTdsServer({
        identity: { version: "12.0.2000.8", edition: "SQL Azure", engineEdition: 5 },
    }).start();
    server.sqlLogins.set("dash", "pw");
    server.answer = (sql): FakeResultSet | undefined => {
        if (sql.includes("AS engineEdition")) {
            return { columns: ["engineEdition:int"], rows: [[opening.engineEdition]] };
        }
        if (sql.includes("HAS_PERMS_BY_NAME")) {
            return {
                columns: [
                    "serverState:int",
                    "serverPerformanceState:int",
                    "databaseState:int",
                    "databasePerformanceState:int",
                ],
                rows: [[opening.serverState ?? 0, 0, opening.databaseState ?? 0, 0]],
            };
        }
        if (sql.includes("sys.dm_os_performance_counters")) {
            return {
                columns: ["time", "sessions_total", "sessions_active"],
                rows: [["1700000000000", "3", "1"]],
            };
        }
        if (sql.includes("SYSUTCDATETIME")) {
            return { columns: ["time"], rows: [["1700000000000"]] };
        }
        return undefined;
    };
    servers.push(server);
    return server;
}

async function open(server: FakeTdsServer, extra: Record<string, string> = {}) {
    const session = await mssqlDriver.openDashboard!({
        options: {
            server: `127.0.0.1,${server.port}`,
            authenticationType: "SqlLogin",
            user: "dash",
            password: "pw",
            trustServerCertificate: true,
            connectTimeout: 5,
            ...extra,
        },
    });
    sessions.push(session);
    return session;
}

describe("openDashboard", () => {
    it("is offered by the SQL Server driver", () => {
        expect(mssqlDriver.openDashboard).toBeTypeOf("function");
    });

    it("rejects with a readable message on a dedicated SQL pool", async () => {
        const server = await startServer({ engineEdition: 6 });
        await expect(open(server)).rejects.toThrow(/dedicated SQL pool/);
    });

    it("rejects with a readable message on a serverless SQL pool", async () => {
        const server = await startServer({ engineEdition: 11 });
        await expect(open(server)).rejects.toThrow(/serverless SQL pool/);
    });

    it("rejects with a readable message on a SQL database in Microsoft Fabric", async () => {
        const server = await startServer({ engineEdition: 12 });
        await expect(open(server)).rejects.toThrow(/Microsoft Fabric/);
    });

    it("signs in as 'YAST dashboard', whatever application name the profile has", async () => {
        const server = await startServer({ engineEdition: 3, serverState: 1 });
        await open(server, { applicationName: "My app" });
        const dashboardLogins = server.logins.filter((login) =>
            login.requests.some((sql) => sql.includes("HAS_PERMS_BY_NAME")),
        );
        expect(dashboardLogins).toHaveLength(1);
        expect(dashboardLogins[0].appName).toBe("YAST dashboard");
    });

    it("reads a sample in one round trip", async () => {
        const server = await startServer({ engineEdition: 3, serverState: 1 });
        const session = await open(server);
        const login = server.logins.find((l) => l.requests.some((s) => s.includes("HAS_PERMS")))!;
        for (let i = 0; i < 3; i++) {
            const before = login.requests.length;
            const sample = await session.sample(new AbortController().signal);
            expect(sample.time).toBe(1700000000000);
            expect(sample.values["sessions.total"]).toBe(3);
            expect(login.requests.slice(before)).toHaveLength(1);
        }
    });

    it("tells a login without VIEW SERVER STATE, and reads nothing from the views", async () => {
        const server = await startServer({ engineEdition: 3, serverState: 0 });
        const session = await open(server);
        expect(session.notices).toEqual([MISSING_SERVER_PERMISSION_NOTICE]);
        const sample = await session.sample(new AbortController().signal);
        expect(Object.values(sample.values).every((v) => v === undefined)).toBe(true);
        expect(
            server.logins.flatMap((l) => l.requests).some((s) => s.includes("dm_exec_sessions")),
        ).toBe(false);
    });

    it("on Azure SQL Database, checks the database permission and says the figures are the database's", async () => {
        const without = await startServer({ engineEdition: 5, serverState: 1, databaseState: 0 });
        expect((await open(without)).notices).toEqual([
            AZURE_SQL_DATABASE_NOTICE,
            MISSING_DATABASE_PERMISSION_NOTICE,
        ]);

        const withPermission = await startServer({ engineEdition: 5, databaseState: 1 });
        const session = await open(withPermission);
        expect(session.notices[0]).toBe(AZURE_SQL_DATABASE_NOTICE);
        expect(session.notices).not.toContain(MISSING_DATABASE_PERMISSION_NOTICE);
    });

    it("tells which charts could not be read although the login has the permission", async () => {
        // The fake answers the sample with the session row only: no counters, no file totals.
        const server = await startServer({ engineEdition: 3, serverState: 1 });
        const session = await open(server);
        expect(session.notices).toHaveLength(1);
        expect(session.notices[0]).toContain("Page I/O");
        expect(session.notices[0]).toContain("File I/O");
    });
});
