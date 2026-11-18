import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pgDriver } from "../../../src/drivers/pg";
import type { DashboardSample, DashboardSession } from "../../../src/drivers/types";
import { pgOptions } from "../../support/databases";

// The PostgreSQL dashboard against the test server. Statistics are flushed to shared memory by
// each backend after a short delay (about a second), so tests that move a counter poll.

const suffix = randomBytes(4).toString("hex");
const LOW_ROLE = `yast_oi_dash_low_${suffix}`;
const MONITOR_ROLE = `yast_oi_dash_mon_${suffix}`;
const SUPER_ROLE = `yast_oi_dash_super_${suffix}`;
const TABLE = `yast_oi_dash_${suffix}`;
const PASSWORD = `pw_${suffix}`;
const NAME = "YAST dashboard";
const never = () => new AbortController().signal;

let admin: Client;
const opened: DashboardSession[] = [];

function adminConfig() {
    const o = pgOptions();
    return {
        host: String(o.server),
        port: Number(o.port),
        user: String(o.user),
        password: String(o.password),
        database: String(o.database),
    };
}

async function open(overrides: Record<string, string | number | boolean> = {}) {
    const session = await pgDriver.openDashboard!({ options: pgOptions(overrides) });
    opened.push(session);
    return session;
}

async function serverSessions(): Promise<number> {
    const result = await admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
        [NAME],
    );
    return result.rows[0].n;
}

async function serverClockMs(): Promise<number> {
    const result = await admin.query("SELECT (date_part('epoch', clock_timestamp()) * 1000) AS ms");
    return Number(result.rows[0].ms);
}

/** Samples until `done` accepts the sample, or fails after `timeoutMs`. */
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
    admin = new Client(adminConfig());
    await admin.connect();
    await admin.query(`CREATE ROLE ${LOW_ROLE} LOGIN PASSWORD '${PASSWORD}'`);
    await admin.query(
        `CREATE ROLE ${MONITOR_ROLE} LOGIN PASSWORD '${PASSWORD}' IN ROLE pg_monitor`,
    );
    await admin.query(`CREATE ROLE ${SUPER_ROLE} LOGIN SUPERUSER PASSWORD '${PASSWORD}'`);
    await admin.query(`CREATE TEMP TABLE ${TABLE} (id int, filler text)`);
});

