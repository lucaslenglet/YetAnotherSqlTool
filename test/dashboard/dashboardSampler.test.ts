import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    counterRate,
    DashboardHistory,
    DashboardSampler,
} from "../../src/dashboard/dashboardSampler";
import type { DashboardChart, DashboardSample, DashboardSession } from "../../src/drivers/types";
import type { DashboardPoint } from "../../src/sharedInterfaces/dashboard";

const charts: DashboardChart[] = [
    {
        id: "sessions",
        title: "Sessions",
        format: "number",
        unit: "",
        series: [{ id: "active", label: "Active", kind: "gauge" }],
    },
    {
        id: "tx",
        title: "Transactions",
        format: "number",
        unit: "/s",
        series: [{ id: "commits", label: "Commits", kind: "counter" }],
    },
];

/**
 * A session whose readings are answered by the test: each sample() call waits until `answer` or
 * `fail` is called, so that a test sees exactly when readings are taken. The server clock is
 * Date.now() (faked by vitest).
 */
class FakeSession implements DashboardSession {
    public charts: DashboardChart[] = charts;
    public notices: string[] = [];
    public calls = 0;
    public concurrent = 0;
    public maxConcurrent = 0;
    public closed = 0;
    public signals: AbortSignal[] = [];
    /** Values of the next reading; `commits` grows by `rate` per second when unset. */
    public commits = 1000;
    public active: number | undefined = 3;
    private _pending: { resolve: (s: DashboardSample) => void; reject: (e: Error) => void }[] = [];
    /** Answers readings at once instead of waiting for the test. */
    public auto = false;

    sample(signal: AbortSignal): Promise<DashboardSample> {
        this.calls++;
        this.concurrent++;
        this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
        this.signals.push(signal);
        const done = <T>(value: T) => {
            this.concurrent--;
            return value;
        };
        return new Promise<DashboardSample>((resolve, reject) => {
            const entry = {
                resolve: (s: DashboardSample) => resolve(done(s)),
                reject: (e: Error) => reject(done(e)),
            };
            signal.addEventListener("abort", () => entry.reject(new Error("aborted")));
            if (this.auto) {
                entry.resolve(this.reading());
            } else {
                this._pending.push(entry);
            }
        });
    }

    reading(): DashboardSample {
        return { time: Date.now(), values: { active: this.active, commits: this.commits } };
    }

    get waiting(): number {
        return this._pending.length;
    }

    /** Answers the oldest pending reading with the current values. */
    answer(): void {
        const entry = this._pending.shift();
        if (!entry) throw new Error("no reading is waiting");
        entry.resolve(this.reading());
    }

    fail(message: string): void {
        const entry = this._pending.shift();
        if (!entry) throw new Error("no reading is waiting");
        entry.reject(new Error(message));
    }

    async close(): Promise<void> {
        this.closed++;
    }
}

function setup(options: { historySize?: number } = {}) {
    const points: DashboardPoint[] = [];
    const events = {
        onPoints: vi.fn((added: DashboardPoint[]) => points.push(...added)),
        onHistoryReset: vi.fn(() => points.splice(0)),
        onChange: vi.fn(),
    };
    const sampler = new DashboardSampler(events, {
        historySize: options.historySize,
        secondReadingDelay: 1000,
        sampleTimeout: 30000,
    });
    return { sampler, events, points };
}

