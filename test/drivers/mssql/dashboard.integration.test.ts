import { randomBytes } from "node:crypto";
import * as sql from "mssql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import type {
    CellValue,
    DashboardSample,
    DashboardSession,
    DriverConnection,
} from "../../../src/drivers/types";
import { connectToDocker, dockerOptions, runBatch } from "./helpers";

// The SQL Server dashboard against the test server (SQL Server 2022).

const suffix = randomBytes(4).toString("hex");
const LOW_LOGIN = `yast_oi_dash_low_${suffix}`;
const STATE_LOGIN = `yast_oi_dash_state_${suffix}`;
const PERFORMANCE_LOGIN = `yast_oi_dash_perf_${suffix}`;
const TABLE = `yast_oi_dash_${suffix}`;
const PASSWORD = `Pw_${suffix}_Aa1!`;
const NAME = "YAST dashboard";
const never = () => new AbortController().signal;

let admin: DriverConnection;
const opened: DashboardSession[] = [];

async function rows(text: string): Promise<CellValue[][]> {
    const events = await runBatch(admin, text);
    const errors = events.flatMap((e) => (e.type === "message" && e.isError ? [e.text] : []));
    expect(errors).toEqual([]);
    return events.flatMap((e) => (e.type === "rows" ? e.rows : []));
}

async function open(overrides: Record<string, string | number | boolean> = {}) {
    const session = await mssqlDriver.openDashboard!({ options: dockerOptions(overrides) });
    opened.push(session);
    return session;
}

async function serverSessions(): Promise<number> {
    const result = await rows(
        `SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE program_name = '${NAME}'`,
    );
    return Number(result[0][0].displayValue);
}

async function sampleUntil(
    session: DashboardSession,
    done: (sample: DashboardSample) => boolean,
    timeoutMs = 15000,
): Promise<DashboardSample> {
    let last: DashboardSample | undefined;
    await vi.waitFor(
        async () => {
            last = await session.sample(never());
            expect(done(last)).toBe(true);
        },
        { timeout: timeoutMs, interval: 300 },
    );
    return last!;
}

beforeAll(async () => {
    admin = await connectToDocker();
    const database = String(dockerOptions().database);
    // Server permissions can only be granted from master; rows() fails on any error.
    await rows(
        `USE master;
         CREATE LOGIN ${LOW_LOGIN} WITH PASSWORD = '${PASSWORD}', CHECK_POLICY = OFF;
         CREATE LOGIN ${STATE_LOGIN} WITH PASSWORD = '${PASSWORD}', CHECK_POLICY = OFF;
         GRANT VIEW SERVER STATE TO ${STATE_LOGIN};
         CREATE LOGIN ${PERFORMANCE_LOGIN} WITH PASSWORD = '${PASSWORD}', CHECK_POLICY = OFF;
         GRANT VIEW SERVER PERFORMANCE STATE TO ${PERFORMANCE_LOGIN};`,
    );
    // In tempdb: other integration files read the catalog of the test database while this runs.
    await rows(
        `USE tempdb; CREATE TABLE dbo.${TABLE} (id int, filler char(200)); USE [${database}];`,
    );
});

afterAll(async () => {
    await Promise.all(opened.map((session) => session.close()));
    if (!admin) return;
    await runBatch(admin, `DROP TABLE IF EXISTS tempdb.dbo.${TABLE};`);
    await runBatch(admin, "USE master");
    for (const login of [LOW_LOGIN, STATE_LOGIN, PERFORMANCE_LOGIN]) {
        await runBatch(admin, `IF SUSER_ID('${login}') IS NOT NULL DROP LOGIN ${login}`);
    }
    await admin.close();
});

