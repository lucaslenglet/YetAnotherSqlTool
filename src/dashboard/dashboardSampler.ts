/**
 * Sampling of a server dashboard: when to read the statistics, how counters become rates, and
 * the history of the charts. Engine-neutral and without `vscode`: the controller wires it to the
 * panel, the unit tests to a fake session and fake timers.
 *
 * Rules (issue #46):
 * - Nothing is read on its own unless auto refresh is on. A manual refresh, the first one included,
 *   takes two readings about a second apart: a counter is a total since the server started, and
 *   only the difference of two readings gives a rate comparable to the auto mode. The first
 *   reading already adds a point with the gauges, so they show without waiting for the second.
 * - Each reading adds a point at its own time (server clock): a few manual refreshes draw an
 *   irregular but honest curve.
 * - Auto refresh pauses while the panel is hidden. If a tick was missed meanwhile, the history
 *   gets a gap (a point of nulls) and sampling starts again with two readings: no line is drawn
 *   over the time nobody looked, and no rate is computed over it as if it were one interval. A
 *   failed sample and a new connection also leave a gap and need two readings again.
 * - A tick that comes while a sample is still running is skipped: `sample()` is never called
 *   concurrently, and queries never pile up on a slow server.
 */

import type {
    DashboardChart,
    DashboardSample,
    DashboardSeries,
    DashboardSession,
} from "../drivers/types";
import type { DashboardPoint } from "../sharedInterfaces/dashboard";

/** About 10 minutes at one sample a second. */
export const DEFAULT_HISTORY_SIZE = 600;
/** Delay between the two readings of a manual refresh. */
export const SECOND_READING_DELAY = 1000;
/** A reading still running after this long is aborted and reported as an error. */
export const SAMPLE_TIMEOUT = 30000;

/** Ring buffer of the last points of a dashboard. */
export class DashboardHistory {
    private readonly _points: (DashboardPoint | undefined)[];
    /** Index of the oldest point. */
    private _start = 0;
    private _length = 0;
    private _nextSeq = 1;

    constructor(public readonly capacity: number = DEFAULT_HISTORY_SIZE) {
        if (!(capacity >= 2)) {
            throw new Error("A dashboard history holds at least two points.");
        }
        this._points = new Array(capacity);
    }

    public get length(): number {
        return this._length;
    }

    /** The newest point, if any. */
    public get last(): DashboardPoint | undefined {
        return this._length === 0
            ? undefined
            : this._points[(this._start + this._length - 1) % this.capacity];
    }

    /** Adds a point, dropping the oldest one when full; returns it with its sequence number. */
    public push(time: number, values: Record<string, number | null>): DashboardPoint {
        const point: DashboardPoint = { seq: this._nextSeq++, time, values };
        if (this._length < this.capacity) {
            this._points[(this._start + this._length) % this.capacity] = point;
            this._length++;
        } else {
            this._points[this._start] = point;
            this._start = (this._start + 1) % this.capacity;
        }
        return point;
    }

    /** The points, oldest first. */
    public toArray(): DashboardPoint[] {
        const result: DashboardPoint[] = [];
        for (let i = 0; i < this._length; i++) {
            result.push(this._points[(this._start + i) % this.capacity]!);
        }
        return result;
    }

    public clear(): void {
        this._points.fill(undefined);
        this._start = 0;
        this._length = 0;
    }
}

/**
 * Rate of a counter between two readings, per second. Undefined when either reading is missing,
 * when the total went down (server restart, statistics reset) or when no time passed.
 */
export function counterRate(
    previous: number | undefined,
    previousTime: number,
    current: number | undefined,
    currentTime: number,
): number | undefined {
    if (previous === undefined || current === undefined) {
        return undefined;
    }
    if (!Number.isFinite(previous) || !Number.isFinite(current)) {
        return undefined;
    }
    const seconds = (currentTime - previousTime) / 1000;
    if (!(seconds > 0) || current < previous) {
        return undefined;
    }
    return (current - previous) / seconds;
}