/** Lets promise callbacks run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});
afterEach(() => {
    vi.useRealTimers();
});

describe("counterRate", () => {
    it("is the difference per second", () => {
        expect(counterRate(100, 0, 150, 2000)).toBe(25);
    });
    it("is undefined when the total went down (restart, reset)", () => {
        expect(counterRate(100, 0, 50, 1000)).toBeUndefined();
    });
    it("is undefined without two readings or without elapsed time", () => {
        expect(counterRate(undefined, 0, 50, 1000)).toBeUndefined();
        expect(counterRate(10, 0, undefined, 1000)).toBeUndefined();
        expect(counterRate(10, 1000, 20, 1000)).toBeUndefined();
        expect(counterRate(10, 2000, 20, 1000)).toBeUndefined();
    });
    it("is zero when nothing happened", () => {
        expect(counterRate(10, 0, 10, 1000)).toBe(0);
    });
});

describe("DashboardHistory", () => {
    it("keeps the last points, oldest first, with increasing sequence numbers", () => {
        const history = new DashboardHistory(3);
        for (let i = 1; i <= 5; i++) history.push(i * 1000, { a: i });
        expect(history.length).toBe(3);
        expect(history.toArray().map((p) => [p.seq, p.time])).toEqual([
            [3, 3000],
            [4, 4000],
            [5, 5000],
        ]);
        expect(history.last?.seq).toBe(5);
    });

    it("never holds more than its capacity", () => {
        const history = new DashboardHistory(600);
        for (let i = 0; i < 3600; i++) history.push(i, { a: i });
        expect(history.length).toBe(600);
        expect(history.toArray()[0].time).toBe(3000);
    });

    it("can be emptied and goes on numbering", () => {
        const history = new DashboardHistory(3);
        history.push(1, {});
        history.clear();
        expect(history.length).toBe(0);
        expect(history.last).toBeUndefined();
        expect(history.push(2, {}).seq).toBe(2);
    });
});

describe("DashboardSampler", () => {
    it("opens with two readings a second apart: gauges at once, rates after the second", async () => {
        const { sampler, points } = setup();
        const session = new FakeSession();
        const opening = sampler.attach(session);
        expect(sampler.state.busy).toBe(true);
        await flush();
        expect(session.waiting).toBe(1);

        session.answer();
        await flush();
        // The gauge shows from the first reading; the counter has no rate yet (key absent).
        expect(points).toHaveLength(1);
        expect(points[0].values).toEqual({ active: 3 });
        expect(sampler.state.latest).toEqual({ active: 3 });

        await vi.advanceTimersByTimeAsync(999);
        expect(session.calls).toBe(1);
        session.commits += 50;
        session.active = 4;
        await vi.advanceTimersByTimeAsync(1);
        expect(session.calls).toBe(2);
        session.answer();
        await opening;

        expect(points).toHaveLength(2);
        expect(points[1].values).toEqual({ active: 4, commits: 50 });
        expect(points[1].time - points[0].time).toBe(1000);
        expect(sampler.state).toMatchObject({ busy: false, error: "", latest: points[1].values });
    });

    it("takes nothing more on its own while auto refresh is off", async () => {
        const { sampler } = setup();
        const session = new FakeSession();
        session.auto = true;
        await runWith(sampler.attach(session));
        expect(session.calls).toBe(2);
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(session.calls).toBe(2);
    });

    it("takes two readings on every manual refresh", async () => {
        const { sampler, points } = setup();
        const session = new FakeSession();
        session.auto = true;
        await runWith(sampler.attach(session));
        await vi.advanceTimersByTimeAsync(60000);
        session.commits += 600;
        const refreshing = sampler.refresh();
        await vi.advanceTimersByTimeAsync(0);
        session.commits += 10;
        await runWith(refreshing);

        expect(session.calls).toBe(4);
        // The rate of the refresh is over its own second, not over the minute since the last one.
        expect(points.at(-1)!.values.commits).toBe(10);
        expect(points.at(-2)!.values).toEqual({ active: 3 });
        // Manual refreshes are not interruptions: no gap between them.
        expect(points.some((p) => p.values.active === null)).toBe(false);
    });

    it("ignores a refresh while a sample is running: sample() is never called concurrently", async () => {
        const { sampler } = setup();
        const session = new FakeSession();
        void sampler.attach(session);
        await flush();
        void sampler.refresh();
        void sampler.refresh();
        await flush();
        expect(session.calls).toBe(1);
        session.answer();
        await vi.advanceTimersByTimeAsync(1000);
        session.answer();
        await flush();
        expect(session.maxConcurrent).toBe(1);
    });

    it("drops the rate when the counter went down, and resumes after", async () => {
        const { sampler, points } = setup();
        const session = new FakeSession();
        session.auto = true;
        await sampler.setAutoRefresh(true);
        sampler.setInterval(1000);
        await runWith(sampler.attach(session));
        session.commits = 10; // server restarted
        await vi.advanceTimersByTimeAsync(1000);
        expect(points.at(-1)!.values.commits).toBeNull();
        expect(sampler.state.latest.commits).toBeNull();
        session.commits = 30;
        await vi.advanceTimersByTimeAsync(1000);
        expect(points.at(-1)!.values.commits).toBe(20);
        sampler.dispose();
    });

    it("shows a value the driver could not read as a gap, never as zero", async () => {
        const { sampler, points } = setup();
        const session = new FakeSession();
        session.auto = true;
        session.active = undefined;
        await runWith(sampler.attach(session));
        expect(points.every((p) => p.values.active === null)).toBe(true);
        expect(sampler.state.latest.active).toBeNull();
    });

    describe("auto refresh", () => {
        it("samples at once when turned on, then once per interval with one reading", async () => {
            const { sampler, points } = setup();
            const session = new FakeSession();
            session.auto = true;
            await runWith(sampler.attach(session));
            expect(session.calls).toBe(2);

            sampler.setInterval(5000);
            await runWith(sampler.setAutoRefresh(true));
            expect(session.calls).toBe(4);
            const before = points.length;
            session.commits += 100;
            // The first tick is one interval after the sample that turned it on.
            await vi.advanceTimersByTimeAsync(4999);
            expect(session.calls).toBe(4);
            await vi.advanceTimersByTimeAsync(1);
            expect(session.calls).toBe(5);
            expect(points).toHaveLength(before + 1);
            expect(points.at(-1)!.values.commits).toBe(20);
            await vi.advanceTimersByTimeAsync(5000);
            expect(session.calls).toBe(6);
            expect(points.at(-1)!.values.commits).toBe(0);
            sampler.dispose();
        });

        it("stops when turned off", async () => {
            const { sampler } = setup();
            const session = new FakeSession();
            session.auto = true;
            sampler.setInterval(1000);
            await runWith(sampler.attach(session));
            await runWith(sampler.setAutoRefresh(true));
            const calls = session.calls;
            await sampler.setAutoRefresh(false);
            await vi.advanceTimersByTimeAsync(60000);
            expect(session.calls).toBe(calls);
        });

        it("skips a tick while the previous sample has not finished", async () => {
            const { sampler } = setup();
            const session = new FakeSession();
            session.auto = true;
            sampler.setInterval(1000);
            await runWith(sampler.attach(session));
            await runWith(sampler.setAutoRefresh(true));
            const skipped = sampler.skippedTicks;
            session.auto = false;
            await vi.advanceTimersByTimeAsync(1000);
            expect(session.waiting).toBe(1);
            // The server takes 3.5 s to answer: three ticks come meanwhile.
            await vi.advanceTimersByTimeAsync(3500);
            expect(session.calls).toBe(5);
            expect(sampler.skippedTicks - skipped).toBe(3);
            session.answer();
            session.auto = true;
            await vi.advanceTimersByTimeAsync(500);
            expect(session.calls).toBe(6);
            expect(session.maxConcurrent).toBe(1);
            sampler.dispose();
        });

        it("pauses while hidden; a resume before the next tick changes nothing", async () => {
            const { sampler, points } = setup();
            const session = new FakeSession();
            session.auto = true;
            sampler.setInterval(10000);
            await runWith(sampler.attach(session));
            await runWith(sampler.setAutoRefresh(true));
            const calls = session.calls;
            const count = points.length;
            sampler.setVisible(false);
            await vi.advanceTimersByTimeAsync(3000);
            sampler.setVisible(true);
            expect(session.calls).toBe(calls);
            // The tick comes when it was due, with one reading and a rate, without a gap.
            await vi.advanceTimersByTimeAsync(6999);
            expect(session.calls).toBe(calls);
            await vi.advanceTimersByTimeAsync(1);
            expect(session.calls).toBe(calls + 1);
            expect(points).toHaveLength(count + 1);
            expect(points.at(-1)!.values.commits).toBe(0);
            sampler.dispose();
        });

        it("leaves no gap after a short hide during the sample that starts the ticks", async () => {
            const { sampler, points } = setup();
            const session = new FakeSession();
            session.auto = true;
            sampler.setInterval(5000);
            await runWith(sampler.attach(session));
            await vi.advanceTimersByTimeAsync(60000);
            const turningOn = sampler.setAutoRefresh(true);
            sampler.setVisible(false);
            await vi.advanceTimersByTimeAsync(200);
            sampler.setVisible(true);
            await runWith(turningOn);
            const count = points.length;
            await vi.advanceTimersByTimeAsync(5000);
            expect(points).toHaveLength(count + 1);
            expect(points.some((p) => p.values.active === null)).toBe(false);
            sampler.dispose();
        });

        it("leaves a gap after a long hide that began during the sample that starts the ticks", async () => {
            const { sampler, points } = setup();
            const session = new FakeSession();
            session.auto = true;
            sampler.setInterval(1000);
            await runWith(sampler.attach(session));
            const turningOn = sampler.setAutoRefresh(true);
            sampler.setVisible(false);
            await runWith(turningOn);
            session.commits += 1_000_000;
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
            const count = points.length;
            sampler.setVisible(true);
            await vi.advanceTimersByTimeAsync(1000);
            const added = points.slice(count);
            expect(added[0].values).toEqual({ active: null, commits: null });
            expect(points.every((p) => (p.values.commits ?? 0) < 1000)).toBe(true);
            sampler.dispose();
        });

        it("runs no timer while there is no session", async () => {
            const { sampler } = setup();
            sampler.setInterval(1000);
            await sampler.setAutoRefresh(true);
            expect(vi.getTimerCount()).toBe(0);
            sampler.dispose();
        });

        it("after a pause that missed ticks, leaves a gap and starts again with two readings", async () => {
            const { sampler, points } = setup();
            const session = new FakeSession();
            session.auto = true;
            sampler.setInterval(1000);
            await runWith(sampler.attach(session));
            await runWith(sampler.setAutoRefresh(true));
            await vi.advanceTimersByTimeAsync(3000);
            const calls = session.calls;
            const last = points.at(-1)!;

            sampler.setVisible(false);
            session.commits += 1_000_000; // heavy activity while nobody looks
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
            expect(session.calls).toBe(calls);

            sampler.setVisible(true);
            await vi.advanceTimersByTimeAsync(1000);
            const added = points.slice(points.indexOf(last) + 1);
            // A gap, then the first reading (gauges only), then a rate over one second.
            expect(added[0].values).toEqual({ active: null, commits: null });
            expect(added[0].time).toBeGreaterThan(last.time);
            expect(added[0].time).toBeLessThan(added[1].time);
            expect(added[1].values).toEqual({ active: 3 });
            expect(added[2].values).toEqual({ active: 3, commits: 0 });
            // No rate is ever computed over the five minutes.
            expect(points.every((p) => (p.values.commits ?? 0) < 1000)).toBe(true);
            sampler.dispose();
        });
    });

    describe("errors", () => {
        it("keeps the history, shows the error, and lets a manual refresh try again", async () => {
            const { sampler, points } = setup();
            const session = new FakeSession();
            session.auto = true;
            await runWith(sampler.attach(session));
            const kept = points.length;

            session.auto = false;
            const failing = sampler.refresh();
            await flush();
            session.fail("permission denied");
            await failing;
            expect(sampler.state).toMatchObject({ busy: false, error: "permission denied" });
            expect(points).toHaveLength(kept);
            expect(sampler.history.length).toBe(kept);

            session.auto = true;
            await runWith(sampler.refresh());
            expect(sampler.state.error).toBe("");
            // A gap separates the points before and after the failure.
            expect(points[kept].values).toEqual({ active: null, commits: null });
        });

        it("does not show an old rate as the last value after a failed sample", async () => {
            const { sampler } = setup();
            const session = new FakeSession();
            session.auto = true;
            await runWith(sampler.attach(session));
            expect(sampler.state.latest.commits).toBe(0);
            session.auto = false;
            const failing = sampler.refresh();
            await flush();
            session.answer(); // the first reading works
            await vi.advanceTimersByTimeAsync(1000);
            session.fail("timeout"); // the second does not
            await failing;
            expect(sampler.state.latest).toEqual({ active: null, commits: null });
        });

        it("goes on ticking after a failed sample of the auto refresh", async () => {
            const { sampler } = setup();
            const session = new FakeSession();
            session.auto = true;
            sampler.setInterval(1000);
            await runWith(sampler.attach(session));
            await runWith(sampler.setAutoRefresh(true));
            session.auto = false;
            await vi.advanceTimersByTimeAsync(1000);
            session.fail("timeout");
            await flush();
            expect(sampler.state.error).toBe("timeout");
            session.auto = true;
            await vi.advanceTimersByTimeAsync(1000);
            // Two readings again: there is no base for the rates any more.
            await vi.advanceTimersByTimeAsync(1000);
            expect(sampler.state.error).toBe("");
            sampler.dispose();
        });

        it("aborts a reading that takes longer than the timeout", async () => {
            const { sampler } = setup();
            const session = new FakeSession();
            void sampler.attach(session);
            await flush();
            await vi.advanceTimersByTimeAsync(30000);
            expect(session.signals[0].aborted).toBe(true);
            expect(sampler.state.busy).toBe(false);
            expect(sampler.state.error).toMatch(/30 seconds/);
        });
    });

    describe("sessions", () => {
        it("closes the session, aborts the running reading and stops ticking on dispose", async () => {
            const { sampler, events } = setup();
            const session = new FakeSession();
            sampler.setInterval(1000);
            await sampler.setAutoRefresh(true);
            void sampler.attach(session);
            await flush();
            await sampler.dispose();
            expect(session.closed).toBe(1);
            expect(session.signals[0].aborted).toBe(true);
            const changes = events.onChange.mock.calls.length;
            await vi.advanceTimersByTimeAsync(60000);
            expect(session.calls).toBe(1);
            expect(events.onChange.mock.calls.length).toBe(changes);
            expect(vi.getTimerCount()).toBe(0);
        });

        it("keeps the history over a reconnection to the same charts, with a gap", async () => {
            const { sampler, points, events } = setup();
            const first = new FakeSession();
            first.auto = true;
            await runWith(sampler.attach(first));
            const kept = points.length;
            await sampler.detach("connection lost");
            expect(first.closed).toBe(1);
            expect(sampler.state).toMatchObject({ attached: false, error: "connection lost" });
            await sampler.refresh(); // nothing to read from
            expect(first.calls).toBe(2);

            await vi.advanceTimersByTimeAsync(5000);
            const second = new FakeSession();
            second.auto = true;
            await runWith(sampler.attach(second));
            expect(events.onHistoryReset).toHaveBeenCalledTimes(1); // the first attach only
            expect(points).toHaveLength(kept + 3);
            expect(points[kept].values).toEqual({ active: null, commits: null });
            expect(sampler.state.error).toBe("");
        });

        it("shows the notices of the session, also those it adds while reading", async () => {
            const { sampler } = setup();
            const session = new FakeSession();
            session.auto = true;
            session.notices = ["Only your own sessions are visible."];
            await runWith(sampler.attach(session));
            expect(sampler.state.notices).toEqual(["Only your own sessions are visible."]);
            session.notices = [...session.notices, "Page I/O could not be read."];
            await runWith(sampler.refresh());
            expect(sampler.state.notices).toHaveLength(2);
        });

        it("empties the history when the charts change", async () => {
            const { sampler, points, events } = setup();
            const first = new FakeSession();
            first.auto = true;
            await runWith(sampler.attach(first));
            const second = new FakeSession();
            second.auto = true;
            second.charts = [charts[0]];
            await runWith(sampler.attach(second));
            expect(events.onHistoryReset).toHaveBeenCalledTimes(2);
            expect(points).toHaveLength(2);
            expect(points[1].values).toEqual({ active: 3 });
        });

        it("ignores a reading that the server dates before the previous point", async () => {
            const { sampler, points } = setup();
            const session = new FakeSession();
            session.auto = true;
            await runWith(sampler.attach(session));
            vi.setSystemTime(Date.now() - 60000);
            await runWith(sampler.refresh());
            expect(points).toHaveLength(2);
            expect(sampler.state.latestTime).toBe(Date.now());
        });
    });
});

/** Runs the timers until the promise settles (the second reading waits a second). */
async function runWith<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    const result = promise.finally(() => (settled = true));
    for (let i = 0; i < 100 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(100);
    }
    return result;
}
