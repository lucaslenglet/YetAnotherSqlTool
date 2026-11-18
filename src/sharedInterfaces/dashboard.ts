/**
 * Contract between the server dashboard's controller (extension) and its page (webview).
 *
 * The state holds what changes rarely or is small (header, charts, notices, last values, status)
 * and is pushed whole, as for the other webviews. The points of the charts are not in the state:
 * the page asks for the whole history once (`GetDashboardHistoryRequest`) and then receives each
 * sample's new points (`DashboardPointsNotification`), so that a refresh every second sends a few
 * numbers instead of the history.
 */

import { NotificationType, RequestType } from "vscode-jsonrpc";
import type { DashboardChart } from "../drivers/types";

/** Intervals offered by the Auto refresh picker, in milliseconds. */
export const DASHBOARD_REFRESH_INTERVALS: readonly number[] = [
    1000, 2000, 5000, 10000, 30000, 60000,
];

/**
 * One point of every series, at the time the values were read (server clock, ms since the epoch).
 *
 * In `values`, a series whose key is absent was not measured by this point (the first of the two
 * readings of a manual refresh has no rates): its line goes on to the next point. A null value is
 * a gap: the value could not be read, or no rate exists (counter reset), or this point only marks
 * an interruption (panel hidden, failed sample, reconnection): its line is broken there. A gap is
 * never drawn as a zero.
 */
export interface DashboardPoint {
    /** Increases by one with each point of the history, from 1. */
    seq: number;
    time: number;
    values: Record<string, number | null>;
}

export type DashboardConnectionStatus = "connecting" | "connected" | "disconnected";

export interface DashboardState {
    /** Name of the connection, as the Object Explorer shows it. */
    serverName: string;
    /** e.g. "PostgreSQL", "Microsoft SQL Server". */
    engine: string;
    /** e.g. "16.0.4135.4 Developer Edition (64-bit)"; empty when unknown. */
    version: string;
    status: DashboardConnectionStatus;
    /** True while a sample (one or two readings) is being taken. */
    sampling: boolean;
    /** Why the last sample, or the connection, failed; empty when it did not. */
    error: string;
    charts: DashboardChart[];
    /** What the login cannot see (partial data), shown above the charts as long as it holds. */
    notices: string[];
    autoRefresh: boolean;
    /** Interval of the auto refresh, in ms (one of DASHBOARD_REFRESH_INTERVALS). */
    refreshInterval: number;
    /** Last value of each series by id; null when it could not be read or computed. */
    latest: Record<string, number | null>;
    /** Time of the last reading (server clock), 0 before the first one. */
    latestTime: number;
    /** Changes when the history is emptied (charts of a new connection): the page asks for it again. */
    historyId: number;
}

export interface DashboardReducers {
    refresh: {};
    setAutoRefresh: { enabled: boolean };
    setRefreshInterval: { interval: number };
    reconnect: {};
}

export interface DashboardHistory {
    historyId: number;
    points: DashboardPoint[];
}

export namespace GetDashboardHistoryRequest {
    export const type = new RequestType<void, DashboardHistory, void>("dashboard/getHistory");
}

/** Points added to the history since the last notification, oldest first. */
export namespace DashboardPointsNotification {
    export const type = new NotificationType<DashboardHistory>("dashboard/points");
}
