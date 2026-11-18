/**
 * How the dashboard writes a value: per the chart's `format` (plain number, bytes, percentage)
 * followed by its `unit` ("/s", " s", "%"...). A missing value is written as a dash, never as 0.
 */

import type { DashboardChart } from "../../../drivers/types";

export const NO_VALUE = "—";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

function number(value: number, locale?: string): string {
    const abs = Math.abs(value);
    if (abs >= 10000) {
        return new Intl.NumberFormat(locale, {
            notation: "compact",
            maximumFractionDigits: 1,
        }).format(value);
    }
    return new Intl.NumberFormat(locale, {
        maximumFractionDigits: abs === 0 || abs >= 100 ? 0 : abs >= 10 ? 1 : 2,
    }).format(value);
}

function bytes(value: number, locale?: string): string {
    let scaled = value;
    let unit = 0;
    while (Math.abs(scaled) >= 1024 && unit < BYTE_UNITS.length - 1) {
        scaled /= 1024;
        unit++;
    }
    const digits = unit === 0 || Math.abs(scaled) >= 100 ? 0 : 1;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(scaled)} ${BYTE_UNITS[unit]}`;
}

/** A value of a chart, with its unit; NO_VALUE when there is none. */
export function formatValue(
    value: number | null | undefined,
    chart: Pick<DashboardChart, "format" | "unit">,
    locale?: string,
): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return NO_VALUE;
    }
    switch (chart.format) {
        case "bytes":
            return bytes(value, locale) + chart.unit;
        case "percent": {
            const text = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
            // The unit of a percentage chart is usually "%" itself.
            return chart.unit.trimStart().startsWith("%")
                ? text + chart.unit
                : `${text}%${chart.unit}`;
        }
        default:
            return number(value, locale) + chart.unit;
    }
}
