/**
 * The panel of a server dashboard: owns its own connection to the server (a `DashboardSession`)
 * and a `DashboardSampler`, and shows what the sampler reads. Closing the panel closes the
 * connection and stops every timer.
 */

import * as vscode from "vscode";
import { WebviewPanelController } from "../controllers/webviewPanelController";
import type { DashboardSession } from "../drivers/types";
import type { IConnectionProfile } from "../models/interfaces";
import {
    DashboardPointsNotification,
    DashboardReducers,
    DashboardState,
    DASHBOARD_REFRESH_INTERVALS,
    GetDashboardHistoryRequest,
    type DashboardConnectionStatus,
    type DashboardPoint,
} from "../sharedInterfaces/dashboard";
import { getErrorMessage } from "../utils/utils";
import { DashboardSampler, type DashboardSamplerOptions } from "./dashboardSampler";

/** How long closing waits for a connection still being opened (ms). */
const OPENING_WAIT = 3000;

export interface DashboardTarget {
    profile: IConnectionProfile;
    /** Name of the connection, as the Object Explorer shows it. */
    serverName: string;
    engine: string;
    /** Product version, when an open connection of the Object Explorer knows it; else empty. */
    version: string;
}

export interface DashboardSettings {
    autoRefresh: boolean;
    /** In ms, one of DASHBOARD_REFRESH_INTERVALS. */
    interval: number;
    /** Called when the user picks another interval, to offer it again next time. */
    rememberInterval(interval: number): void;
}

/** Opens the dashboard's connection; undefined when the user cancelled (password prompt). */
export type DashboardOpener = (
    profile: IConnectionProfile,
) => Promise<DashboardSession | undefined>;

export class DashboardWebviewController extends WebviewPanelController<
    DashboardState,
    DashboardReducers
