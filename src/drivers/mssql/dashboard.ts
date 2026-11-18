import type * as sql from "mssql";
import type { ConnectParams, DashboardChart, DashboardSample, DashboardSession } from "../types";
import { openPool } from "./connection";
import { assertSupportedAuthenticationType } from "./connectionOptions";
import { DEDICATED_SQL_POOL_ENGINE_EDITION } from "./objectExplorer";

/** Name of the dashboard's connection in `sys.dm_exec_sessions.program_name`. */
export const DASHBOARD_APPLICATION_NAME = "YAST dashboard";

/** EngineEdition of a serverless SQL pool (Azure Synapse). */
const SERVERLESS_SQL_POOL_ENGINE_EDITION = 11;
const AZURE_SQL_DATABASE_ENGINE_EDITION = 5;
const FABRIC_ENGINE_EDITION = 12;

// SQL Server has no screen to copy: the charts take their names from SSMS's Activity Monitor and
// from Performance Monitor's SQL Server objects. A chart has one unit and series of comparable
// magnitudes, which is why page I/O (pages/s) and file I/O (bytes/s) are two charts, and why the
// page life expectancy (seconds, in the thousands) and the cache hit ratio (a percentage) are
// charts of their own.
export const MSSQL_DASHBOARD_CHARTS: readonly DashboardChart[] = [
    {
        id: "sessions",
        title: "User sessions",
        format: "number",
        unit: "",
        series: [
            { id: "sessions.total", label: "Total", kind: "gauge" },
            { id: "sessions.active", label: "Active", kind: "gauge" },
            { id: "sessions.idle", label: "Idle", kind: "gauge" },
        ],
    },
    {
        id: "requests",
        title: "Requests per second",
        format: "number",
        unit: "/s",
        series: [
            { id: "requests.batches", label: "Batch requests", kind: "counter" },
            { id: "requests.transactions", label: "Transactions", kind: "counter" },
        ],
    },
    {
        id: "pageIo",
        title: "Page I/O",
        format: "number",
        unit: "/s",
        series: [
            { id: "pageIo.reads", label: "Page reads", kind: "counter" },
            { id: "pageIo.writes", label: "Page writes", kind: "counter" },
        ],
    },
    {
        id: "fileIo",
        title: "File I/O",
        format: "bytes",
        unit: "/s",
        series: [
            { id: "fileIo.read", label: "Read", kind: "counter" },
            { id: "fileIo.written", label: "Written", kind: "counter" },
        ],
    },
    {
        id: "pageLifeExpectancy",
        title: "Page life expectancy",
        format: "number",
        unit: " s",
        series: [
            { id: "pageLifeExpectancy.seconds", label: "Page life expectancy", kind: "gauge" },
        ],
    },
    {
        id: "bufferCacheHitRatio",
        title: "Buffer cache hit ratio",
        format: "percent",
        unit: "",
        series: [{ id: "bufferCacheHitRatio.ratio", label: "Hit ratio", kind: "gauge" }],
    },
];

// -- sys.dm_os_performance_counters ---------------------------------------------------------

/** A row of `sys.dm_os_performance_counters`, trimmed (its text columns are padded with spaces). */
export interface CounterRow {
    object_name: string;
    counter_name: string;
    instance_name: string;
    cntr_value: number | string | bigint;
}

interface CounterSource {
    /** Object without its instance prefix: "Buffer Manager" for "SQLServer:Buffer Manager" and "MSSQL$NAME:Buffer Manager". */
    object: string;
    counter: string;
    /**
     * For a counter that exists per database or per instance: the row that totals them (`_Total`).
     * Without such a row (some Azure SQL Database versions), the rows are added up.
     */
    total?: string;
    /** Name of the counter this one is a ratio of: the value is then `counter / base`, in percent. */
    base?: string;
}

// The "/sec" counters of this view are cumulative totals (cntr_type 272696576) despite their name.
const COUNTER_SOURCES: Record<string, CounterSource> = {
    "requests.batches": { object: "SQL Statistics", counter: "Batch Requests/sec" },
    "requests.transactions": {
        object: "Databases",
        counter: "Transactions/sec",
        total: "_Total",
    },
    "pageIo.reads": { object: "Buffer Manager", counter: "Page reads/sec" },
    "pageIo.writes": { object: "Buffer Manager", counter: "Page writes/sec" },
    "pageLifeExpectancy.seconds": { object: "Buffer Manager", counter: "Page life expectancy" },
    // cntr_type 537003264: a fraction whose denominator is the "base" counter (cntr_type 1073939712).
    "bufferCacheHitRatio.ratio": {
        object: "Buffer Manager",
        counter: "Buffer cache hit ratio",
        base: "Buffer cache hit ratio base",
    },
};

