import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { Dashboards, LAST_INTERVAL_KEY } from "../../src/dashboard/dashboardCommands";
import {
    DashboardWebviewController,
    type DashboardOpener,
} from "../../src/dashboard/dashboardWebviewController";
import type { DashboardChart, DashboardSample, DashboardSession } from "../../src/drivers/types";
import type { IConnectionProfile } from "../../src/models/interfaces";
import type { DashboardState } from "../../src/sharedInterfaces/dashboard";

const charts: DashboardChart[] = [
    {
        id: "sessions",
        title: "Sessions",
        format: "number",
        unit: "",
        series: [{ id: "total", label: "Total", kind: "gauge" }],
    },
    {
        id: "tx",
        title: "Transactions",
        format: "number",
        unit: "/s",
        series: [{ id: "commits", label: "Commits", kind: "counter" }],
    },
];

class FakeSession implements DashboardSession {
    charts = charts;
    notices = ["Only your own sessions are counted without VIEW SERVER STATE."];
    calls = 0;
    closed = 0;
    commits = 100;
    fail: string | undefined;
    hang = false;

    async sample(signal: AbortSignal): Promise<DashboardSample> {
        this.calls++;
        if (this.hang) {
            await new Promise((_, reject) =>
                signal.addEventListener("abort", () => reject(new Error("aborted"))),
            );
        }
        if (this.fail) throw new Error(this.fail);
        this.commits += 10;
        return { time: Date.now(), values: { total: 7, commits: this.commits } };
    }

    async close(): Promise<void> {
        this.closed++;
    }
}

/** A panel whose visibility and closing the test controls. */
function fakePanel(title: string) {
    const disposed = new vscode.EventEmitter<void>();
    const viewState = new vscode.EventEmitter<{ webviewPanel: { visible: boolean } }>();
    const panel = {
        title,
        visible: true,
        webview: {
            html: "",
            cspSource: "",
            asWebviewUri: (uri: vscode.Uri) => uri,
            onDidReceiveMessage: () => ({ dispose: () => undefined }),
            postMessage: async () => true,
        },
        onDidDispose: disposed.event,
        onDidChangeViewState: viewState.event,
        reveal: vi.fn(),
        dispose: vi.fn(() => disposed.fire()),
        iconPath: undefined,
        setVisible(visible: boolean) {
            panel.visible = visible;
            viewState.fire({ webviewPanel: { visible } });
        },
    };
    return panel;
}

class MemoryMemento {
    values = new Map<string, unknown>();
    get<T>(key: string) {
        return this.values.get(key) as T;
    }
    async update(key: string, value: unknown) {
        this.values.set(key, value);
    }
}

let globalState: MemoryMemento;
let panels: ReturnType<typeof fakePanel>[];

function context(): vscode.ExtensionContext {
    return {
        extensionUri: vscode.Uri.file("/ext"),
        extensionPath: "/ext",
        subscriptions: [],
        globalState,
    } as unknown as vscode.ExtensionContext;
}

const profile = {
    id: "pg-1",
    provider: "pg",
    server: "localhost",
    database: "postgres",
    user: "me",
    authenticationType: "SqlLogin",
} as unknown as IConnectionProfile;

async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

function open(opener: DashboardOpener, autoRefresh = false, interval = 5000) {
    const remembered: number[] = [];
    const controller = new DashboardWebviewController(
        context(),
        { profile, serverName: "localhost", engine: "PostgreSQL", version: "17.2" },
        opener,
        { autoRefresh, interval, rememberInterval: (ms) => remembered.push(ms) },
        { secondReadingDelay: 5 },
    );
    return { controller, remembered, panel: panels.at(-1)! };
}

async function dispatch(controller: DashboardWebviewController, type: string, payload = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reducer = (controller as any)._reducerHandlers.get(type);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).state = await reducer(controller.state, payload);
}

const state = (controller: DashboardWebviewController): DashboardState => controller.state;

beforeEach(() => {
    globalState = new MemoryMemento();
    panels = [];
    vi.mocked(vscode.window.createWebviewPanel).mockImplementation(((
        _type: string,
        title: string,
    ) => {
        const panel = fakePanel(title);
        panels.push(panel);
        return panel;
    }) as never);
});

