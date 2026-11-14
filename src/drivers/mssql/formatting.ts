/**
 * Converts values and column metadata coming from `mssql` (tedious) into the grid's
 * `CellValue` / `ColumnInfo`, formatted the way Microsoft's sqltoolsservice does.
 * The expected output is captured in docs/reference/mssql-cell-formats.json.
 */

import type { CellValue, ColumnInfo, ValueKind } from "../types";

/** The part of mssql's column metadata (IColumnMetadata entry) that we read. */
export interface MssqlColumn {
    name: string;
    /** mssql type constructor, e.g. sql.Int. Its `declaration` is the type name ("int"). */
    type: { declaration?: string } | ((...args: never[]) => unknown);
    length?: number;
    scale?: number;
    precision?: number;
    nullable?: boolean;
    identity?: boolean;
    udt?: { name?: string };
}

const XML_COLUMN_ID = "XML_F52E2B61-18A1-11d1-B105-00805F49916B";
const JSON_COLUMN_ID = "JSON_F52E2B61-18A1-11d1-B105-00805F49916B";

// ---------------------------------------------------------------------------
// Column metadata
// ---------------------------------------------------------------------------

/** SQL Server type name of a column, e.g. "int", "nvarchar", "sql_variant". */
export function getTypeName(column: MssqlColumn): string {
    if (column.udt?.name) return column.udt.name.toLowerCase();
    const declaration = (column.type as { declaration?: string }).declaration ?? "unknown";
    switch (declaration) {
        case "variant":
            return "sql_variant";
        case "numeric":
            return "decimal"; // sqltoolsservice reports numeric as decimal too
        default:
            return declaration;
    }
}

const NUMBER_TYPES = new Set([
    "int",
    "bigint",
    "smallint",
    "tinyint",
    "decimal",
    "float",
    "real",
    "money",
    "smallmoney",
]);
const STRING_TYPES = new Set([
    "char",
    "varchar",
    "nchar",
    "nvarchar",
    "text",
    "ntext",
    "uniqueidentifier",
]);
const DATETIME_TYPES = new Set([
    "date",
    "time",
    "datetime",
    "datetime2",
    "datetimeoffset",
    "smalldatetime",
]);
const BINARY_TYPES = new Set(["binary", "varbinary", "image", "timestamp", "hierarchyid"]);

function getValueKind(typeName: string, columnName: string): ValueKind {
    if (columnName === XML_COLUMN_ID || typeName === "xml") return "xml";
    if (columnName === JSON_COLUMN_ID || typeName === "json") return "json";
    if (NUMBER_TYPES.has(typeName)) return "number";
    if (typeName === "bit") return "boolean";
    if (STRING_TYPES.has(typeName)) return "string";
    if (DATETIME_TYPES.has(typeName)) return "datetime";
    if (BINARY_TYPES.has(typeName)) return "binary";
    return "other";
}

export function toColumnInfo(column: MssqlColumn): ColumnInfo {
    const dataTypeName = getTypeName(column);
    const kind = getValueKind(dataTypeName, column.name);
    return {
        columnName: column.name,
        dataTypeName,
        kind,
        allowDBNull: column.nullable,
        isIdentity: column.identity,
        isXml: kind === "xml",
        isJson: kind === "json",
        isBytes: kind === "binary",
    };
}

// ---------------------------------------------------------------------------
// Cell values
// ---------------------------------------------------------------------------

export function formatCell(value: unknown, column: MssqlColumn): CellValue {
    if (value === null || value === undefined) return { displayValue: "NULL", isNull: true };
    return {
        displayValue: formatValue(value, getTypeName(column), column.scale ?? 7),
        isNull: false,
    };
}

function formatValue(value: unknown, typeName: string, scale: number): string {
    switch (typeName) {
        case "real":
            return formatFloatingPoint(Number(value), 9);
        case "float":
            return formatFloatingPoint(Number(value), 17);
        case "money":
        case "smallmoney":
            return formatMoney(value);
        case "bit":
            return value ? "1" : "0";
        case "xml":
            // SQL Server sends <r/>, sqltoolsservice (.NET) shows <r />.
            return String(value).replace(/(?<=[^\s<])\/>/g, " />");
        case "date":
            return formatDate(value as Date);
        case "time":
            return formatTime(value as Date);
        case "datetime":
            return `${formatDate(value as Date)} ${formatClock(value as Date)}.${pad(getFraction(value as Date).slice(0, 3), 3)}`;
        case "smalldatetime":
            return `${formatDate(value as Date)} ${formatClock(value as Date)}`;
        case "datetime2":
            return `${formatDate(value as Date)} ${formatClock(value as Date)}${formatFraction(value as Date, scale)}`;
        case "datetimeoffset":
            return formatDateTimeOffset(value as Date, scale);
        default:
            return formatGeneric(value);
    }
}