/** Names of the counters the batch reads. */
const COUNTER_NAMES = [
    ...new Set(
        Object.values(COUNTER_SOURCES).flatMap((s) => (s.base ? [s.counter, s.base] : [s.counter])),
    ),
];

/** "Buffer Manager" for "SQLServer:Buffer Manager" and "MSSQL$NAME:Buffer Manager". */
function objectSuffix(objectName: string): string {
    return objectName.slice(objectName.lastIndexOf(":") + 1).trim();
}

function counterValue(
    rows: readonly CounterRow[],
    object: string,
    counter: string,
    total: string | undefined,
): number | undefined {
    const matching = rows.filter(
        (row) => objectSuffix(row.object_name) === object && row.counter_name.trim() === counter,
    );
    if (matching.length === 0) return undefined;
    const pick = total && matching.filter((row) => row.instance_name.trim() === total);
    const used = pick && pick.length > 0 ? pick : matching;
    let sum = 0;
    for (const row of used) {
        const value = Number(row.cntr_value);
        if (!Number.isFinite(value)) return undefined;
        sum += value;
    }
    return sum;
}

/**
 * Values of the performance-counter series found in `rows`. A series whose counter is missing
 * (not on this version or edition) is undefined; a ratio whose base is missing or zero too.
 */
export function counterSeriesValues(
    rows: readonly CounterRow[],
): Record<string, number | undefined> {
    const values: Record<string, number | undefined> = {};
    for (const [id, source] of Object.entries(COUNTER_SOURCES)) {
        const value = counterValue(rows, source.object, source.counter, source.total);
        if (source.base === undefined) {
            values[id] = value;
            continue;
        }
        const base = counterValue(rows, source.object, source.base, source.total);
        values[id] = value === undefined || !base ? undefined : Math.min(100, (value * 100) / base);
    }
    return values;
}

// -- The batch ------------------------------------------------------------------------------

/** Milliseconds since the Unix epoch, on the server's clock (UTC, so the time zone does not matter). */
// Minutes, not seconds: DATEDIFF returns an int, and seconds since 1970 overflow it in 2038.
const SERVER_TIME = `CAST(DATEDIFF(MINUTE, '19700101', @now) AS bigint) * 60000 + DATEPART(SECOND, @now) * 1000 + DATEPART(MILLISECOND, @now)`;

/**
 * Everything of a sample in one batch, so one round trip. Each group is read in its own TRY block:
 * a view this login or this edition cannot read (Azure SQL Database tiers differ) gives NULLs, or
 * no counter rows, and does not take the other groups down.
 *  1. the time and the sessions (result set 1, one row);
 *  2. the performance-counter rows (result set 2);
 *  3. the file I/O totals (result set 3, one row).
 */
export function sampleBatch(): string {
    return `SET NOCOUNT ON;
DECLARE @now datetime2(3) = SYSUTCDATETIME();
BEGIN TRY
    SELECT ${SERVER_TIME} AS time,
        (SELECT COUNT_BIG(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS sessions_total,
        (SELECT COUNT_BIG(*) FROM sys.dm_exec_sessions s WHERE s.is_user_process = 1
            AND EXISTS (SELECT 1 FROM sys.dm_exec_requests r WHERE r.session_id = s.session_id)) AS sessions_active;
END TRY
BEGIN CATCH
    SELECT ${SERVER_TIME} AS time, CAST(NULL AS bigint) AS sessions_total, CAST(NULL AS bigint) AS sessions_active;
END CATCH;
BEGIN TRY
    SELECT RTRIM(object_name) AS object_name, RTRIM(counter_name) AS counter_name,
        RTRIM(instance_name) AS instance_name, cntr_value
    FROM sys.dm_os_performance_counters
    WHERE RTRIM(counter_name) IN (${COUNTER_NAMES.map((name) => `N'${name}'`).join(", ")});
END TRY
BEGIN CATCH
    SELECT CAST(NULL AS nvarchar(128)) AS object_name, CAST(NULL AS nvarchar(128)) AS counter_name,
        CAST(NULL AS nvarchar(128)) AS instance_name, CAST(NULL AS bigint) AS cntr_value WHERE 1 = 0;
END CATCH;
BEGIN TRY
    SELECT SUM(CAST(num_of_bytes_read AS decimal(38, 0))) AS bytes_read,
        SUM(CAST(num_of_bytes_written AS decimal(38, 0))) AS bytes_written
    FROM sys.dm_io_virtual_file_stats(NULL, NULL);
END TRY
BEGIN CATCH
    SELECT CAST(NULL AS decimal(38, 0)) AS bytes_read, CAST(NULL AS decimal(38, 0)) AS bytes_written;
END CATCH;`;
}