> {
    private readonly _sampler: DashboardSampler;
    private _status: DashboardConnectionStatus = "connecting";
    private _historyId = 1;
    private _statePending = false;
    /** Settles once the session is closed, after the panel is. */
    private _closed: Promise<void> = Promise.resolve();
    /** The opening of a connection in progress, if any. */
    private _connecting: Promise<void> | undefined;

    constructor(
        context: vscode.ExtensionContext,
        private readonly _target: DashboardTarget,
        private readonly _open: DashboardOpener,
        private readonly _settings: DashboardSettings,
        samplerOptions: DashboardSamplerOptions = {},
    ) {
        super(
            context,
            "dashboard",
            "Dashboard",
            {
                serverName: _target.serverName,
                engine: _target.engine,
                version: _target.version,
                status: "connecting",
                sampling: false,
                error: "",
                charts: [],
                notices: [],
                autoRefresh: _settings.autoRefresh,
                refreshInterval: _settings.interval,
                latest: {},
                latestTime: 0,
                historyId: 1,
            },
            {
                title: vscode.l10n.t("Dashboard: {0}", _target.serverName),
                viewColumn: vscode.ViewColumn.Active,
                iconPath: {
                    light: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "dashboard_light.svg",
                    ),
                    dark: vscode.Uri.joinPath(context.extensionUri, "media", "dashboard_dark.svg"),
                },
            },
        );

        this._sampler = new DashboardSampler(
            {
                onPoints: (points) => this.sendPoints(points),
                onHistoryReset: () => {
                    this._historyId++;
                    this.scheduleState();
                },
                onChange: () => this.scheduleState(),
            },
            {
                timeoutMessage: (seconds) =>
                    vscode.l10n.t("The statistics were not read within {0} seconds.", seconds),
                ...samplerOptions,
            },
        );
        this._sampler.setInterval(_settings.interval);
        // Turned on before there is a session: the first sample starts the ticks.
        void this._sampler.setAutoRefresh(_settings.autoRefresh);

        this.onRequest(GetDashboardHistoryRequest.type, () => ({
            historyId: this._historyId,
            points: this._sampler.history.toArray(),
        }));
        this.registerReducers();
        this.registerDisposable(
            this.panel.onDidChangeViewState((e) =>
                this._sampler.setVisible(e.webviewPanel.visible),
            ),
        );
        // A panel closed before its page loaded (e.g. a cancelled password prompt) rejects this.
        this.whenWebviewReady().catch(() => undefined);
        this.pushState();
        this.startConnect(true);
    }

    private startConnect(initial: boolean): void {
        // Set at once: a second Reconnect before the page hears of it is ignored.
        this._status = "connecting";
        const connecting = this.connect(initial).finally(() => {
            if (this._connecting === connecting) this._connecting = undefined;
        });
        this._connecting = connecting;
    }

    /**
     * Settles once the dashboard's connection is closed (after the panel was closed). A connection
     * still being opened then is waited for 3 s at most; it is closed whenever it opens.
     */
    public get closed(): Promise<void> {
        return this._closed;
    }

    public override dispose(): void {
        // A connection still being opened is closed as soon as it is open: wait for that too,
        // but not forever (an unanswered password prompt, an unreachable server).
        let timer: ReturnType<typeof setTimeout> | undefined;
        const opening = this._connecting
            ? Promise.race([
                  this._connecting,
                  new Promise<void>((resolve) => (timer = setTimeout(resolve, OPENING_WAIT))),
              ]).finally(() => clearTimeout(timer))
            : undefined;
        this._closed = Promise.all([this._sampler.dispose(), opening]).then(() => undefined);
        super.dispose();
    }

    private registerReducers(): void {
        this.registerReducer("refresh", () => {
            void this._sampler.refresh();
            return this.currentState();
        });
        this.registerReducer("setAutoRefresh", (_state, payload) => {
            void this._sampler.setAutoRefresh(payload.enabled);
            return this.currentState();
        });
        this.registerReducer("setRefreshInterval", (_state, payload) => {
            if (DASHBOARD_REFRESH_INTERVALS.includes(payload.interval)) {
                this._sampler.setInterval(payload.interval);
                this._settings.rememberInterval(payload.interval);
            }
            return this.currentState();
        });
        this.registerReducer("reconnect", () => {
            if (this._status !== "connecting" && !this.isDisposed) {
                // The old connection may be dead and slow to close: do not wait for it.
                void this._sampler.detach();
                this.startConnect(false);
            }
            return this.currentState();
        });
    }

    /**
     * Opens the dashboard's connection and takes the first sample. The panel of a first opening
     * whose password prompt is cancelled closes: the user changed their mind.
     */
    private async connect(initial: boolean): Promise<void> {
        this.scheduleState();
        let session: DashboardSession | undefined;
        try {
            session = await this._open(this._target.profile);
        } catch (error) {
            if (this.isDisposed) return;
            this._status = "disconnected";
            this._sampler.setError(getErrorMessage(error));
            return;
        }
        if (this.isDisposed) {
            await session?.close().catch(() => undefined);
            return;
        }
        if (!session) {
            if (initial) {
                this.panel.dispose();
                return;
            }
            this._status = "disconnected";
            this.scheduleState();
            return;
        }
        this._status = "connected";
        await this._sampler.attach(session);
    }

    private currentState(): DashboardState {
        const sampler = this._sampler.state;
        return {
            ...this.state,
            status: this._status,
            sampling: sampler.busy,
            error: sampler.error,
            charts: [...sampler.charts],
            notices: [...sampler.notices],
            autoRefresh: sampler.autoRefresh,
            refreshInterval: sampler.interval,
            latest: sampler.latest,
            latestTime: sampler.latestTime,
            historyId: this._historyId,
        };
    }

    private pushState(): void {
        if (!this.isDisposed) {
            this.state = this.currentState();
        }
    }

    /** One state message for the several changes of a sample step. */
    private scheduleState(): void {
        if (this._statePending) return;
        this._statePending = true;
        queueMicrotask(() => {
            this._statePending = false;
            this.pushState();
        });
    }

    private sendPoints(points: DashboardPoint[]): void {
        if (this.isDisposed) return;
        void this.sendNotification(DashboardPointsNotification.type, {
            historyId: this._historyId,
            points,
        });
    }
}
