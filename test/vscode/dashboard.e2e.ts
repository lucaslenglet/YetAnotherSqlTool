// The server dashboard, opened from the Object Explorer's context menu of each test server: its
// tiles and charts show plausible values, Refresh and Auto refresh take samples, a login without
// the monitoring permission sees the notice of partial data, a connection killed on the server
// shows the error and can be reopened, and closing the panel closes its connection.

import * as assert from "node:assert";
import * as sql from "mssql";
import { Client } from "pg";
import * as vscode from "vscode";
import { jsLiteral, workbench, type Webview } from "./cdp";
import { env, profile, type TestProfile } from "./env";
import {
    errorNotifications,
    objectExplorerRows,
    pickFromCommand,
    sleep,
    waitFor,
    waitForWebview,
} from "./helpers";

type Provider = TestProfile["provider"];

/** Runs SQL on a test server with its own client, outside the extension. */
async function query(p: TestProfile, text: string): Promise<unknown[][]> {
    if (p.provider === "pg") {
        const client = new Client({
            host: p.server,
            port: p.port,
            user: p.user,
            password: p.password,
            database: p.database,
        });
        await client.connect();
        try {
            const result = await client.query({ text, rowMode: "array" });
            return result.rows ?? [];
        } finally {
            await client.end();
        }
    }
    const [host, port] = p.server.split(",");
    const pool = await new sql.ConnectionPool({
        server: host,
        port: Number(port),
        user: p.user,
        password: p.password,
        database: p.database,
        options: { encrypt: true, trustServerCertificate: true },
    }).connect();
    try {
        const result = await pool.request().batch(text);
        return (result.recordset ?? []).map((r: Record<string, unknown>) => Object.values(r));
    } finally {
        await pool.close();
    }
}

/** Sessions the dashboards have open on a server (they are named "YAST dashboard"). */
async function dashboardSessions(p: TestProfile): Promise<number> {
    const rows = await query(
        p,
        p.provider === "pg"
            ? "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'YAST dashboard'"
            : "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE program_name = 'YAST dashboard'",
    );
    return Number(rows[0][0]);
}

/** Small transactions on the server for a while, so that the rates are not all zero. */
async function activity(p: TestProfile, ms: number): Promise<void> {
    const end = Date.now() + ms;
    const batch =
        p.provider === "pg"
            ? "BEGIN; SELECT count(*) FROM pg_class; COMMIT;"
            : "BEGIN TRAN; SELECT COUNT(*) FROM sys.objects; COMMIT;";
    while (Date.now() < end) {
        await query(p, batch.repeat(20));
    }
}

/** Right-clicks a row of the Object Explorer and picks an entry of its context menu. */
async function contextMenu(rowLabel: string, entry: string): Promise<void> {
    const row = await waitFor(`the Object Explorer row "${rowLabel}"`, async () =>
        (await objectExplorerRows()).find((r) => r.label === rowLabel),
    );
    const window = await workbench();
    const click = { x: row!.x, y: row!.y, button: "right", clickCount: 1 };
    await window.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: row!.x, y: row!.y });
    await window.send("Input.dispatchMouseEvent", { type: "mousePressed", ...click });
    await window.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...click });
    // Context menus are drawn in a shadow root of the workbench.
    const item = await waitFor(`"${entry}" in the context menu of "${rowLabel}"`, () =>
        window.evaluate<{ x: number; y: number } | null>(`(() => {
            const roots = [document, ...[...document.querySelectorAll("*")]
                .filter((e) => e.shadowRoot).map((e) => e.shadowRoot)];
            for (const root of roots) {
                const label = [...root.querySelectorAll(".monaco-menu .action-label")]
                    .find((l) => l.textContent.trim() === ${jsLiteral(entry)});
                if (label) {
                    const box = label.getBoundingClientRect();
                    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
                }
            }
            return null;
        })()`),
    );
    // A menu ignores a click that comes right after it opened: wait, click, and if it stays
    // open, accept the entry under the pointer with Enter.
    await sleep(300);
    await window.clickAt(item!.x, item!.y);
    const menuOpen = () =>
        window.evaluate<boolean>(`[document, ...[...document.querySelectorAll("*")]
            .filter((e) => e.shadowRoot).map((e) => e.shadowRoot)]
            .some((root) => [...root.querySelectorAll(".monaco-menu")].some((m) => m.offsetParent !== null))`);
    for (let i = 0; i < 10 && (await menuOpen()); i++) {
        await sleep(200);
    }
    if (await menuOpen()) {
        const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
        await window.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
        await window.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    }
    await waitFor("the context menu to close", async () => !(await menuOpen()));
}

