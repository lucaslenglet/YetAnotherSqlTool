import { describe, expect, it, vi } from "vitest";
import {
    DashboardPointsStore,
    MAX_POINTS,
} from "../../src/webviews/pages/Dashboard/dashboardPointsStore";

const point = (seq: number) => ({ seq, time: seq * 1000, values: { a: seq } });

describe("DashboardPointsStore", () => {
    it("takes the history, then appends new points once, telling the charts", () => {
        const store = new DashboardPointsStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.reset({ historyId: 1, points: [point(1), point(2)] });
        // A notification sent while the history was requested overlaps it.
        expect(store.append({ historyId: 1, points: [point(2), point(3)] })).toBe(true);
        expect(store.points.map((p) => p.seq)).toEqual([1, 2, 3]);
        expect(listener).toHaveBeenCalledTimes(2);
        // Nothing new: no redraw.
        store.append({ historyId: 1, points: [point(3)] });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("asks for the history again when the points belong to another one", () => {
        const store = new DashboardPointsStore();
        store.reset({ historyId: 1, points: [point(1)] });
        expect(store.append({ historyId: 2, points: [point(1)] })).toBe(false);
        expect(store.points).toHaveLength(1);
    });

    it("keeps no more points than the extension", () => {
        const store = new DashboardPointsStore();
        store.reset({ historyId: 1, points: [] });
        for (let seq = 1; seq <= 3600; seq++) {
            store.append({ historyId: 1, points: [point(seq)] });
        }
        expect(store.points).toHaveLength(MAX_POINTS);
        expect(store.points[0].seq).toBe(3600 - MAX_POINTS + 1);
    });
});