describe("SQL Server dashboard", () => {
    it("describes charts whose series have unique ids, all present in a sample", async () => {
        const session = await open();
        const chartIds = session.charts.map((c) => c.id);
        const seriesIds = session.charts.flatMap((c) => c.series.map((s) => s.id));
        expect(new Set(chartIds).size).toBe(chartIds.length);
        expect(new Set(seriesIds).size).toBe(seriesIds.length);
        const sample = await session.sample(never());
        expect(Object.keys(sample.values).sort()).toEqual([...seriesIds].sort());
        // Everything is readable on this server, so no series is missing.
        for (const id of seriesIds) expect(sample.values[id], id).toBeTypeOf("number");
        expect(session.notices).toEqual([]);
        // File I/O is a size, the rest are plain numbers or a percentage.
        expect(session.charts.find((c) => c.id === "fileIo")!.format).toBe("bytes");
        expect(session.charts.find((c) => c.id === "bufferCacheHitRatio")!.format).toBe("percent");
    });

    it("gives plausible values, the dashboard's own session included", async () => {
        const session = await open();
        const { values } = await session.sample(never());
        expect(values["sessions.total"]).toBeGreaterThanOrEqual(2); // the admin and this one
        expect(values["sessions.active"]).toBeGreaterThanOrEqual(1);
        expect(values["sessions.total"]).toBe(
            values["sessions.active"]! + values["sessions.idle"]!,
        );
        expect(values["pageLifeExpectancy.seconds"]).toBeGreaterThan(0);
        expect(values["bufferCacheHitRatio.ratio"]).toBeGreaterThan(0);
        expect(values["bufferCacheHitRatio.ratio"]).toBeLessThanOrEqual(100);
        expect(values["fileIo.read"]).toBeGreaterThan(0);
        expect(values["requests.batches"]).toBeGreaterThan(0);
    });

    it("reads the time on the server's clock, in the same round trip", async () => {
        const session = await open();
        const clock = async () =>
            Number(
                (
                    await rows(
                        "SELECT CAST(DATEDIFF(SECOND, '19700101', SYSUTCDATETIME()) AS bigint) * 1000 + DATEPART(MILLISECOND, SYSUTCDATETIME())",
                    )
                )[0][0].displayValue,
            );
        const before = await clock();
        const first = await session.sample(never());
        await new Promise((resolve) => setTimeout(resolve, 400));
        const second = await session.sample(never());
        const after = await clock();
        // SQL Server's datetime2(3) rounds: allow a few milliseconds.
        expect(first.time).toBeGreaterThanOrEqual(before - 5);
        expect(second.time).toBeLessThanOrEqual(after + 5);
        expect(second.time - first.time).toBeGreaterThanOrEqual(350);
        expect(second.time - first.time).toBeLessThan(5000);
    });

    it("reads a sample with one request, without mssql's validation query", async () => {
        const session = await open();
        await session.sample(never());
        // Every request of the dashboard's connection goes through this method.
        const send = vi.spyOn(sql.Request.prototype, "batch");
        const query = vi.spyOn(sql.Request.prototype, "query");
        try {
            await session.sample(never());
            expect(send).toHaveBeenCalledTimes(1);
            expect(query).not.toHaveBeenCalled();
        } finally {
            send.mockRestore();
            query.mockRestore();
        }
        // What reached the server, counted there: batches of the dashboard's session.
        const countBatches = async () => {
            const result = await rows(
                `SELECT SUM(CAST(c.num_reads AS bigint)) FROM sys.dm_exec_connections c JOIN sys.dm_exec_sessions s ON s.session_id = c.session_id WHERE s.program_name = '${NAME}'`,
            );
            return Number(result[0][0].displayValue);
        };
        const reads = await countBatches();
        await session.sample(never());
        // One request is a handful of TDS packets at most, never the two or more of a
        // query plus a validation: a sample's batch text is far below one 4 KB packet.
        expect(await countBatches()).toBe(reads + 1);
    });

    it("counters do not decrease and move with the activity of another connection", async () => {
        const session = await open();
        const first = await session.sample(never());
        const again = await session.sample(never());
        for (const chart of session.charts.filter((c) => c.series[0].kind === "counter")) {
            for (const series of chart.series) {
                expect(again.values[series.id]!).toBeGreaterThanOrEqual(first.values[series.id]!);
            }
        }

        const database = String(dockerOptions().database);
        await runBatch(
            admin,
            `USE tempdb;
             INSERT dbo.${TABLE} SELECT TOP (3000) 1, 'x' FROM sys.all_columns a CROSS JOIN sys.all_columns b;
             CHECKPOINT;
             DBCC DROPCLEANBUFFERS;
             SELECT COUNT(*) FROM dbo.${TABLE};
             USE [${database}];`,
        );
        const moved = await sampleUntil(
            session,
            (s) =>
                s.values["requests.batches"]! > first.values["requests.batches"]! &&
                s.values["requests.transactions"]! > first.values["requests.transactions"]! &&
                s.values["pageIo.writes"]! > first.values["pageIo.writes"]! &&
                s.values["pageIo.reads"]! > first.values["pageIo.reads"]! &&
                s.values["fileIo.written"]! > first.values["fileIo.written"]! &&
                s.values["fileIo.read"]! > first.values["fileIo.read"]!,
        );
        expect(moved.time).toBeGreaterThan(first.time);
    });

    it("counts the sessions of the other connections, active and idle", async () => {
        const session = await open();
        const idle = await connectToDocker();
        const busy = await connectToDocker();
        const waiting = runBatch(busy, "WAITFOR DELAY '00:00:04'");
        try {
            const sample = await sampleUntil(
                session,
                (s) => s.values["sessions.active"]! >= 2 && s.values["sessions.idle"]! >= 1,
                3000,
            );
            // The admin, the idle connection, the busy one and the dashboard.
            expect(sample.values["sessions.total"]).toBeGreaterThanOrEqual(4);
        } finally {
            await waiting.catch(() => undefined);
            await idle.close();
            await busy.close();
        }
    });

    it("is visible on the server as 'YAST dashboard', whatever the profile's application name", async () => {
        const before = await serverSessions();
        const session = await open({ applicationName: "my app" });
        expect(await serverSessions()).toBe(before + 1);
        const named = await rows(
            "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE program_name = 'my app'",
        );
        expect(named[0][0].displayValue).toBe("0");
        await session.close();
        await vi.waitFor(async () => expect(await serverSessions()).toBe(before));
    });

    it("close() ends the server session, and a sample in flight settles", async () => {
        const before = await serverSessions();
        const session = await open();
        const sampling = session.sample(never());
        const closing = session.close();
        const [sampled] = await Promise.all([
            sampling.then(
                () => "ok",
                () => "rejected",
            ),
            closing,
        ]);
        expect(["ok", "rejected"]).toContain(sampled);
        await vi.waitFor(async () => expect(await serverSessions()).toBe(before));
        await expect(session.sample(never())).rejects.toThrow(/closed/);
    });

    it("aborts a sample, and the session still works", async () => {
        const session = await open();
        const already = new AbortController();
        already.abort(new Error("stopped"));
        await expect(session.sample(already.signal)).rejects.toThrow("stopped");

        // The server answers in a few milliseconds, so whether the cancellation arrives in time
        // varies: the sample rejects either way, and the session must work afterwards.
        const outcomes = new Set<string>();
        for (let i = 0; i < 15; i++) {
            const controller = new AbortController();
            const sampling = session.sample(controller.signal);
            controller.abort(new Error("stopped"));
            outcomes.add(
                await sampling.then(
                    () => "sampled",
                    (e: Error) => e.message,
                ),
            );
            await expect(session.sample(never())).resolves.toHaveProperty("time");
        }
        // An aborted sample always rejects, whether or not the cancellation came in time.
        expect([...outcomes]).toEqual(["stopped"]);
    });

    describe("permissions", () => {
        it("a login without VIEW SERVER STATE gets a notice and no value, not its own session as the server's", async () => {
            const session = await open({ user: LOW_LOGIN, password: PASSWORD, database: "master" });
            expect(session.notices).toHaveLength(1);
            expect(session.notices[0]).toMatch(/VIEW SERVER STATE/);
            const { values, time } = await session.sample(never());
            expect(time).toBeGreaterThan(0);
            for (const [id, value] of Object.entries(values)) expect(value, id).toBeUndefined();
        });

        it("a login with VIEW SERVER STATE gets no notice and the other sessions", async () => {
            const session = await open({
                user: STATE_LOGIN,
                password: PASSWORD,
                database: "master",
            });
            expect(session.notices).toEqual([]);
            const { values } = await session.sample(never());
            expect(values["sessions.total"]).toBeGreaterThanOrEqual(2);
            expect(values["requests.batches"]).toBeGreaterThan(0);
        });

        it("VIEW SERVER PERFORMANCE STATE (SQL Server 2022) is enough", async () => {
            const session = await open({
                user: PERFORMANCE_LOGIN,
                password: PASSWORD,
                database: "master",
            });
            expect(session.notices).toEqual([]);
            const { values } = await session.sample(never());
            expect(values["sessions.total"]).toBeGreaterThanOrEqual(2);
            expect(values["fileIo.read"]).toBeGreaterThan(0);
            expect(values["requests.batches"]).toBeGreaterThan(0);
        });
    });

    it("fails readably with a wrong password", async () => {
        const before = await serverSessions();
        await expect(open({ password: "not-the-password" })).rejects.toThrow(
            /^Cannot connect to .*Login failed/,
        );
        expect(await serverSessions()).toBe(before);
    });
});