/** Connects the row of a profile in the Object Explorer (expanding it), unless it is already. */
async function connectInTree(name: string): Promise<void> {
    await vscode.commands.executeCommand("yastObjectExplorer.focus");
    const rows = await waitFor(`"${name}" in the tree`, objectExplorerRows, (list) =>
        list.some((r) => r.label === name),
    );
    const row = rows.find((r) => r.label === name)!;
    if (row.expanded !== "true") {
        const window = await workbench();
        await window.clickAt(row.x, row.y);
    }
    await waitFor(
        `"${name}" connected`,
        async () => {
            const list = await objectExplorerRows();
            const index = list.findIndex((r) => r.label === name);
            return list[index + 1]?.label === "Databases";
        },
        Boolean,
        40000,
    );
}

interface Tile {
    chart: string;
    series: string;
    label: string;
    value: string;
}

/** What the page shows: header, banners, tiles and the size of each chart's canvas. */
function readPage(webview: Webview) {
    return webview.evaluate<{
        title: string;
        subtitle: string;
        updated: string;
        notices: string;
        error: string;
        tiles: Tile[];
        canvases: { chart: string; width: number; height: number; label: string }[];
    }>(`(() => ({
        title: document.querySelector("h1")?.textContent ?? "",
        subtitle: document.querySelector("h1")?.nextElementSibling?.textContent ?? "",
        updated: [...document.querySelectorAll("span")].find((s) => s.textContent.startsWith("Read at"))?.textContent ?? "",
        notices: document.querySelector('[data-dashboard="notices"]')?.innerText ?? "",
        error: document.querySelector('[data-dashboard="error"]')?.innerText ?? "",
        tiles: [...document.querySelectorAll("[data-chart] [data-series]")].map((t) => ({
            chart: t.closest("[data-chart]").getAttribute("data-chart"),
            series: t.getAttribute("data-series"),
            label: t.querySelector("dt").textContent,
            value: t.querySelector("dd").textContent,
        })),
        canvases: [...document.querySelectorAll("[data-chart-id]")].map((c) => ({
            chart: c.getAttribute("data-chart-id"),
            width: c.querySelector("canvas")?.width ?? 0,
            height: c.querySelector("canvas")?.height ?? 0,
            label: c.getAttribute("aria-label"),
        })),
    }))()`);
}

/** Picture of every chart, to tell that new points were drawn. */
function chartPictures(webview: Webview): Promise<string[] | null> {
    return webview.evaluate<string[]>(
        `[...document.querySelectorAll("[data-chart-id] canvas")].map((c) => c.toDataURL())`,
    );
}

async function clickButton(webview: Webview, text: string): Promise<void> {
    const clicked = await webview.evaluate<boolean>(`(() => {
        const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${jsLiteral(text)});
        if (!button || button.disabled) return false;
        button.click();
        return true;
    })()`);
    assert.ok(clicked, `no enabled "${text}" button in the dashboard`);
}

async function setAutoRefresh(webview: Webview, interval: number, on: boolean): Promise<void> {
    await webview.evaluate(`(() => {
        const select = document.querySelector("select");
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(select, ${jsLiteral(String(interval))});
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
    })()`);
    await waitFor("the interval", () =>
        webview.evaluate<boolean>(
            `document.querySelector("select").value === ${jsLiteral(String(interval))}`,
        ),
    );
    const toggle = `document.querySelector('input[role="switch"]')`;
    await webview.evaluate(`${toggle}.checked !== ${on} && ${toggle}.click()`);
    await waitFor(`auto refresh ${on ? "on" : "off"}`, () =>
        webview.evaluate<boolean>(`${toggle}.checked === ${on}`),
    );
}

function dashboardTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
            (tab) =>
                tab.input instanceof vscode.TabInputWebview && tab.label.startsWith("Dashboard: "),
        );
}

async function closeDashboards(): Promise<void> {
    await vscode.window.tabGroups.close(dashboardTabs());
}

/** A plausible number in a tile: digits, perhaps a K/M suffix, a size or a unit. */
const NUMBER = /^-?[\d.,]+\s?(K|M|B|T|KB|MB|GB|TB)?(\/s| s|%)?$/;

const dashboardWebviews: Webview[] = [];