export interface DashboardSamplerEvents {
    /** Points were added to the history (oldest first). */
    onPoints(points: DashboardPoint[]): void;
    /** The history was emptied: the charts of a new connection differ from the previous ones. */
    onHistoryReset(): void;
    /** Something of `state` changed (busy, error, latest values, session). */
    onChange(): void;
}

export interface DashboardSamplerOptions {
    historySize?: number;
    secondReadingDelay?: number;
    sampleTimeout?: number;
    /** Error message of a reading aborted after `sampleTimeout`. */
    timeoutMessage?: (seconds: number) => string;
}

/** What the sampler shows: read by the controller after `onChange`. */
export interface DashboardSamplerState {
    attached: boolean;
    busy: boolean;
    /** Message of the last failed sample; empty after a successful one. */
    error: string;
    charts: readonly DashboardChart[];
    notices: readonly string[];
    autoRefresh: boolean;
    interval: number;
    latest: Record<string, number | null>;
    latestTime: number;
}

class Aborted extends Error {}

export class DashboardSampler {
    public readonly history: DashboardHistory;

    private _session: DashboardSession | undefined;
    /** Changes with every attach / detach / dispose: a sample of an older one is ignored. */
    private _generation = 0;
    private _abort: AbortController | undefined;
    private _busy = false;
    private _error = "";
    private _charts: readonly DashboardChart[] = [];
    private _series: DashboardSeries[] = [];
    private _notices: readonly string[] = [];
    private _latest: Record<string, number | null> = {};
    private _latestTime = 0;

    /** Previous reading, for the rates of the next one; undefined when it cannot serve. */
    private _baseline: DashboardSample | undefined;
    /** The next point follows an interruption: a gap goes before it. */
    private _gapPending = false;

    private _autoRefresh = false;
    private _interval = 5000;
    private _visible = true;
    private _timer: ReturnType<typeof setTimeout> | undefined;
    /** When the next tick is due (Date.now() clock); kept while the panel is hidden. */
    private _nextTickAt = 0;
    private _disposed = false;
    /** Ticks skipped because a sample was still running. */
    public skippedTicks = 0;

    private readonly _secondReadingDelay: number;
    private readonly _sampleTimeout: number;
    private readonly _timeoutMessage: (seconds: number) => string;

    constructor(
        private readonly _events: DashboardSamplerEvents,
        options: DashboardSamplerOptions = {},
    ) {
        this.history = new DashboardHistory(options.historySize ?? DEFAULT_HISTORY_SIZE);
        this._secondReadingDelay = options.secondReadingDelay ?? SECOND_READING_DELAY;
        this._sampleTimeout = options.sampleTimeout ?? SAMPLE_TIMEOUT;
        this._timeoutMessage =
            options.timeoutMessage ??
            ((seconds) => `The statistics were not read within ${seconds} seconds.`);
    }

    public get state(): DashboardSamplerState {
        return {
            attached: this._session !== undefined,
            busy: this._busy,
            error: this._error,
            charts: this._charts,
            notices: this._notices,
            autoRefresh: this._autoRefresh,
            interval: this._interval,
            latest: { ...this._latest },
            latestTime: this._latestTime,
        };
    }

    // -- session --------------------------------------------------------------------------------

    /**
     * Starts sampling a (new) session and takes a first sample (two readings). The history is
     * kept when the charts are the same as before (a reconnection), with a gap; emptied otherwise.
     */
    public attach(session: DashboardSession): Promise<void> {
        if (this._disposed) {
            void closeQuietly(session);
            return Promise.resolve();
        }
        this.releaseSession();
        this._session = session;
        if (JSON.stringify(session.charts) !== JSON.stringify(this._charts)) {
            this.history.clear();
            this._latest = {};
            this._latestTime = 0;
            this._gapPending = false;
            this._events.onHistoryReset();
        } else {
            this._gapPending = this.history.length > 0;
        }
        this._charts = session.charts;
        this._series = session.charts.flatMap((chart) => chart.series);
        this._notices = [...session.notices];
        this._error = "";
        this._baseline = undefined;
        this._events.onChange();
        return this.startSampling(true);
    }

