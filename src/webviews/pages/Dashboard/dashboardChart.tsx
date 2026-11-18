/**
 * One chart of the dashboard, drawn by uPlot on a canvas. It reads its points from the points
 * store and redraws with `setData` when a point arrives: the page itself does not render again.
 * Its x axis is real time, so irregular samples (a few manual refreshes) sit where they were
 * taken. A missing key in a point is a value that was not measured (the line goes on), a null is
 * a gap (the line breaks). Colors come from the VS Code theme (--vscode-charts-*), read again
 * when the theme changes. The values of the point under the pointer show in a small readout
 * that floats over the chart, only while the pointer is on it.
 */

import * as l10n from "@vscode/l10n";
import { makeStyles } from "@fluentui/react-components";
import { memo, useContext, useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { DashboardChart as Chart } from "../../../drivers/types";
import type { DashboardPoint } from "../../../sharedInterfaces/dashboard";
import { DashboardContext } from "./dashboardStateProvider";
import { formatValue } from "./dashboardFormat";
import { seriesColorVariable } from "./dashboardColors";

const CHART_HEIGHT = 180;
const FONT_SIZE = 11;
/** Room between two time labels, and between a label and the plot. */
const LABEL_GAP = 16;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** Time ticks are at least a second apart: the labels have no fractions of a second. */
const TIME_INCREMENTS = [
    SECOND,
    2 * SECOND,
    5 * SECOND,
    10 * SECOND,
    15 * SECOND,
    30 * SECOND,
    MINUTE,
    2 * MINUTE,
    5 * MINUTE,
    10 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    HOUR,
    2 * HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    24 * HOUR,
];
/** Counts (sessions, seconds of page life) have whole ticks only. */
const WHOLE_INCREMENTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((power) =>
    [1, 2, 5].map((step) => step * 10 ** power),
);
const BYTE_INCREMENTS = [0, 1, 2, 3, 4, 5].flatMap((power) =>
    [1, 2, 5, 10, 20, 50, 100, 200, 500].map((step) => step * 1024 ** power),
);

const useStyles = makeStyles({
    chart: {
        position: "relative",
        width: "100%",
        minHeight: `${CHART_HEIGHT}px`,
        "& .u-select": {
            backgroundColor: "var(--vscode-editor-selectionBackground)",
        },
    },
    readout: {
        position: "absolute",
        zIndex: 1,
        pointerEvents: "none",
        padding: "4px 8px",
        fontSize: "12px",
        lineHeight: "18px",
        whiteSpace: "nowrap",
        color: "var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground))",
        backgroundColor: "var(--vscode-editorHoverWidget-background)",
        border: "1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, transparent))",
        borderRadius: "3px",
        boxShadow: "0 2px 8px var(--vscode-widget-shadow, transparent)",
        fontVariantNumeric: "tabular-nums",
    },
    readoutSwatch: {
        display: "inline-block",
        width: "10px",
        height: "3px",
        marginRight: "6px",
        verticalAlign: "middle",
    },
    empty: {
        position: "absolute",
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--vscode-descriptionForeground)",
        fontSize: "12px",
        textAlign: "center",
    },
});

function cssVariable(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

/** The columns uPlot draws, built from the points: [times, ...one array per series]. */
export function toChartData(chart: Chart, points: readonly DashboardPoint[]): uPlot.AlignedData {
    const times = new Array<number>(points.length);
    const columns = chart.series.map(() => new Array<number | null | undefined>(points.length));
    points.forEach((point, row) => {
        times[row] = point.time;
        chart.series.forEach((series, column) => {
            // Absent: not measured by this point (undefined, the line goes on); null: a gap.
            columns[column][row] = series.id in point.values ? point.values[series.id] : undefined;
        });
    });
    return [times, ...columns] as uPlot.AlignedData;
}

function hasValues(data: uPlot.AlignedData): boolean {
    return data.slice(1).some((column) => column.some((v) => typeof v === "number"));
}

/** A time as the user's locale writes it (as the header does), with or without seconds. */
function timeText(ms: number, seconds: boolean): string {
    return new Date(ms).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        ...(seconds ? { second: "2-digit" } : {}),
    });
}