afterAll(async () => {
    await Promise.all(opened.map((session) => session.close()));
    if (!admin) return;
    await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
    for (const role of [LOW_ROLE, MONITOR_ROLE, SUPER_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin.end();
});

describe("PostgreSQL dashboard", () => {
    it("describes charts whose series have unique ids, all present in a sample", async () => {
        const session = await open();
        const chartIds = session.charts.map((c) => c.id);
        const seriesIds = session.charts.flatMap((c) => c.series.map((s) => s.id));
        expect(session.charts.map((c) => c.title)).toEqual([
            "Database sessions",
            "Transactions per second",
            "Tuples in",
            "Tuples out",
            "Block I/O",
        ]);
        expect(new Set(chartIds).size).toBe(chartIds.length);
        expect(new Set(seriesIds).size).toBe(seriesIds.length);
        const sample = await session.sample(never());
        for (const id of seriesIds) expect(sample.values).toHaveProperty(id);
        expect(Object.keys(sample.values).sort()).toEqual([...seriesIds].sort());
        expect(session.notices).toEqual([]);
    });

    it("gives plausible values, the dashboard's own session included", async () => {
        const session = await open();
        const { values } = await session.sample(never());
        expect(values["sessions.total"]).toBeGreaterThanOrEqual(2); // the admin and this one
        expect(values["sessions.active"]).toBeGreaterThanOrEqual(1);
        expect(values["sessions.total"]!).toBeGreaterThanOrEqual(
            values["sessions.active"]! + values["sessions.idle"]!,
        );
        expect(values["transactions.total"]).toBe(
            values["transactions.commits"]! + values["transactions.rollbacks"]!,
        );
        for (const value of Object.values(values)) {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
        }
    });

    it("reads the time on the server's clock, in the same round trip", async () => {
        const session = await open();
        const before = await serverClockMs();
        const first = await session.sample(never());
        await new Promise((resolve) => setTimeout(resolve, 400));
        const second = await session.sample(never());
        const after = await serverClockMs();
        expect(first.time).toBeGreaterThanOrEqual(before);
        expect(second.time).toBeLessThanOrEqual(after);
        expect(second.time - first.time).toBeGreaterThanOrEqual(350);
        expect(second.time - first.time).toBeLessThan(5000);
    });

    it("reads a sample with one query", async () => {
        const session = await open();
        await session.sample(never());
        const query = vi.spyOn(Client.prototype, "query");
        try {
            await session.sample(never());
            expect(query).toHaveBeenCalledTimes(1);
        } finally {
            query.mockRestore();
        }
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

        await admin.query(
            `INSERT INTO ${TABLE} SELECT g, repeat('x', 100) FROM generate_series(1, 2000) g`,
        );
        await admin.query(`UPDATE ${TABLE} SET filler = 'y' WHERE id <= 500`);
        await admin.query(`DELETE FROM ${TABLE} WHERE id <= 100`);
        await admin.query("BEGIN");
        await admin.query("ROLLBACK");
        await admin.query(`SELECT count(*), sum(id) FROM ${TABLE}`);
        const moved = await sampleUntil(
            session,
            (s) =>
                s.values["tuplesIn.inserts"]! >= first.values["tuplesIn.inserts"]! + 2000 &&
                s.values["tuplesIn.updates"]! >= first.values["tuplesIn.updates"]! + 500 &&
                s.values["tuplesIn.deletes"]! >= first.values["tuplesIn.deletes"]! + 100 &&
                s.values["transactions.rollbacks"]! > first.values["transactions.rollbacks"]! &&
                s.values["tuplesOut.returned"]! > first.values["tuplesOut.returned"]!,
        );
        expect(moved.values["transactions.commits"]).toBeGreaterThan(
            first.values["transactions.commits"]!,
        );
        expect(moved.values["blockIo.hits"]! + moved.values["blockIo.reads"]!).toBeGreaterThan(
            first.values["blockIo.hits"]! + first.values["blockIo.reads"]!,
        );
    });

    it("counts the sessions of the other connections, active and idle", async () => {
        const session = await open();
        const idleClient = new Client(adminConfig());
        const busyClient = new Client(adminConfig());
        await idleClient.connect();
        await busyClient.connect();
        const sleeping = busyClient.query("SELECT pg_sleep(4)");
        try {
            const sample = await sampleUntil(
                session,
                (s) => s.values["sessions.active"]! >= 2 && s.values["sessions.idle"]! >= 1,
                3000,
            );
            // The admin, the idle client, the busy client and the dashboard.
            expect(sample.values["sessions.total"]).toBeGreaterThanOrEqual(4);
        } finally {
            await sleeping.catch(() => undefined);
            await idleClient.end();
            await busyClient.end();
        }
    });

    it("is visible on the server as 'YAST dashboard', whatever the profile's application name", async () => {
        const before = await serverSessions();
        const session = await open({ applicationName: "my app" });
        expect(await serverSessions()).toBe(before + 1);
        const names = await admin.query(
            "SELECT DISTINCT application_name FROM pg_stat_activity WHERE application_name IN ($1, 'my app')",
            [NAME],
        );
        expect(names.rows.map((r) => r.application_name)).toEqual([NAME]);
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

        // The server answers in about a millisecond, so whether the cancellation arrives in time
        // varies: the sample rejects either way, and the session must work afterwards, and a late
        // cancellation must never hit the next sample.
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
        it("a role that cannot see other sessions gets a notice and no session counts", async () => {
            const session = await open({ user: LOW_ROLE, password: PASSWORD });
            expect(session.notices).toHaveLength(1);
            expect(session.notices[0]).toMatch(/pg_monitor|pg_read_all_stats/);
            const { values } = await session.sample(never());
            expect(values["sessions.total"]).toBeUndefined();
            expect(values["sessions.active"]).toBeUndefined();
            expect(values["sessions.idle"]).toBeUndefined();
            // pg_stat_database is readable by everyone.
            expect(values["transactions.commits"]).toBeGreaterThan(0);
        });

        it("a member of pg_monitor gets no notice and the session counts", async () => {
            const session = await open({ user: MONITOR_ROLE, password: PASSWORD });
            expect(session.notices).toEqual([]);
            const { values } = await session.sample(never());
            expect(values["sessions.total"]).toBeGreaterThanOrEqual(2);
        });

        it("a superuser gets no notice", async () => {
            const session = await open({ user: SUPER_ROLE, password: PASSWORD });
            expect(session.notices).toEqual([]);
        });
    });

    it("fails readably with a wrong password", async () => {
        const before = await serverSessions();
        await expect(open({ password: "not-the-password" })).rejects.toThrow(
            /Authentication failed|password authentication failed/,
        );
        expect(await serverSessions()).toBe(before);
    });
});
