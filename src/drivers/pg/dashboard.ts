import type { Client } from "pg";
import type { ConnectParams, DashboardChart, DashboardSample, DashboardSession } from "../types";
import { ClientFactory, resolveOptions } from "./clients";

/** Name of the dashboard's connection in `pg_stat_activity.application_name`. */
export const DASHBOARD_APPLICATION_NAME = "YAST dashboard";

const MINIMUM_VERSION_NUM = 120000;
const CONNECTION_DROPPED =
    "The dashboard's connection to the server was dropped after a sample could not be cancelled. Open the dashboard again.";
/** Time given to the server to cancel a sample before the connection is dropped. */
const CANCEL_GRACE_MS = 5000;

// The charts and the series of each follow pgAdmin's server dashboard (Database sessions,
// Transactions per second, Tuples in, Tuples out, Block I/O); the queries below are adapted from
// the ones of pgAdmin 4 (web/pgadmin/dashboard/templates/dashboard/sql/*), PostgreSQL License,
// Copyright (C) 2013 - 2025, The pgAdmin Development Team. Like pgAdmin's server dashboard, they
// cover every database of the server: the sums are taken over pg_stat_database.
export const PG_DASHBOARD_CHARTS: readonly DashboardChart[] = [
    {
        id: "sessions",
        title: "Database sessions",
        format: "number",
        unit: "",
        series: [
            { id: "sessions.total", label: "Total", kind: "gauge" },
            { id: "sessions.active", label: "Active", kind: "gauge" },
            { id: "sessions.idle", label: "Idle", kind: "gauge" },
        ],
    },
    {
        id: "transactions",
        title: "Transactions per second",
        format: "number",
        unit: "/s",
        series: [
            { id: "transactions.total", label: "Transactions", kind: "counter" },
            { id: "transactions.commits", label: "Commits", kind: "counter" },
            { id: "transactions.rollbacks", label: "Rollbacks", kind: "counter" },
        ],
    },
    {
        id: "tuplesIn",
        title: "Tuples in",
        format: "number",
        unit: "/s",
        series: [
            { id: "tuplesIn.inserts", label: "Inserts", kind: "counter" },
            { id: "tuplesIn.updates", label: "Updates", kind: "counter" },
            { id: "tuplesIn.deletes", label: "Deletes", kind: "counter" },
        ],
    },
    {
        id: "tuplesOut",
        title: "Tuples out",
        format: "number",
        unit: "/s",
        series: [
            { id: "tuplesOut.fetched", label: "Fetched", kind: "counter" },
            { id: "tuplesOut.returned", label: "Returned", kind: "counter" },
        ],
    },
    {
        id: "blockIo",
        title: "Block I/O",
        format: "number",
        unit: "/s",
        series: [
            { id: "blockIo.reads", label: "Reads", kind: "counter" },
            { id: "blockIo.hits", label: "Hits", kind: "counter" },
        ],
    },
];

export const SESSIONS_NOTICE =
    "The session counts are not shown: PostgreSQL only shows the state of other roles' sessions " +
    "to superusers and members of pg_read_all_stats (or pg_monitor), and this role sees only " +
    "its own. Grant pg_monitor to this role to see them.";

/** What a sample reads. The sessions come from `pg_stat_activity`, hence the two variants. */
export function sampleQuery(canSeeSessions: boolean): string {
    const sessions = canSeeSessions
        ? `(SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS sessions_total,
        (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active') AS sessions_active,
        (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'idle') AS sessions_idle,`
        : `NULL AS sessions_total, NULL AS sessions_active, NULL AS sessions_idle,`;
    return `SELECT
        (date_part('epoch', clock_timestamp()) * 1000)::float8 AS time,
        ${sessions}
        d.*
    FROM (
        SELECT
            sum(xact_commit + xact_rollback) AS transactions_total,
            sum(xact_commit) AS transactions_commits,
            sum(xact_rollback) AS transactions_rollbacks,
            sum(tup_inserted) AS tuples_in_inserts,
            sum(tup_updated) AS tuples_in_updates,
            sum(tup_deleted) AS tuples_in_deletes,
            sum(tup_fetched) AS tuples_out_fetched,
            sum(tup_returned) AS tuples_out_returned,
            sum(blks_read) AS block_io_reads,
            sum(blks_hit) AS block_io_hits
        FROM pg_stat_database
    ) d`;
}

/** Column of the sample query -> series id. */
const COLUMN_SERIES: Record<string, string> = {
    sessions_total: "sessions.total",
    sessions_active: "sessions.active",
    sessions_idle: "sessions.idle",
    transactions_total: "transactions.total",
    transactions_commits: "transactions.commits",
    transactions_rollbacks: "transactions.rollbacks",
    tuples_in_inserts: "tuplesIn.inserts",
    tuples_in_updates: "tuplesIn.updates",
    tuples_in_deletes: "tuplesIn.deletes",
    tuples_out_fetched: "tuplesOut.fetched",
    tuples_out_returned: "tuplesOut.returned",
    block_io_reads: "blockIo.reads",
    block_io_hits: "blockIo.hits",
};