afterEach(() => {
    vi.mocked(vscode.window.createWebviewPanel).mockReset();
});

describe("DashboardWebviewController", () => {
    it("opens its own session and shows the first sample, the notices and the header", async () => {
        const session = new FakeSession();
        const { controller, panel } = open(async () => session);
        expect(panel.title).toBe("Dashboard: localhost");
        expect(state(controller).status).toBe("connecting");

        await until(() => session.calls === 2 && !state(controller).sampling, "two readings");
        expect(state(controller)).toMatchObject({
            serverName: "localhost",
            engine: "PostgreSQL",
            version: "17.2",
            status: "connected",
            error: "",
            notices: session.notices,
            latest: { total: 7, commits: expect.any(Number) },
        });
        expect(state(controller).charts.map((c) => c.id)).toEqual(["sessions", "tx"]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const history = (controller as any)._sampler.history.toArray();
        expect(history).toHaveLength(2);
        panel.dispose();
        await controller.closed;
        expect(session.closed).toBe(1);
    });

    it("closes the panel when the password prompt of the first opening is cancelled", async () => {
        const { controller, panel } = open(async () => undefined);
        await until(() => controller.isDisposed, "the panel to close");
        expect(panel.dispose).toHaveBeenCalled();
    });

    it("shows a failure to connect, and reconnects on demand", async () => {
        let attempt = 0;
        const session = new FakeSession();
        const { controller } = open(async () => {
            if (attempt++ === 0) throw new Error("password authentication failed");
            return session;
        });
        await until(() => state(controller).status === "disconnected", "the failure");
        expect(state(controller).error).toBe("password authentication failed");

        await dispatch(controller, "reconnect");
        await until(() => session.calls === 2 && !state(controller).sampling, "the reconnection");
        expect(state(controller)).toMatchObject({ status: "connected", error: "" });
        controller.panel.dispose();
        await controller.closed;
        expect(session.closed).toBe(1);
    });

    it("opens one connection for two quick clicks on Reconnect", async () => {
        const opener = vi.fn(async () => new FakeSession() as DashboardSession);
        const { controller } = open(opener);
        await until(() => state(controller).status === "connected", "the first connection");
        await Promise.all([dispatch(controller, "reconnect"), dispatch(controller, "reconnect")]);
        await until(
            () => state(controller).status === "connected" && !state(controller).sampling,
            "the reconnection",
        );
        expect(opener).toHaveBeenCalledTimes(2);
        controller.panel.dispose();
        await controller.closed;
    });

    it("keeps the history over a reconnection and closes the previous session", async () => {
        const first = new FakeSession();
        const second = new FakeSession();
        const sessions = [first, second];
        const { controller } = open(async () => sessions.shift());
        await until(() => first.calls === 2 && !state(controller).sampling, "the first sample");
        first.fail = "terminating connection due to administrator command";
        await dispatch(controller, "refresh");
        await until(() => state(controller).error !== "", "the failure");
        expect(state(controller).status).toBe("connected");

        await dispatch(controller, "reconnect");
        await until(() => second.calls === 2 && !state(controller).sampling, "the new sample");
        expect(first.closed).toBe(1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const history = (controller as any)._sampler.history.toArray();
        // Two points, a gap, two points.
        expect(history).toHaveLength(5);
        expect(history[2].values).toEqual({ total: null, commits: null });
        controller.panel.dispose();
        await controller.closed;
        expect(second.closed).toBe(1);
    });

    it("pauses auto refresh while the panel is hidden", async () => {
        const session = new FakeSession();
        const { controller, panel } = open(async () => session, true, 1000);
        await until(() => session.calls === 2 && !state(controller).sampling, "the first sample");
        expect(state(controller).autoRefresh).toBe(true);
        panel.setVisible(false);
        const calls = session.calls;
        await new Promise((r) => setTimeout(r, 1300));
        expect(session.calls).toBe(calls);
        panel.setVisible(true);
        await until(() => session.calls > calls, "sampling again");
        panel.dispose();
        await controller.closed;
    });

    it("remembers the interval the user picks, and ignores one it does not offer", async () => {
        const session = new FakeSession();
        const { controller, remembered } = open(async () => session);
        await dispatch(controller, "setRefreshInterval", { interval: 10000 });
        await dispatch(controller, "setRefreshInterval", { interval: 1234 });
        expect(remembered).toEqual([10000]);
        expect(state(controller).refreshInterval).toBe(10000);
        await dispatch(controller, "setAutoRefresh", { enabled: true });
        expect(state(controller).autoRefresh).toBe(true);
        controller.panel.dispose();
        await controller.closed;
    });

    it("aborts a running reading and closes the session when the panel closes", async () => {
        const session = new FakeSession();
        session.hang = true;
        const { controller, panel } = open(async () => session);
        await until(() => session.calls === 1, "the first reading");
        panel.dispose();
        await controller.closed;
        expect(session.closed).toBe(1);
    });

    it("closes a session that opens after the panel was closed", async () => {
        const session = new FakeSession();
        let resolve!: (s: DashboardSession) => void;
        const { controller, panel } = open(() => new Promise((r) => (resolve = r)));
        panel.dispose();
        resolve(session);
        await until(() => session.closed === 1, "the late session to be closed");
        expect(session.calls).toBe(0);
        expect(controller.isDisposed).toBe(true);
    });
});

describe("Dashboards", () => {
    it("opens one panel per connection, shows it again, and opens a new one once closed", async () => {
        const sessions: FakeSession[] = [];
        const connector = {
            openDashboard: vi.fn(async () => {
                const session = new FakeSession();
                session.hang = true;
                sessions.push(session);
                return session;
            }),
        };
        const dashboards = new Dashboards(context(), connector);
        dashboards.open(profile);
        dashboards.open({ ...profile });
        expect(panels).toHaveLength(1);
        expect(panels[0].reveal).toHaveBeenCalledTimes(1);

        dashboards.open({ ...profile, id: "other" });
        expect(panels).toHaveLength(2);

        panels[0].dispose();
        dashboards.open(profile);
        expect(panels).toHaveLength(3);

        await until(() => sessions.length === 3, "the sessions");
        await dashboards.closeAll();
        expect(sessions.map((s) => s.closed)).toEqual([1, 1, 1]);
    });

    it("offers the interval picked last time, auto refresh off by default", async () => {
        globalState.values.set(LAST_INTERVAL_KEY, 30000);
        // Still connecting while the test looks.
        const connector = { openDashboard: vi.fn(() => new Promise<undefined>(() => undefined)) };
        const dashboards = new Dashboards(context(), connector);
        dashboards.open(profile, {
            productName: "PostgreSQL",
            serverVersion: "17.2",
            edition: "",
            isCloud: false,
            userName: "me",
        });
        await until(() => panels.length === 1, "the panel");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const controller = (dashboards as any)._panels.get("id:pg-1") as DashboardWebviewController;
        expect(state(controller)).toMatchObject({
            autoRefresh: false,
            refreshInterval: 30000,
            version: "17.2",
            engine: "PostgreSQL",
        });
        await dashboards.closeAll();
    });

    it("starts in auto refresh when the setting asks for it", async () => {
        const getConfiguration = vi.spyOn(vscode.workspace, "getConfiguration");
        getConfiguration.mockReturnValue({
            get: <T>(key: string, fallback?: T) =>
                (key === "dashboard.refreshInterval" ? 2 : fallback) as T,
        } as never);
        try {
            globalState.values.set(LAST_INTERVAL_KEY, 30000);
            const connector = { openDashboard: vi.fn(async () => undefined) };
            const dashboards = new Dashboards(context(), connector);
            dashboards.open(profile);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const controller = (dashboards as any)._panels.get("id:pg-1");
            expect(state(controller)).toMatchObject({ autoRefresh: true, refreshInterval: 2000 });
            await dashboards.closeAll();
        } finally {
            getConfiguration.mockRestore();
        }
    });
});