/** What a login without the monitoring permission gets: nothing but the time. */
export function timeOnlyBatch(): string {
    return `SET NOCOUNT ON;
DECLARE @now datetime2(3) = SYSUTCDATETIME();
SELECT ${SERVER_TIME} AS time;`;
}

const SERIES_IDS = MSSQL_DASHBOARD_CHARTS.flatMap((chart) => chart.series.map((s) => s.id));

function numberOrUndefined(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

/** The result sets of `sampleBatch` (or `timeOnlyBatch`) as a sample. */
export function recordsetsToSample(recordsets: readonly (readonly object[])[]): DashboardSample {
    const [first, counters = [], files = []] = recordsets as readonly (readonly Record<
        string,
        unknown
    >[])[];
    const values: Record<string, number | undefined> = Object.fromEntries(
        SERIES_IDS.map((id) => [id, undefined]),
    );
    const total = numberOrUndefined(first[0].sessions_total);
    const active = numberOrUndefined(first[0].sessions_active);
    values["sessions.total"] = total;
    values["sessions.active"] = active;
    values["sessions.idle"] =
        total === undefined || active === undefined ? undefined : Math.max(0, total - active);
    Object.assign(values, counterSeriesValues(counters as unknown as CounterRow[]));
    values["fileIo.read"] = numberOrUndefined(files[0]?.bytes_read);
    values["fileIo.written"] = numberOrUndefined(files[0]?.bytes_written);
    return { time: Number(first[0].time), values };
}

// -- Opening --------------------------------------------------------------------------------

/** Read alone and first: whatever the next query does not know, this one is understood everywhere. */
const EDITION_QUERY = `SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS engineEdition`;

/**
 * The permissions of the login. The "PERFORMANCE STATE" names only exist in SQL Server 2022 and
 * later: an older server gives NULL (read as "no"), and a failure of the whole check is read as
 * "no permission" too.
 */
const PERMISSIONS_QUERY = `BEGIN TRY
    SELECT
        ISNULL(CAST(HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS int), 0) AS serverState,
        ISNULL(CAST(HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER PERFORMANCE STATE') AS int), 0) AS serverPerformanceState,
        ISNULL(CAST(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DATABASE STATE') AS int), 0) AS databaseState,
        ISNULL(CAST(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DATABASE PERFORMANCE STATE') AS int), 0) AS databasePerformanceState;
END TRY
BEGIN CATCH
    SELECT 0 AS serverState, 0 AS serverPerformanceState, 0 AS databaseState, 0 AS databasePerformanceState;
END CATCH`;

export const MISSING_SERVER_PERMISSION_NOTICE =
    "This login cannot read the server's activity: without the VIEW SERVER STATE permission " +
    "(VIEW SERVER PERFORMANCE STATE on SQL Server 2022 and later) SQL Server only shows a login " +
    "its own session, so no value is shown. Grant that permission to the login to see the dashboard.";

export const MISSING_DATABASE_PERMISSION_NOTICE =
    "This login cannot read the database's activity: without the VIEW DATABASE STATE permission " +
    "(VIEW DATABASE PERFORMANCE STATE on SQL Database with the 2022 engine) SQL Database only shows " +
    "a login its own session, so no value is shown. Grant that permission to the user to see the dashboard.";

export const AZURE_SQL_DATABASE_NOTICE =
    "On Azure SQL Database the sessions and file I/O are those of this database, not of the logical server; the performance counters may cover the whole server hosting it (an elastic pool's, for one).";

/** Sentence for series the server did not give although the login has the permission. */
export function unreadableSeriesNotice(
    charts: readonly DashboardChart[],
    sample: DashboardSample,
): string | undefined {
    const missing = charts.flatMap((chart) =>
        chart.series.filter((s) => sample.values[s.id] === undefined).map(() => chart.title),
    );
    const titles = [...new Set(missing)];
    if (titles.length === 0) return undefined;
    return (
        `Not available on this server or with this login: ${titles.join(", ")}. ` +
        "Some of SQL Server's statistics views are restricted on some editions (on Azure SQL " +
        "Database, to the server admin or Microsoft Entra admin on the lower service tiers)."
    );
}

export async function openMssqlDashboard(params: ConnectParams): Promise<DashboardSession> {
    assertSupportedAuthenticationType(params.options.authenticationType);
    // The profile's own application name is replaced: a DBA must recognize this connection.
    const pool = await openPool(
        { ...params, options: { ...params.options, applicationName: DASHBOARD_APPLICATION_NAME } },
        undefined,
        undefined,
        // A sample is one round trip: mssql's own validation query would be a second one.
        true,
    );
    try {
        const edition: number = (await pool.request().query(EDITION_QUERY)).recordset[0]
            .engineEdition;
        if (edition === DEDICATED_SQL_POOL_ENGINE_EDITION) {
            throw new Error(
                "The server dashboard is not available on an Azure Synapse dedicated SQL pool: its statistics views are not the ones of SQL Server.",
            );
        }
        if (edition === SERVERLESS_SQL_POOL_ENGINE_EDITION) {
            throw new Error(
                "The server dashboard is not available on a serverless SQL pool: its statistics views are not the ones of SQL Server.",
            );
        }
        if (edition === FABRIC_ENGINE_EDITION) {
            throw new Error(
                "The server dashboard is not available on a SQL database in Microsoft Fabric.",
            );
        }
        const info = (await pool.request().query(PERMISSIONS_QUERY)).recordset[0];
        const isDatabase = edition === AZURE_SQL_DATABASE_ENGINE_EDITION;
        const allowed = isDatabase
            ? info.databaseState === 1 || info.databasePerformanceState === 1
            : info.serverState === 1 || info.serverPerformanceState === 1;
        const notices: string[] = [];
        if (isDatabase) notices.push(AZURE_SQL_DATABASE_NOTICE);
        if (!allowed) {
            notices.push(
                isDatabase ? MISSING_DATABASE_PERMISSION_NOTICE : MISSING_SERVER_PERMISSION_NOTICE,
            );
        }
        const session = new MssqlDashboardSession(pool, allowed, notices);
        if (allowed) {
            // A first reading tells which views this login or edition cannot read.
            const sample = await session.sample(new AbortController().signal);
            const notice = unreadableSeriesNotice(MSSQL_DASHBOARD_CHARTS, sample);
            if (notice) notices.push(notice);
        }
        return session;
    } catch (error) {
        await pool.close().catch(() => undefined);
        throw error;
    }
}

class MssqlDashboardSession implements DashboardSession {
    readonly charts = MSSQL_DASHBOARD_CHARTS;
    private closed = false;
    private current: sql.Request | undefined;

    constructor(
        private readonly pool: sql.ConnectionPool,
        private readonly allowed: boolean,
        readonly notices: string[],
    ) {}

    async sample(signal: AbortSignal): Promise<DashboardSample> {
        if (this.closed) throw new Error("The dashboard is closed.");
        signal.throwIfAborted();
        const request = this.pool.request();
        this.current = request;
        const cancel = () => request.cancel();
        signal.addEventListener("abort", cancel, { once: true });
        try {
            const result = await request.batch(this.allowed ? sampleBatch() : timeOnlyBatch());
            signal.throwIfAborted();
            return recordsetsToSample(result.recordsets as unknown as object[][]);
        } catch (error) {
            // The batch was cancelled, or the connection ended: say which.
            if (signal.aborted) throw signal.reason ?? new Error("The sample was cancelled.");
            if (this.closed) throw new Error("The dashboard is closed.");
            throw error;
        } finally {
            signal.removeEventListener("abort", cancel);
            this.current = undefined;
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        this.current?.cancel();
        await this.pool.close().catch(() => undefined);
    }
}
