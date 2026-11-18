/**
 * The points of the charts in the page: the history requested once, then the new points of each
 * notification. The charts subscribe to it directly, so that a new point redraws them without a
 * React render of the page.
 */

import type { DashboardHistory, DashboardPoint } from "../../../sharedInterfaces/dashboard";

/** Never more points than the extension keeps (its ring buffer holds 600). */
export const MAX_POINTS = 600;

export class DashboardPointsStore {
    private _points: DashboardPoint[] = [];
    private _historyId = 0;
    private readonly _listeners = new Set<() => void>();

    public get points(): readonly DashboardPoint[] {
        return this._points;
    }

    public get historyId(): number {
        return this._historyId;
    }

    public subscribe(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /** The whole history, as the extension sent it. */
    public reset(history: DashboardHistory): void {
        this._historyId = history.historyId;
        this._points = history.points.slice(-MAX_POINTS);
        this.emit();
    }

    /**
     * New points. Points already known (the history request and a notification can overlap) are
     * ignored; points of another history mean the history must be asked again (returns false).
     */
    public append(update: DashboardHistory): boolean {
        if (update.historyId !== this._historyId) {
            return false;
        }
        const lastSeq = this._points.at(-1)?.seq ?? 0;
        const fresh = update.points.filter((p) => p.seq > lastSeq);
        if (fresh.length > 0) {
            const next = this._points.concat(fresh);
            this._points = next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
            this.emit();
        }
        return true;
    }

    private emit(): void {
        for (const listener of this._listeners) listener();
    }
}