/** Fallback by JS type; also used for the content of sql_variant values. */
function formatGeneric(value: unknown): string {
    if (value instanceof Date) {
        const milliseconds = value.getUTCMilliseconds();
        const fraction = milliseconds > 0 ? "." + pad(String(milliseconds), 3) : "";
        return `${formatDate(value)} ${formatClock(value)}${fraction}`;
    }
    if (Buffer.isBuffer(value)) return formatBinary(value);
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "string") return value;
    return String(value);
}

export function formatBinary(buffer: Buffer): string {
    return "0x" + buffer.toString("hex").toUpperCase();
}

// -- numbers ----------------------------------------------------------------

/** money is displayed with at least 2 decimals and trailing zeros trimmed after that: 100.00, 1234.5678. */
function formatMoney(value: unknown): string {
    const text = typeof value === "string" ? value : Number(value).toFixed(4);
    const [integerPart, fractionPart = ""] = text.split(".");
    return `${integerPart}.${fractionPart.replace(/0+$/, "").padEnd(2, "0")}`;
}

/**
 * Formats like .NET's Double/Single.ToString(): the shortest text that round-trips, in plain notation when
 * -5 < exponent < precision (17 for double, 9 for single), otherwise "1.5E+20" / "1E-05".
 */
function formatFloatingPoint(value: number, precision: 9 | 17): string {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    if (value === 0) return "0";

    const sign = value < 0 ? "-" : "";
    const [mantissa, exponentText] = shortestExponential(Math.abs(value), precision === 9).split(
        "e",
    );
    const digits = mantissa.replace(".", "");
    const exponent = Number(exponentText);

    if (exponent <= -5 || exponent >= precision) {
        const scientificMantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
        const exponentSign = exponent < 0 ? "-" : "+";
        return `${sign}${scientificMantissa}E${exponentSign}${pad(String(Math.abs(exponent)), 2)}`;
    }
    if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
    const integerPart = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
    const fractionPart = digits.slice(exponent + 1);
    return `${sign}${integerPart}${fractionPart ? "." + fractionPart : ""}`;
}

/** "1.2345e+17"-style text with the fewest digits that read back as the same number (32 or 64 bit). */
function shortestExponential(value: number, isSingle: boolean): string {
    if (!isSingle) return value.toExponential();
    for (let digits = 1; digits <= 9; digits++) {
        const candidate = value.toExponential(digits - 1);
        if (Math.fround(Number(candidate)) === value) return candidate;
    }
    return value.toExponential(8);
}

// -- dates and times --------------------------------------------------------
// tedious returns dates as JS Dates read in UTC (useUTC), so the UTC fields are the stored wall-clock values.

function pad(text: string, length: number): string {
    return text.padStart(length, "0");
}

function formatDate(date: Date): string {
    return `${pad(String(date.getUTCFullYear()), 4)}-${pad(String(date.getUTCMonth() + 1), 2)}-${pad(String(date.getUTCDate()), 2)}`;
}

function formatClock(date: Date): string {
    return `${pad(String(date.getUTCHours()), 2)}:${pad(String(date.getUTCMinutes()), 2)}:${pad(String(date.getUTCSeconds()), 2)}`;
}

/** Fraction of the second as 7 digits (100 ns units). tedious keeps the sub-millisecond part in `nanosecondsDelta`. */
function getFraction(date: Date): string {
    const subMillisecondUnits = Math.round(
        ((date as Date & { nanosecondsDelta?: number }).nanosecondsDelta ?? 0) * 1e7,
    );
    return pad(String(date.getUTCMilliseconds() * 10000 + subMillisecondUnits), 7);
}

function formatFraction(date: Date, scale: number): string {
    return scale > 0 ? "." + getFraction(date).slice(0, scale) : "";
}

/** time is a .NET TimeSpan: the fraction is omitted when zero, otherwise always 7 digits. */
function formatTime(date: Date): string {
    const fraction = getFraction(date);
    return formatClock(date) + (Number(fraction) > 0 ? "." + fraction : "");
}

function formatDateTimeOffset(date: Date, scale: number): string {
    const offsetMinutes = (date as Date & { offsetMinutes?: number }).offsetMinutes ?? 0;
    // The Date holds the UTC instant; shifting it by the offset gives the wall-clock time.
    const wallClock = new Date(date.getTime() + offsetMinutes * 60000);
    Object.defineProperty(wallClock, "nanosecondsDelta", {
        value: (date as Date & { nanosecondsDelta?: number }).nanosecondsDelta ?? 0,
    });
    const sign = offsetMinutes < 0 ? "-" : "+";
    const absolute = Math.abs(offsetMinutes);
    const offsetText = `${sign}${pad(String(Math.floor(absolute / 60)), 2)}:${pad(String(absolute % 60), 2)}`;
    return `${formatDate(wallClock)} ${formatClock(wallClock)}${formatFraction(wallClock, scale)} ${offsetText}`;
}
