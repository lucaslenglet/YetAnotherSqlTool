/**
 * The server dashboard: a header (server, engine, version, Refresh, Auto refresh and its
 * interval), the notices of partial data, the error of the last sample, then one card per chart
 * with the last value of each series as text and the chart itself.
 */

import * as l10n from "@vscode/l10n";
import {
    Button,
    makeStyles,
    MessageBar,
    MessageBarActions,
    MessageBarBody,
    MessageBarTitle,
    Select,
    Spinner,
    Switch,
} from "@fluentui/react-components";
import { ArrowClockwise16Regular, PlugDisconnected16Regular } from "@fluentui/react-icons";
import { memo, useContext, useEffect, useId, useState } from "react";
import type { DashboardChart } from "../../../drivers/types";
import { DASHBOARD_REFRESH_INTERVALS } from "../../../sharedInterfaces/dashboard";
import { ColorThemeKind } from "../../../sharedInterfaces/webview";
import { useVscodeWebview } from "../../common/vscodeWebviewProvider";
import { DashboardChartView } from "./dashboardChart";
import { seriesColorVariable } from "./dashboardColors";
import { formatValue } from "./dashboardFormat";
import { DashboardContext, useDashboardSelector } from "./dashboardStateProvider";

const useStyles = makeStyles({
    page: {
        height: "100%",
        overflowY: "auto",
        boxSizing: "border-box",
        padding: "12px 16px 24px",
        color: "var(--vscode-foreground)",
        fontFamily: "var(--vscode-font-family)",
        fontSize: "var(--vscode-font-size, 13px)",
    },
    header: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        columnGap: "24px",
        rowGap: "8px",
        marginBottom: "12px",
    },
    titleBlock: {
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
    },
    title: {
        margin: 0,
        fontSize: "16px",
        fontWeight: 600,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    subtitle: {
        color: "var(--vscode-descriptionForeground)",
        overflowWrap: "anywhere",
    },
    toolbar: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "8px",
    },
    interval: {
        minWidth: "130px",
    },
    updated: {
        color: "var(--vscode-descriptionForeground)",
        fontVariantNumeric: "tabular-nums",
    },
    banners: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        marginBottom: "12px",
    },
    notices: {
        margin: "4px 0 0",
        paddingLeft: "18px",
    },
    grid: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))",
        gap: "12px",
    },
    card: {
        minWidth: 0,
        padding: "10px 12px 6px",
        border: "1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border, transparent)))",
        borderRadius: "4px",
        backgroundColor: "var(--vscode-editorWidget-background, transparent)",
    },
    cardTitle: {
        margin: "0 0 6px",
        fontSize: "13px",
        fontWeight: 600,
    },
    tiles: {
        display: "flex",
        flexWrap: "wrap",
        columnGap: "20px",
        rowGap: "4px",
        margin: "0 0 6px",
    },
    tile: {
        display: "flex",
        flexDirection: "column",
        minWidth: "64px",
    },
    tileLabel: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        margin: 0,
        color: "var(--vscode-descriptionForeground)",
    },
    swatch: {
        display: "inline-block",
        width: "10px",
        height: "3px",
        borderRadius: "1px",
        flexShrink: 0,
    },
    tileValue: {
        margin: 0,
        fontSize: "18px",
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
    },
    empty: {
        color: "var(--vscode-descriptionForeground)",
    },
});

const sameJson = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

function intervalLabel(ms: number): string {
    return ms < 60000 ? l10n.t("Every {0} s", ms / 1000) : l10n.t("Every {0} min", ms / 60000);
}

/** Changes when VS Code applies another theme to the page, once its colors are in place. */
function useThemeVersion(): number {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        let frame = 0;
        const observer = new MutationObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => setVersion((v) => v + 1));
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["style", "class"],
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, []);
    return version;
}

/** Time of the last reading: its own component, so that a new reading renders only this text. */
function ReadAt({ className }: { className: string }) {
    const latestTime = useDashboardSelector((s) => s?.latestTime ?? 0);
    return latestTime > 0 ? (
        <span className={className}>
            {l10n.t("Read at {0}", new Date(latestTime).toLocaleTimeString())}
        </span>
    ) : null;
}

/** A card renders again only when its own last values change, not the whole page. */
const ChartCard = memo(function ChartCard({
    chart,
    themeKey,
    highContrast,
}: {
    chart: DashboardChart;
    themeKey: string;
    highContrast: boolean;
}) {
    const classes = useStyles();
    const titleId = useId();
    const latest = useDashboardSelector(
        (s) => chart.series.map((series) => s?.latest?.[series.id] ?? null),
        sameJson,
    );
    const values = chart.series.map((series, index) => ({
        series,
        text: formatValue(latest[index], chart),
    }));
    const label = l10n.t(
        "{0} chart. Last values: {1}",
        chart.title,
        values.map((v) => `${v.series.label} ${v.text}`).join(", "),
    );
    return (
        <section className={classes.card} aria-labelledby={titleId} data-chart={chart.id}>
            <h2 id={titleId} className={classes.cardTitle}>
                {chart.title}
            </h2>
            <dl className={classes.tiles}>
                {values.map(({ series, text }, index) => (
                    <div key={series.id} className={classes.tile} data-series={series.id}>
                        <dt className={classes.tileLabel}>
                            <span
                                className={classes.swatch}
                                style={{ backgroundColor: `var(${seriesColorVariable(index)})` }}
                                aria-hidden="true"
                            />
                            {series.label}
                        </dt>
                        <dd className={classes.tileValue}>{text}</dd>
                    </div>
                ))}
            </dl>
            <DashboardChartView
                chart={chart}
                themeKey={themeKey}
                highContrast={highContrast}
                label={label}
            />
        </section>
    );
});