/** Width of texts in the font of the axes, measured once per chart. */
function textMeasurer(font: string): (text: string) => number {
    const context = document.createElement("canvas").getContext("2d");
    if (context) context.font = font;
    return (text) => (context ? context.measureText(text).width : text.length * 7);
}

function makeOptions(chart: Chart, width: number, highContrast: boolean): uPlot.Options {
    const foreground = cssVariable(
        "--vscode-charts-foreground",
        cssVariable("--vscode-foreground", "#888"),
    );
    const lines = cssVariable("--vscode-charts-lines", "rgba(128, 128, 128, 0.3)");
    const font = `${FONT_SIZE}px ${cssVariable("--vscode-font-family", "sans-serif")}`;
    const measure = textMeasurer(font);
    // The widest time of the day in this locale, with and without seconds.
    const sample = new Date(2000, 0, 1, 22, 58, 58).getTime();
    const withSeconds = measure(timeText(sample, true)) + LABEL_GAP;
    const withoutSeconds = measure(timeText(sample, false)) + LABEL_GAP;
    const format = (value: number | null | undefined) => formatValue(value, chart);
    const axis: uPlot.Axis = {
        stroke: foreground,
        grid: { stroke: lines, width: 1 },
        ticks: { stroke: lines, width: 1, size: 4 },
        font,
        gap: 4,
    };
    return {
        width,
        height: CHART_HEIGHT,
        // Times are in milliseconds.
        ms: 1,
        // Room on the right for half of the last time label, which is centered on its tick.
        padding: [8, Math.ceil(withSeconds / 2), 0, 0],
        cursor: { drag: { x: false, y: false }, points: { size: 6 } },
        // The readout of the point under the pointer is drawn by the chart view, not as a legend.
        legend: { show: false },
        scales: {
            x: { time: true },
            y: {
                // Counts, rates and percentages: from zero, so that a small change does not look big.
                range: (_u, _min, max) =>
                    chart.format === "percent"
                        ? [0, Math.max(100, max ?? 0)]
                        : [0, max !== null && max > 0 ? max * 1.15 : 1],
            },
        },
        axes: [
            {
                ...axis,
                size: FONT_SIZE + 12,
                incrs: TIME_INCREMENTS,
                // Room for whole labels: with seconds when the ticks will be less than a minute apart.
                space: (_u, _axis, min, max, plotDim) =>
                    plotDim > 0 && ((max - min) * withSeconds) / plotDim < 60000
                        ? withSeconds
                        : withoutSeconds,
                values: (_u, splits, _axis, _space, increment) =>
                    splits.map((v) => timeText(v, increment < 60000)),
            },
            {
                ...axis,
                // As wide as its labels, so that a narrow chart keeps its width for the plot.
                size: (_u, values) =>
                    Math.ceil(Math.max(0, ...(values ?? []).map((v) => measure(v)))) + 4 + 4 + 4,
                // Sizes get ticks at round binary values (1 MB, 2 MB...), not at 9.5 MB.
                incrs:
                    chart.format === "bytes"
                        ? BYTE_INCREMENTS
                        : chart.format === "number" && chart.series.every((s) => s.kind === "gauge")
                          ? WHOLE_INCREMENTS
                          : undefined,
                // No scale without a value: "No value to show" says it, not ticks of 0 to 1.
                values: (u, splits) => splits.map((v) => (hasValues(u.data) ? format(v) : "")),
            },
        ],
        series: [
            {},
            ...chart.series.map((_series, index): uPlot.Series => ({
                stroke: cssVariable(seriesColorVariable(index), "#3794ff"),
                width: highContrast ? 2.5 : 1.5,
                spanGaps: false,
                points: { size: 5 },
            })),
        ],
    };
}

export interface DashboardChartViewProps {
    chart: Chart;
    /** Changes with the theme: the colors are read again. */
    themeKey: string;
    highContrast: boolean;
    /** Accessible name of the chart (its title and last values). */
    label: string;
}

