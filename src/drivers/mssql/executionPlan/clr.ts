/**
 * The .NET values sqltoolsservice works with once XmlSerializer has read a plan, and the .NET
 * formatting they go through (en-US culture, the one its strings are in). sqltoolsservice decides
 * many things from a value's runtime type (which converter formats it, whether it is a "Number" or a
 * "String" for the page), so values keep their CLR type here.
 */

import type { XmlAttribute, XmlElement } from "./xml";

/** An instance of a class of showplanxml.cs (or of a class sqltoolsservice defines, MergeColumns). */
export class SchemaObject {
    constructor(
        readonly className: string,
        readonly values: Map<string, unknown>,
        /** Name of the XML element it was read from (a choice group's member says which one). */
        readonly elementName: string,
    ) {}
}

export type NumericType = "int" | "ulong" | "double";

/** int, ulong or double: they format differently. */
export class ClrNumber {
    constructor(
        readonly type: NumericType,
        readonly value: number,
    ) {}

    toString(): string {
        return this.type === "double" ? formatDouble(this.value) : String(this.value);
    }
}

/** A value of an enum of showplanxml.cs: `member` is the C# member name (what ToString gives). */
export class ClrEnum {
    constructor(
        readonly enumType: string,
        readonly member: string,
    ) {}

    toString(): string {
        return this.member;
    }
}

/** System.DateTime, as XmlSerializer reads an xs:dateTime without offset. */
export class ClrDateTime {
    constructor(
        readonly year: number,
        readonly month: number,
        readonly day: number,
        readonly hour: number,
        readonly minute: number,
        readonly second: number,
        /** Fraction of a second, in 100 ns ticks. */
        readonly ticks: number,
    ) {}

    toString(): string {
        return formatDateTimeGeneral(this);
    }
}

/** A .NET array: `elementType` is the declared element type ("object" for a choice group). */
export class ClrArray {
    constructor(
        readonly elementType: string,
        readonly items: unknown[],
    ) {}
}

/** System.Xml.XmlElement / XmlAttribute (InternalInfo's [XmlAnyElement] / [XmlAnyAttribute]). */
export class ClrXmlElement {
    constructor(readonly element: XmlElement) {}
}
export class ClrXmlAttribute {
    constructor(readonly attribute: XmlAttribute) {}
}

/** .NET runtime type name of a value, as the converter tables key it. */
export function clrTypeName(value: unknown): string {
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "bool";
    if (value instanceof ClrNumber) return value.type;
    if (value instanceof SchemaObject) return value.className;
    if (value instanceof ClrEnum) return value.enumType;
    if (value instanceof ClrArray) return `${value.elementType}[]`;
    if (value instanceof ClrDateTime) return "System.DateTime";
    if (value instanceof ClrXmlElement) return "System.Xml.XmlElement";
    if (value instanceof ClrXmlAttribute) return "System.Xml.XmlAttribute";
    return "object";
}

// ---------------------------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------------------------

/** Decimal digits (no leading or trailing zeros) and the position of the decimal point. */
interface Digits {
    negative: boolean;
    digits: string;
    /** The value is 0.digits × 10^scale. */
    scale: number;
}

function toDigits(value: number, significant?: number): Digits {
    const negative = value < 0 || Object.is(value, -0);
    const text = significant
        ? Math.abs(value).toExponential(significant - 1)
        : Math.abs(value).toExponential();
    const [mantissa, exponent] = text.split("e");
    const digits = mantissa.replace(".", "").replace(/0+$/, "");
    return { negative, digits: digits || "0", scale: digits ? Number(exponent) + 1 : 1 };
}

/**
 * double.ToString() / ToString("R") of .NET Core 3.0 and later: the shortest text that reads back
 * as the same double, in scientific notation when the exponent is 15 or more, or below -5.
 */
export function formatDouble(value: number): string {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "∞";
    if (value === -Infinity) return "-∞";
    if (value === 0) return Object.is(value, -0) ? "-0" : "0";
    const { negative, digits, scale } = toDigits(value);
    const sign = negative ? "-" : "";
    if (scale > 15 || scale < -3) {
        const exponent = scale - 1;
        const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
        const exp = Math.abs(exponent).toString().padStart(2, "0");
        return `${sign}${mantissa}E${exponent < 0 ? "-" : "+"}${exp}`;
    }
    if (scale <= 0) return `${sign}0.${"0".repeat(-scale)}${digits}`;
    if (scale >= digits.length) return `${sign}${digits}${"0".repeat(scale - digits.length)}`;
    return `${sign}${digits.slice(0, scale)}.${digits.slice(scale)}`;
}