    /** Stops using the session (closing it) and keeps the history: e.g. before reconnecting. */
    public detach(error = ""): Promise<void> {
        const closing = this.releaseSession();
        this._error = error;
        this._events.onChange();
        return closing;
    }

    /** A failure to connect, shown like a failed sample. */
    public setError(error: string): void {
        this._error = error;
        this._events.onChange();
    }

    private releaseSession(): Promise<void> {
        this._generation++;
        this._abort?.abort();
        this._abort = undefined;
        this._busy = false;
        this._baseline = undefined;
        if (this.history.length > 0) {
            this._gapPending = true;
        }
        const session = this._session;
        this._session = undefined;
        return session ? closeQuietly(session) : Promise.resolve();
    }

    /** Stops the timers, aborts a running sample and closes the session. */
    public dispose(): Promise<void> {
        if (this._disposed) {
            return Promise.resolve();
        }
        this._disposed = true;
        this.clearTimer();
        return this.releaseSession();
    }

    // -- refresh --------------------------------------------------------------------------------

    /**
     * Manual refresh: two readings a second apart. Ignored while a sample is running or without
     * a session (the page disables its button then).
     */
    public refresh(): Promise<void> {
        return this.sampleNow(true);
    }

    /** Turns auto refresh on or off; turning it on samples at once (two readings). */
    public setAutoRefresh(enabled: boolean): Promise<void> {
        if (enabled === this._autoRefresh) {
            return Promise.resolve();
        }
        this._autoRefresh = enabled;
        this._events.onChange();
        if (!enabled) {
            this.clearTimer();
            return Promise.resolve();
        }
        return this.startSampling(true);
    }

    /** Changes the interval of the auto refresh; the next tick is one new interval away. */
    public setInterval(interval: number): void {
        if (!(interval > 0) || interval === this._interval) {
            return;
        }
        this._interval = interval;
        this._events.onChange();
        if (this._autoRefresh) {
            this.restartTicks();
        }
    }

    /** The panel was hidden or shown: auto refresh pauses while it is hidden. */
    public setVisible(visible: boolean): void {
        if (visible === this._visible || this._disposed) {
            return;
        }
        this._visible = visible;
        if (!this._autoRefresh) {
            return;
        }
        if (!visible) {
            this.clearTimer();
            return;
        }
        const now = Date.now();
        if (this._nextTickAt === Number.POSITIVE_INFINITY) {
            // Hidden while the sample that starts the ticks ran: nothing was missed.
            if (!this._busy) this.restartTicks();
            return;
        }
        if (now < this._nextTickAt) {
            // No tick was missed: the series goes on as if nothing happened.
            this.schedule(this._nextTickAt - now);
            return;
        }
        // Ticks were missed: the next point is not one interval after the previous one.
        this._baseline = undefined;
        if (this.history.length > 0) {
            this._gapPending = true;
        }
        void this.startSampling(false);
    }

    /**
     * Samples now, then starts the ticks of the auto refresh (when on) one interval after that
     * sample: a first tick during its second reading would only be skipped.
     */
    private async startSampling(twoReadings: boolean): Promise<void> {
        this.clearTimer();
        // No tick is due before this sample ends (a hide meanwhile misses nothing).
        this._nextTickAt = Number.POSITIVE_INFINITY;
        try {
            await this.sampleNow(twoReadings);
        } finally {
            if (this._timer === undefined) {
                this.restartTicks();
            }
        }
    }

    private restartTicks(): void {
        this.clearTimer();
        if (!this._autoRefresh || this._disposed || !this._session) {
            return;
        }
        if (this._visible) {
            this.schedule(this._interval);
        } else {
            // Hidden: no timer, but a tick is due then, so that a long hide is seen as one.
            this._nextTickAt = Date.now() + this._interval;
        }
    }

    private schedule(delay: number): void {
        this.clearTimer();
        this._nextTickAt = Date.now() + delay;
        this._timer = setTimeout(() => {
            this._timer = undefined;
            this.schedule(this._interval);
            this.tick();
        }, delay);
    }