export const DashboardChartView = memo(function DashboardChartView({
    chart,
    themeKey,
    highContrast,
    label,
}: DashboardChartViewProps) {
    const classes = useStyles();
    // Read inside the effect: class names do not change, and must not recreate the chart.
    const classNames = useRef(classes);
    classNames.current = classes;
    const context = useContext(DashboardContext);
    const container = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const element = container.current;
        if (!element || !context) {
            return;
        }
        const store = context.points;
        const styles = classNames.current;

        // Floating readout and "nothing to show" text: absolutely placed, they never move the layout.
        const readout = document.createElement("div");
        readout.className = styles.readout;
        readout.hidden = true;
        readout.setAttribute("aria-hidden", "true");
        const empty = document.createElement("div");
        empty.className = styles.empty;
        empty.textContent = l10n.t("No value to show");
        empty.style.display = "none";

        const showReadout = (u: uPlot) => {
            const index = u.cursor.idx;
            const left = u.cursor.left ?? -1;
            const top = u.cursor.top ?? -1;
            if (index === null || index === undefined || left < 0 || top < 0) {
                readout.hidden = true;
                return;
            }
            readout.replaceChildren();
            const time = document.createElement("div");
            time.textContent = new Date(u.data[0][index]).toLocaleTimeString();
            readout.append(time);
            chart.series.forEach((series, i) => {
                const row = document.createElement("div");
                const swatch = document.createElement("span");
                swatch.className = styles.readoutSwatch;
                swatch.style.backgroundColor = `var(${seriesColorVariable(i)})`;
                row.append(swatch, `${series.label}: ${formatValue(u.data[i + 1][index], chart)}`);
                readout.append(row);
            });
            readout.hidden = false;
            // Next to the pointer, on the side where it fits.
            const over = u.over;
            const x0 = over.offsetLeft;
            const y0 = over.offsetTop;
            const width = readout.offsetWidth;
            const height = readout.offsetHeight;
            const x =
                left + 12 + width <= over.clientWidth ? x0 + left + 12 : x0 + left - 12 - width;
            const y = Math.min(Math.max(y0 + top - height / 2, 0), element.clientHeight - height);
            readout.style.left = `${Math.max(0, x)}px`;
            readout.style.top = `${Math.max(0, y)}px`;
        };
        const placeEmpty = (u: uPlot) => {
            // Style, not the hidden attribute: the class sets display.
            empty.style.display = hasValues(u.data) ? "none" : "flex";
            const over = u.over;
            empty.style.left = `${over.offsetLeft}px`;
            empty.style.top = `${over.offsetTop}px`;
            empty.style.width = `${over.clientWidth}px`;
            empty.style.height = `${over.clientHeight}px`;
        };

        const options = makeOptions(chart, Math.max(element.clientWidth, 100), highContrast);
        options.hooks = { setCursor: [showReadout], draw: [placeEmpty] };
        const plot = new uPlot(options, toChartData(chart, store.points), element);
        element.append(empty, readout);
        // The canvas is a picture for assistive technologies: the values are text in the tile.
        plot.root.querySelector("canvas")?.setAttribute("aria-hidden", "true");
        const hide = () => (readout.hidden = true);
        plot.over.addEventListener("mouseleave", hide);
        const unsubscribe = store.subscribe(() => {
            plot.setData(toChartData(chart, store.points));
            // A new point under a still pointer: its values, not the old ones.
            if (!readout.hidden) showReadout(plot);
        });
        const resize = new ResizeObserver(() => {
            const width = Math.max(element.clientWidth, 100);
            if (width !== plot.width) {
                plot.setSize({ width, height: CHART_HEIGHT });
            }
        });
        resize.observe(element);
        return () => {
            resize.disconnect();
            unsubscribe();
            plot.over.removeEventListener("mouseleave", hide);
            plot.destroy();
            readout.remove();
            empty.remove();
        };
    }, [chart, context, themeKey, highContrast]);

    return (
        <div
            ref={container}
            className={classes.chart}
            role="img"
            aria-label={label}
            data-chart-id={chart.id}
        />
    );
});