export function DashboardPage() {
    const classes = useStyles();
    const context = useContext(DashboardContext);
    const { themeKind } = useVscodeWebview();
    const themeVersion = useThemeVersion();
    const serverName = useDashboardSelector((s) => s?.serverName ?? "");
    const engine = useDashboardSelector((s) => s?.engine ?? "");
    const version = useDashboardSelector((s) => s?.version ?? "");
    const status = useDashboardSelector((s) => s?.status);
    const error = useDashboardSelector((s) => s?.error ?? "");
    const notices = useDashboardSelector((s) => s?.notices ?? [], sameJson);
    const charts = useDashboardSelector((s) => s?.charts ?? [], sameJson);
    const autoRefresh = useDashboardSelector((s) => s?.autoRefresh ?? false);
    const interval = useDashboardSelector((s) => s?.refreshInterval ?? 5000);
    const intervalId = useId();

    if (!context || status === undefined) {
        return undefined;
    }
    const connected = status === "connected";
    const highContrast =
        themeKind === ColorThemeKind.HighContrast || themeKind === ColorThemeKind.HighContrastLight;
    const themeKey = `${themeKind}-${themeVersion}`;

    return (
        <div className={classes.page}>
            <header className={classes.header}>
                <div className={classes.titleBlock}>
                    <h1 className={classes.title} title={serverName}>
                        {serverName}
                    </h1>
                    <span className={classes.subtitle}>
                        {version ? `${engine} · ${version}` : engine}
                    </span>
                </div>
                <div className={classes.toolbar} role="toolbar" aria-label={l10n.t("Dashboard")}>
                    <Button
                        icon={<ArrowClockwise16Regular />}
                        onClick={() => context.refresh()}
                        disabled={!connected}
                        title={l10n.t("Read the statistics now (two readings a second apart)")}>
                        {l10n.t("Refresh")}
                    </Button>
                    <Switch
                        label={l10n.t("Auto refresh")}
                        checked={autoRefresh}
                        onChange={(_e, data) => context.setAutoRefresh(data.checked)}
                    />
                    <Select
                        id={intervalId}
                        className={classes.interval}
                        aria-label={l10n.t("Auto refresh interval")}
                        value={String(interval)}
                        onChange={(_e, data) => context.setRefreshInterval(Number(data.value))}>
                        {DASHBOARD_REFRESH_INTERVALS.map((ms) => (
                            <option key={ms} value={String(ms)}>
                                {intervalLabel(ms)}
                            </option>
                        ))}
                    </Select>
                    <ReadAt className={classes.updated} />
                </div>
            </header>

            <div className={classes.banners}>
                {status === "connecting" && (
                    <Spinner size="tiny" labelPosition="after" label={l10n.t("Connecting...")} />
                )}
                {notices.length > 0 && (
                    <MessageBar intent="warning" layout="multiline" data-dashboard="notices">
                        <MessageBarBody>
                            <MessageBarTitle>
                                {l10n.t(
                                    "Partial data: these numbers do not cover the whole server.",
                                )}
                            </MessageBarTitle>
                            <ul className={classes.notices}>
                                {notices.map((notice) => (
                                    <li key={notice}>{notice}</li>
                                ))}
                            </ul>
                        </MessageBarBody>
                    </MessageBar>
                )}
                {(error || status === "disconnected") && (
                    <MessageBar intent="error" layout="multiline" data-dashboard="error">
                        <MessageBarBody>
                            <MessageBarTitle>
                                {status === "disconnected"
                                    ? l10n.t("Not connected")
                                    : l10n.t("The statistics could not be read")}
                            </MessageBarTitle>
                            {error}
                        </MessageBarBody>
                        <MessageBarActions>
                            <Button
                                icon={<PlugDisconnected16Regular />}
                                onClick={() => context.reconnect()}
                                disabled={status === "connecting"}>
                                {l10n.t("Reconnect")}
                            </Button>
                        </MessageBarActions>
                    </MessageBar>
                )}
            </div>

            {charts.length > 0 ? (
                <main className={classes.grid}>
                    {charts.map((chart) => (
                        <ChartCard
                            key={chart.id}
                            chart={chart}
                            themeKey={themeKey}
                            highContrast={highContrast}
                        />
                    ))}
                </main>
            ) : (
                status === "connected" && (
                    <p className={classes.empty}>{l10n.t("This server has no charts.")}</p>
                )
            )}
        </div>
    );
}
