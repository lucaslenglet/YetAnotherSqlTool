import { describe, expect, it } from "vitest";
import { pgDriver } from "../../src/drivers/pg";
import { PG_DASHBOARD_CHARTS, rowToSample, sampleQuery } from "../../src/drivers/pg/dashboard";

const seriesIds = PG_DASHBOARD_CHARTS.flatMap((chart) => chart.series.map((s) => s.id));

describe("PostgreSQL dashboard", () => {
    it("is offered by the driver", () => {
        expect(pgDriver.openDashboard).toBeTypeOf("function");
    });

    it("has unique chart and series ids, and counters where pgAdmin has rates", () => {
        expect(new Set(PG_DASHBOARD_CHARTS.map((c) => c.id)).size).toBe(PG_DASHBOARD_CHARTS.length);
        expect(new Set(seriesIds).size).toBe(seriesIds.length);
        const kinds = (id: string) =>
            new Set(PG_DASHBOARD_CHARTS.find((c) => c.id === id)!.series.map((s) => s.kind));
        expect([...kinds("sessions")]).toEqual(["gauge"]);
        for (const id of ["transactions", "tuplesIn", "tuplesOut", "blockIo"]) {
            expect([...kinds(id)]).toEqual(["counter"]);
        }
    });

    it("turns the text numbers of a row into values, a NULL into undefined", () => {
        const sample = rowToSample({
            time: 1700000000123.5,
            sessions_total: null,
            sessions_active: null,
            sessions_idle: null,
            transactions_total: "12345678901",
            transactions_commits: "12",
            transactions_rollbacks: "0",
            tuples_in_inserts: "1",
            tuples_in_updates: "2",
            tuples_in_deletes: "3",
            tuples_out_fetched: "4",
            tuples_out_returned: "5",
            block_io_reads: "6",
            block_io_hits: "7",
        });
        expect(sample.time).toBe(1700000000123.5);
        expect(Object.keys(sample.values).sort()).toEqual([...seriesIds].sort());
        expect(sample.values["sessions.total"]).toBeUndefined();
        expect(sample.values["transactions.total"]).toBe(12345678901);
        expect(sample.values["transactions.rollbacks"]).toBe(0);
        expect(sample.values["blockIo.hits"]).toBe(7);
    });

    it("reads the sessions only when the role may see them, and never a user table", () => {
        expect(sampleQuery(true)).toContain("pg_stat_activity");
        expect(sampleQuery(false)).not.toContain("pg_stat_activity");
        for (const query of [sampleQuery(true), sampleQuery(false)]) {
            const relations = [...query.matchAll(/\bFROM\s+(\w+)/gi)].map((m) => m[1]);
            expect(relations).toContain("pg_stat_database");
            // Only statistics views, which live in memory.
            expect(relations.filter((name) => !name.startsWith("pg_stat_"))).toEqual([]);
        }
    });
});