describe("Server dashboard", () => {
    before(async () => {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    after(async () => {
        await closeDashboards();
    });

    for (const provider of ["pg", "mssql"] as Provider[]) {
        describe(provider, () => {
            const p = () => profile(provider);
            let webview: Webview;

            it("opens from the context menu of the connected server with tiles and charts", async () => {
                await connectInTree(p().profileName);
                const before = await dashboardSessions(p());
                await contextMenu(p().profileName, "Dashboard");
                webview = await waitForWebview(
                    "dashboard",
                    `document.querySelector("h1")?.textContent === ${jsLiteral(p().profileName)} &&
                     [...document.querySelectorAll("[data-series] dd")].length > 0 &&
                     [...document.querySelectorAll("[data-series] dd")].every((d) => d.textContent !== "—") &&
                     document.body.innerText.includes("Read at")`,
                    40000,
                );
                dashboardWebviews.push(webview);
                const page = (await readPage(webview))!;
                assert.strictEqual(dashboardTabs().length, 1);
                assert.match(page.subtitle, provider === "pg" ? /PostgreSQL/ : /SQL Server/);
                // The server's version comes from the Object Explorer's connection.
                assert.match(page.subtitle, /\d+\.\d+/);
                assert.strictEqual(page.notices, "", "the test login sees everything");
                assert.strictEqual(page.error, "");
                assert.ok(page.canvases.length >= 3, JSON.stringify(page.canvases));
                for (const canvas of page.canvases) {
                    assert.ok(canvas.width > 100 && canvas.height > 100, JSON.stringify(canvas));
                    assert.ok(canvas.label.includes("Last values"), canvas.label);
                }
                for (const tile of page.tiles) {
                    assert.match(tile.value, NUMBER, JSON.stringify(tile));
                }
                // At least the test's own session is counted.
                const sessions = page.tiles.find((t) => t.chart.includes("session"));
                assert.ok(sessions && parseFloat(sessions.value) >= 1, JSON.stringify(page.tiles));
                assert.strictEqual(await dashboardSessions(p()), before + 1);
                assert.deepStrictEqual(await errorNotifications(), []);
            });

            it("shows the panel already open when asked again", async () => {
                await contextMenu(p().profileName, "Dashboard");
                await sleep(500);
                assert.strictEqual(dashboardTabs().length, 1);
                assert.strictEqual(await dashboardSessions(p()), 1);
            });

            it("takes a new sample on Refresh", async () => {
                const before = (await readPage(webview))!.updated;
                await sleep(1100);
                await clickButton(webview, "Refresh");
                await waitFor(
                    "a new reading time",
                    async () => (await readPage(webview))!.updated,
                    (updated) => updated !== before,
                );
            });

            it("draws new points every second in auto refresh, with activity on the server", async () => {
                const pictures = await chartPictures(webview);
                const work = activity(p(), 6000);
                await setAutoRefresh(webview, 1000, true);
                const times = new Set<string>();
                const deadline = Date.now() + 6000;
                while (Date.now() < deadline) {
                    times.add((await readPage(webview))!.updated);
                    await sleep(250);
                }
                await work;
                await setAutoRefresh(webview, 1000, false);
                assert.ok(times.size >= 4, `only ${times.size} readings in 6 s`);
                const after = await chartPictures(webview);
                assert.notDeepStrictEqual(after, pictures, "the charts did not change");
                const tiles = (await readPage(webview))!.tiles;
                const rates = tiles.filter((t) => t.value.endsWith("/s"));
                assert.ok(rates.length > 0, JSON.stringify(tiles));
                assert.ok(
                    rates.some((t) => parseFloat(t.value) > 0),
                    `every rate is zero under activity: ${JSON.stringify(rates)}`,
                );
            });

            if (provider === "pg") {
                it("shows the error of a lost connection and reconnects", async () => {
                    await query(
                        p(),
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'YAST dashboard'",
                    );
                    await waitFor(
                        "the session to be gone",
                        () => dashboardSessions(p()),
                        (n) => n === 0,
                    );
                    await clickButton(webview, "Refresh");
                    const error = await waitFor(
                        "the error banner",
                        async () => (await readPage(webview))!.error,
                        Boolean,
                    );
                    assert.ok(error.length > 0);
                    // The history stays: the charts are still there.
                    assert.ok((await readPage(webview))!.canvases.length >= 3);

                    await clickButton(webview, "Reconnect");
                    await waitFor(
                        "the error banner to go",
                        async () => (await readPage(webview))!.error,
                        (text) => text === "",
                        30000,
                    );
                    await waitFor(
                        "the new session",
                        () => dashboardSessions(p()),
                        (n) => n === 1,
                    );
                });
            } else {
                // The SQL Server driver's pool opens a new connection by itself.
                it("goes on reading after its connection is killed on the server", async () => {
                    await query(
                        p(),
                        `DECLARE @kill nvarchar(max) = N'';
                         SELECT @kill += N'KILL ' + CAST(session_id AS nvarchar(10)) + N';'
                         FROM sys.dm_exec_sessions WHERE program_name = 'YAST dashboard';
                         EXEC (@kill);`,
                    );
                    await waitFor(
                        "the session to be gone",
                        () => dashboardSessions(p()),
                        (n) => n === 0,
                    );
                    const before = (await readPage(webview))!.updated;
                    await sleep(1100);
                    // A first refresh may report the broken connection; Reconnect then reads.
                    await clickButton(webview, "Refresh");
                    await sleep(2500);
                    if ((await readPage(webview))!.error) {
                        await clickButton(webview, "Reconnect");
                    }
                    await waitFor(
                        "a new reading",
                        async () => (await readPage(webview))!,
                        (page) => page.updated !== before && page.error === "",
                        30000,
                    );
                    await waitFor(
                        "the new session",
                        () => dashboardSessions(p()),
                        (n) => n === 1,
                    );
                });
            }

            it("closes its connection with the panel", async () => {
                await closeDashboards();
                await waitFor(
                    "the dashboard's session to be closed",
                    () => dashboardSessions(p()),
                    (n) => n === 0,
                );
            });

            it("tells a login without the monitoring permission that the data is partial", async () => {
                const login = `yast_dash_${provider}`;
                const password = "Dash_board_2026!";
                await query(
                    p(),
                    provider === "pg"
                        ? `DROP ROLE IF EXISTS ${login}; CREATE ROLE ${login} LOGIN PASSWORD '${password}'`
                        : `IF SUSER_ID('${login}') IS NOT NULL DROP LOGIN ${login};
                           CREATE LOGIN ${login} WITH PASSWORD = '${password}', CHECK_POLICY = OFF;
                           IF DATABASE_PRINCIPAL_ID('${login}') IS NULL CREATE USER ${login} FOR LOGIN ${login};`,
                );
                const settings = vscode.workspace.getConfiguration("yast");
                const saved = settings.get<Record<string, unknown>[]>("connections") ?? [];
                // From the settings: the profile there has its connection group.
                const base = saved.find((c) => c.id === p().id)!;
                const name = `Limited ${provider}`;
                await settings.update(
                    "connections",
                    [
                        ...saved,
                        {
                            ...base,
                            id: `limited-${provider}`,
                            profileName: name,
                            user: login,
                            password,
                        },
                    ],
                    vscode.ConfigurationTarget.Global,
                );
                try {
                    await pickFromCommand("yast.openDashboard", name);
                    const limited = await waitForWebview(
                        "dashboard",
                        `document.querySelector("h1")?.textContent === ${jsLiteral(name)} &&
                         !!document.querySelector('[data-dashboard="notices"]') &&
                         document.body.innerText.includes("Read at")`,
                        40000,
                    );
                    dashboardWebviews.push(limited);
                    const notices = (await readPage(limited))!.notices;
                    assert.match(
                        notices,
                        provider === "pg" ? /pg_monitor|pg_read_all_stats/ : /VIEW SERVER/,
                    );
                    await closeDashboards();
                } finally {
                    await settings.update("connections", saved, vscode.ConfigurationTarget.Global);
                    await waitFor(
                        "the limited session to end",
                        () => dashboardSessions(p()),
                        (n) => n === 0,
                    );
                    await query(
                        p(),
                        provider === "pg"
                            ? `DROP ROLE IF EXISTS ${login}`
                            : `DROP USER IF EXISTS ${login}; DROP LOGIN ${login};`,
                    );
                }
            });
        });
    }

    it("offers the Dashboard item on connected servers only", () => {
        const menus = vscode.extensions.getExtension(env.extensionId)!.packageJSON.contributes
            .menus["view/item/context"] as { command: string; when: string }[];
        const entry = menus.find((m) => m.command === "yast.openDashboard")!;
        assert.match(entry.when, /type=Server\\b/);
        assert.doesNotMatch(entry.when, /disconnectedServer/);
    });
    // After the suites of both engines (mocha runs the tests of a suite before its sub-suites).
    describe("afterwards", () => {
        it("no dashboard reported a script error, a blocked resource or a failed load", () => {
            assert.ok(dashboardWebviews.length >= 4);
            assert.deepStrictEqual(
                dashboardWebviews.flatMap((w) => w.errors),
                [],
            );
        });
    });
});