/** XmlConvert.ToString(double): what XmlSerializer writes. */
export function xmlConvertDouble(value: number): string {
    if (value === Infinity) return "INF";
    if (value === -Infinity) return "-INF";
    return formatDouble(value);
}

/**
 * double.ToString("0.###…") with `decimals` optional decimals: .NET first keeps 15 significant
 * digits, then rounds half away from zero at the last decimal and drops trailing zeros.
 */
export function formatFixed(value: number, decimals: number): string {
    if (!Number.isFinite(value)) return formatDouble(value);
    if (value === 0) return "0";
    const { negative, digits, scale } = toDigits(value, 15);
    // Digits kept: everything before the decimal point plus `decimals` after it.
    const keep = scale + decimals;
    let kept: string;
    let newScale = scale;
    if (keep < 0) {
        kept = "";
    } else if (keep >= digits.length) {
        kept = digits;
    } else {
        kept = digits.slice(0, keep);
        if (digits.charCodeAt(keep) >= 53 /* '5' */) {
            // Round up, carrying.
            const arr = kept.split("").map(Number);
            let i = arr.length - 1;
            while (i >= 0 && arr[i] === 9) arr[i--] = 0;
            if (i < 0) {
                arr.unshift(1);
                newScale++;
            } else {
                arr[i]++;
            }
            kept = arr.join("");
        } else if (keep === 0) {
            kept = "";
        }
    }
    kept = kept.replace(/0+$/, "");
    const sign = negative && kept ? "-" : "";
    if (!kept) return negative ? "-0" : "0";
    let integer: string;
    let fraction: string;
    if (newScale <= 0) {
        integer = "0";
        fraction = "0".repeat(-newScale) + kept;
    } else if (newScale >= kept.length) {
        integer = kept + "0".repeat(newScale - kept.length);
        fraction = "";
    } else {
        integer = kept.slice(0, newScale);
        fraction = kept.slice(newScale);
    }
    return `${sign}${integer}${fraction ? "." + fraction : ""}`;
}

/** Math.Round(double): to the nearest integer, ties to even. */
export function roundHalfEven(value: number): number {
    if (!Number.isFinite(value)) return value;
    const floor = Math.floor(value);
    const diff = value - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
}

/** object.ToString() in .NET: "True"/"False" for booleans, "" for null. */
export function clrToString(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "boolean") return value ? "True" : "False";
    if (value instanceof ClrXmlAttribute) return value.attribute.value;
    return String(value);
}

const pad2 = (n: number) => n.toString().padStart(2, "0");
const hour12 = (h: number) => (h % 12 === 0 ? 12 : h % 12);
/** .NET on Linux formats en-US times with ICU, which puts a narrow no-break space before AM/PM. */
const AM_PM_SEPARATOR = "\u202F";

/** DateTimeConverter (en-US): short date, plus short time unless the time is exactly midnight. */
export function formatDateTimeShort(value: ClrDateTime): string {
    const date = `${value.month}/${value.day}/${value.year}`;
    if (value.hour === 0 && value.minute === 0 && value.second === 0 && value.ticks === 0)
        return date;
    return `${date} ${hour12(value.hour)}:${pad2(value.minute)}${AM_PM_SEPARATOR}${value.hour < 12 ? "AM" : "PM"}`;
}

/** DateTime.ToString() (en-US "G"). */
export function formatDateTimeGeneral(value: ClrDateTime): string {
    return (
        `${value.month}/${value.day}/${value.year} ${hour12(value.hour)}:${pad2(value.minute)}:` +
        `${pad2(value.second)}${AM_PM_SEPARATOR}${value.hour < 12 ? "AM" : "PM"}`
    );
}

/** String.Format with positional {0} {1}… placeholders (no format specifiers are used). */
export function format(template: string, ...args: unknown[]): string {
    return template.replace(/\{(\d+)\}/g, (_, index: string) => clrToString(args[Number(index)]));
}