    private clearTimer(): void {
        if (this._timer !== undefined) {
            clearTimeout(this._timer);
            this._timer = undefined;
        }
    }

    private tick(): void {
        if (this._busy || !this._session) {
            this.skippedTicks++;
            return;
        }
        void this.sampleNow(false);
    }

    // -- sampling -------------------------------------------------------------------------------

    /**
     * Takes a sample: one reading when the previous one can serve as the base of the rates, two
     * (a second apart) otherwise or when `twoReadings`.
     */
    private async sampleNow(twoReadings: boolean): Promise<void> {
        const session = this._session;
        if (!session || this._busy || this._disposed) {
            return;
        }
        const generation = this._generation;
        const abort = new AbortController();
        this._abort = abort;
        this._busy = true;
        this._events.onChange();
        const current = () => this._generation === generation && !abort.signal.aborted;
        try {
            if (twoReadings || !this._baseline) {
                const first = await this.read(session, abort.signal);
                if (!current()) return;
                this.addReading(first, undefined);
                this._baseline = first;
                this._events.onChange();
                await delay(this._secondReadingDelay, abort.signal);
                if (!current()) return;
            }
            const reading = await this.read(session, abort.signal);
            if (!current()) return;
            // A session may learn about what its login cannot see while it reads.
            if (session.notices.join("\n") !== this._notices.join("\n")) {
                this._notices = [...session.notices];
            }
            this.addReading(reading, this._baseline);
            this._baseline = reading;
            this._error = "";
        } catch (error) {
            // Aborted by a detach or dispose: nothing to report on a session that is gone.
            if (!current()) {
                return;
            }
            this._error = error instanceof Error ? error.message : String(error);
            this._baseline = undefined;
            // Nothing was measured now: the tiles must not show older values as the last ones.
            for (const series of this._series) {
                this._latest[series.id] = null;
            }
            if (this.history.length > 0) {
                this._gapPending = true;
            }
        } finally {
            if (this._generation === generation) {
                this._busy = false;
                if (this._abort === abort) {
                    this._abort = undefined;
                }
                this._events.onChange();
            }
        }
    }

    /** One call of `sample()`, aborted after the timeout. */
    private async read(session: DashboardSession, signal: AbortSignal): Promise<DashboardSample> {
        const own = new AbortController();
        const onAbort = () => own.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            own.abort();
        }, this._sampleTimeout);
        try {
            return await session.sample(own.signal);
        } catch (error) {
            if (timedOut) {
                throw new Error(this._timeoutMessage(Math.round(this._sampleTimeout / 1000)));
            }
            throw error;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
        }
    }

    /**
     * Adds the point of a reading: gauges as read, counters as their rate since `base` (absent
     * without a base). A value the driver could not read is a gap (null), never a zero.
     */
    private addReading(reading: DashboardSample, base: DashboardSample | undefined): void {
        const values: Record<string, number | null> = {};
        for (const series of this._series) {
            const value = finite(reading.values[series.id]);
            if (series.kind === "gauge") {
                values[series.id] = value ?? null;
            } else if (base) {
                values[series.id] =
                    counterRate(finite(base.values[series.id]), base.time, value, reading.time) ??
                    null;
            }
        }
        for (const [id, value] of Object.entries(values)) {
            this._latest[id] = value;
        }
        this._latestTime = reading.time;

        const last = this.history.last;
        if (last && reading.time <= last.time) {
            // The server's clock went back: the time axis cannot go back with it.
            return;
        }
        const added: DashboardPoint[] = [];
        if (this._gapPending && last) {
            const gap: Record<string, number | null> = {};
            for (const series of this._series) {
                gap[series.id] = null;
            }
            added.push(this.history.push((last.time + reading.time) / 2, gap));
        }
        this._gapPending = false;
        added.push(this.history.push(reading.time, values));
        this._events.onPoints(added);
    }
}

function finite(value: number | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Aborted());
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Aborted());
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

async function closeQuietly(session: DashboardSession): Promise<void> {
    try {
        await session.close();
    } catch {
        // Already closed or the connection is gone: nothing left to release.
    }
}