/** A row of `sampleQuery` as a sample; a NULL column (nothing readable) is an undefined value. */
export function rowToSample(row: Record<string, unknown>): DashboardSample {
    const values: Record<string, number | undefined> = {};
    for (const [column, id] of Object.entries(COLUMN_SERIES)) {
        const raw = row[column];
        const value = raw === null || raw === undefined ? NaN : Number(raw);
        values[id] = Number.isFinite(value) ? value : undefined;
    }
    return { time: Number(row.time), values };
}

/** Role and server facts read when the dashboard opens. */
const OPENING_QUERY = `SELECT
    current_setting('server_version_num')::int AS version_num,
    -- The role does not exist before PostgreSQL 10: the version is checked before the answer is used.
    CASE WHEN current_setting('server_version_num')::int >= 100000
        THEN pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') END AS sees_sessions`;

export async function openPgDashboard(params: ConnectParams): Promise<DashboardSession> {
    // The profile's own application name is replaced: a DBA must recognize this connection.
    const options = { ...resolveOptions(params), applicationName: DASHBOARD_APPLICATION_NAME };
    const factory = new ClientFactory(options);
    const client = await factory.open(options.database, false);
    try {
        const opening = (await client.query(OPENING_QUERY)).rows[0];
        if (Number(opening.version_num) < MINIMUM_VERSION_NUM) {
            throw new Error("The server dashboard needs PostgreSQL 12 or later.");
        }
        return new PgDashboardSession(
            client,
            factory,
            options.database,
            opening.sees_sessions === true,
        );
    } catch (error) {
        await client.end().catch(() => undefined);
        throw error;
    }
}

class PgDashboardSession implements DashboardSession {
    readonly charts = PG_DASHBOARD_CHARTS;
    readonly notices: readonly string[];
    private readonly query: string;
    private closed = false;
    /** The connection was ended because a cancellation did not reach the server in time. */
    private dropped = false;

    constructor(
        private readonly client: Client,
        private readonly factory: ClientFactory,
        private readonly database: string,
        canSeeSessions: boolean,
    ) {
        this.notices = canSeeSessions ? [] : [SESSIONS_NOTICE];
        this.query = sampleQuery(canSeeSessions);
    }

    async sample(signal: AbortSignal): Promise<DashboardSample> {
        if (this.closed) throw new Error("The dashboard is closed.");
        if (this.dropped) throw new Error(CONNECTION_DROPPED);
        signal.throwIfAborted();
        let finished = false;
        let cancelled: Promise<void> | undefined;
        let giveUp: NodeJS.Timeout | undefined;
        const cancel = () => {
            if (finished || this.closed || cancelled) return;
            cancelled = this.cancelBackend(() => finished).catch(() => undefined);
            // A cancellation that cannot reach the server (a dead network) must not leave the
            // sample waiting for the operating system's TCP timeout: drop the connection. The
            // timer is cleared as soon as the query settles.
            giveUp = setTimeout(() => {
                this.dropped = true;
                void this.client.end().catch(() => undefined);
            }, CANCEL_GRACE_MS);
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
            const result = await this.client.query(this.query);
            finished = true;
            signal.throwIfAborted();
            return rowToSample(result.rows[0]);
        } catch (error) {
            // The statement was cancelled, or the connection ended: say which.
            if (signal.aborted) throw signal.reason ?? new Error("The sample was cancelled.");
            if (this.closed) throw new Error("The dashboard is closed.");
            throw error;
        } finally {
            finished = true;
            signal.removeEventListener("abort", cancel);
            clearTimeout(giveUp);
            // The cancellation should be over before the next sample. It never sends its command
            // once the query has finished, so a slow one is not waited for beyond the grace time.
            if (cancelled) {
                let timer: NodeJS.Timeout | undefined;
                await Promise.race([
                    cancelled,
                    new Promise((resolve) => (timer = setTimeout(resolve, CANCEL_GRACE_MS))),
                ]);
                clearTimeout(timer);
            }
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        // end() destroys the socket of a running query, which then rejects: no cancellation needed.
        await this.client.end().catch(() => undefined);
    }

    /** Asks the server to cancel the running statement, from a short-lived second connection. */
    private async cancelBackend(queryFinished: () => boolean): Promise<void> {
        const pid = (this.client as unknown as { processID: number }).processID;
        const canceller = await this.factory.open(this.database, false);
        try {
            // Too late: the statement is over, and the command could hit the next sample.
            if (queryFinished() || this.closed) return;
            await canceller.query("SELECT pg_cancel_backend($1)", [pid]);
        } finally {
            await canceller.end().catch(() => undefined);
        }
    }
}
