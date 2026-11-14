/**
 * Save as Excel: a minimal .xlsx workbook, written the way sqltoolsservice's
 * SaveAsExcelFileStreamWriter and SaveAsExcelFileStreamWriterHelper do (inline
 * strings, the same five cell styles, one sheet per 1,048,576 rows).
 *
 * sqltoolsservice types each cell from the .NET value; the drivers only keep the
 * display text, so the type comes from the column kind and the text is parsed back:
 * numbers and booleans become Excel numbers and booleans, dates and times without
 * a time zone become Excel dates. Anything else is written as text, as
 * sqltoolsservice does for DateTimeOffset, GUIDs, binaries...
 *
 * The workbook is streamed: rows go through fflate's streaming zip as they are read, so memory
 * holds one chunk of rows and the deflate window, never the sheet. Inline strings (no shared
 * string table) make that possible; auto-sized columns need one more pass over the rows first.
 */

import { strToU8, Zip, ZipDeflate } from "fflate";
import type { CellValue, ColumnInfo } from "../../drivers/types";
import type { ExcelOptions, ExportSource, ExportTable } from "./types";

/** fflate writes no ZIP64: every part, and the file, must stay under 4 GiB. */
const MAX_ZIP_BYTES = 0xffffffff;

/** Rows of a worksheet, header included (Excel's limit). */
export const MAX_WORKSHEET_ROWS = 1_048_576;
/** Columns of a worksheet (Excel's limit). */
const MAX_WORKSHEET_COLUMNS = 16_384;

/** Indexes in <cellXfs> (sqltoolsservice's Style enum, plus the bold header font). */
const enum Style {
    Normal = 0,
    Date = 1,
    Time = 2,
    DateTime = 3,
    TimeMoreThan24Hours = 4,
    Bold = 5,
}

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';

/** Calibri 11 at 96 DPI: average character width, and width of the filter button. */
const FONT_PIXEL_WIDTH = 7;
const AUTO_FILTER_PIXEL_WIDTH = 17;
/** Excel's maximum column width, in characters. */
const MAX_COLUMN_WIDTH = 255;

/** First day Excel dates handle correctly (Excel thinks 1900 is a leap year). */
const EXCEL_DATE_CUTOFF = Date.UTC(1900, 2, 1);
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/** Builds the .xlsx file in memory. `maxWorksheetRows` is only lowered by tests. */
export function formatExcel(
    table: ExportTable,
    options: ExcelOptions,
    maxWorksheetRows: number = MAX_WORKSHEET_ROWS,
): Uint8Array {
    const output: Uint8Array[] = [];
    const workbook = new WorkbookWriter(
        table.columns,
        table.rows.length,
        options,
        options.autoSizeColumns
            ? widenColumns(headerPixels(table.columns, options), table.rows).map(toExcelWidth)
            : undefined,
        (data) => output.push(data),
        maxWorksheetRows,
    );
    workbook.addRows(table.rows);
    workbook.end();
    return concat(output);
}

/**
 * Streams the .xlsx file of `source` to `write`, waiting for each write: memory holds one chunk
 * of rows at a time.
 */
export async function writeExcel(
    source: ExportSource,
    options: ExcelOptions,
    write: (data: Uint8Array) => Promise<void>,
    maxWorksheetRows: number = MAX_WORKSHEET_ROWS,
): Promise<void> {
    let widths: number[] | undefined;
    if (options.autoSizeColumns) {
        let pixels = headerPixels(source.columns, options);
        for await (const chunk of source.chunks()) {
            pixels = widenColumns(pixels, chunk);
        }
        widths = pixels.map(toExcelWidth);
    }
    let pending: Uint8Array[] = [];
    const workbook = new WorkbookWriter(
        source.columns,
        source.rowCount,
        options,
        widths,
        (data) => pending.push(data),
        maxWorksheetRows,
    );
    const flush = async () => {
        const data = concat(pending);
        pending = [];
        if (data.length > 0) {
            await write(data);
        }
    };
    let written = 0;
    for await (const chunk of source.chunks()) {
        // The sheet count was set from rowCount: ignore rows beyond it (none for a complete result).
        const rows = chunk.slice(0, source.rowCount - written);
        written += rows.length;
        workbook.addRows(rows);
        await flush();
    }
    workbook.end();
    await flush();
}

/** Writes the parts of the workbook in order, and the rows into as many sheets as needed. */
class WorkbookWriter {
    private readonly zip: Zip;
    private readonly rowsPerSheet: number;
    private readonly sheetCount: number;
    private sheet: ZipDeflate | undefined;
    private sheetBytes = 0;
    private sheetIndex = 0;
    private rowsInSheet = 0;
    private rowNumber = 1;
    private totalBytes = 0;
    private error: Error | undefined;

    constructor(
        private readonly columns: ColumnInfo[],
        rowCount: number,
        private readonly options: ExcelOptions,
        private readonly widths: number[] | undefined,
        output: (data: Uint8Array) => void,
        maxWorksheetRows: number,
    ) {
        if (columns.length > MAX_WORKSHEET_COLUMNS) {
            throw new Error(`Excel worksheets are limited to ${MAX_WORKSHEET_COLUMNS} columns.`);
        }
        this.rowsPerSheet = maxWorksheetRows - (options.includeHeaders ? 1 : 0);
        // An empty result still gets one sheet (with its header row).
        this.sheetCount = Math.max(1, Math.ceil(rowCount / this.rowsPerSheet));
        this.zip = new Zip((error, data) => {
            if (error) {
                this.error = error;
                return;
            }
            this.totalBytes += data.length;
            output(data);
        });
        this.addPart("[Content_Types].xml", writeContentTypes(this.sheetCount));
        this.addPart(
            "_rels/.rels",
            `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">` +
                `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
                `</Relationships>`,
        );
        this.addPart("xl/workbook.xml", writeWorkbook(this.sheetCount));
        this.addPart("xl/_rels/workbook.xml.rels", writeWorkbookRels(this.sheetCount));
        this.addPart("xl/styles.xml", STYLES);
        this.openSheet();
    }

    public addRows(rows: (CellValue | undefined)[][]): void {
        let xml = "";
        for (const row of rows) {
            if (this.rowsInSheet === this.rowsPerSheet) {
                this.push(xml);
                xml = "";
                this.closeSheet();
                this.openSheet();
            }
            const rowNumber = this.rowNumber++;
            const cells = this.columns.map((column, i) =>
                writeCell(cellReference(i, rowNumber), row[i], column),
            );
            xml += `<row r="${rowNumber}">${cells.join("")}</row>`;
            this.rowsInSheet++;
        }
        this.push(xml);
    }

    public end(): void {
        this.closeSheet();
        // Sheets announced in the workbook but left without rows (a source shorter than its rowCount).
        while (this.sheetIndex < this.sheetCount) {
            this.openSheet();
            this.closeSheet();
        }
        this.zip.end();
        this.check();
    }

    private addPart(name: string, content: string): void {
        const file = new ZipDeflate(name, { level: 1 });
        this.zip.add(file);
        file.push(strToU8(content), true);
        this.check();
    }

    private openSheet(): void {
        this.sheetIndex++;
        this.sheet = new ZipDeflate(`xl/worksheets/sheet${this.sheetIndex}.xml`, { level: 1 });
        this.zip.add(this.sheet);
        this.sheetBytes = 0;
        this.rowsInSheet = 0;
        this.rowNumber = 1;
        this.push(sheetStart(this.columns, this.options, this.widths));
        if (this.options.includeHeaders) {
            this.rowNumber++;
        }
    }

    private closeSheet(): void {
        if (!this.sheet) {
            return;
        }
        this.push(sheetEnd(this.columns, this.options));
        this.sheet.push(new Uint8Array(0), true);
        this.sheet = undefined;
        this.check();
    }

    private push(xml: string): void {
        if (!xml || !this.sheet) {
            return;
        }
        const data = strToU8(xml);
        this.sheetBytes += data.length;
        if (this.sheetBytes > MAX_ZIP_BYTES) {
            throw new Error(
                "The worksheet is too large for an Excel file (more than 4 GB of XML).",
            );
        }
        this.sheet.push(data);
        this.check();
    }

    private check(): void {
        if (this.error) {
            throw this.error;
        }
        if (this.totalBytes > MAX_ZIP_BYTES) {
            throw new Error("The workbook is too large for an Excel file (more than 4 GB).");
        }
    }
}

function concat(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) {
        return parts[0];
    }
    const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

/** Start of a worksheet, header row included. */
function sheetStart(
    columns: ColumnInfo[],
    options: ExcelOptions,
    widths: number[] | undefined,
): string {
    const parts: string[] = [`${XML_HEADER}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`];
    // The XLSX format is strict about the order of these elements.
    if (options.includeHeaders && options.freezeHeaderRow) {
        parts.push(
            '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
                '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
                '<selection pane="bottomLeft"/></sheetView></sheetViews>',
        );
    }
    if (widths) {
        parts.push("<cols>");
        widths.forEach((width, i) => {
            parts.push(
                `<col min="${i + 1}" max="${i + 1}" width="${width}" bestFit="1" customWidth="1"/>`,
            );
        });
        parts.push("</cols>");
    }

    parts.push("<sheetData>");
    if (options.includeHeaders) {
        const style = options.boldHeaderRow ? Style.Bold : Style.Normal;
        parts.push(
            `<row r="1">${columns.map((c, i) => stringCell(cellReference(i, 1), c.columnName, style)).join("")}</row>`,
        );
    }
    return parts.join("");
}

function sheetEnd(columns: ColumnInfo[], options: ExcelOptions): string {
    let xml = "</sheetData>";
    if (options.includeHeaders && options.autoFilterHeaderRow && columns.length > 0) {
        xml += `<autoFilter ref="A1:${columnName(columns.length - 1)}1"/>`;
    }
    return xml + "</worksheet>";
}

/** One cell; NULL and unselected cells are left out, as sqltoolsservice does. */
function writeCell(reference: string, cell: CellValue | undefined, column: ColumnInfo): string {
    if (!cell || cell.isNull) {
        return "";
    }
    const text = cell.displayValue;
    switch (column.kind) {
        case "number":
            return NUMBER.test(text)
                ? `<c r="${reference}"><v>${text}</v></c>`
                : stringCell(reference, text);
        case "boolean": {
            const value = BOOLEAN_VALUES[text.toLowerCase()];
            return value === undefined
                ? stringCell(reference, text)
                : `<c r="${reference}" t="b"><v>${value}</v></c>`;
        }
        case "datetime": {
            const date = parseDateTime(text);
            return date
                ? `<c r="${reference}" s="${date.style}"><v>${date.serial}</v></c>`
                : stringCell(reference, text);
        }
        default:
            return stringCell(reference, text);
    }
}

function stringCell(reference: string, text: string, style: Style = Style.Normal): string {
    const s = style === Style.Normal ? "" : ` s="${style}"`;
    // xml:space keeps leading and trailing spaces.
    return `<c r="${reference}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
/** SQL Server bit is shown as 1/0, PostgreSQL boolean as true/false. */
const BOOLEAN_VALUES: Record<string, string> = { "1": "1", "0": "0", true: "1", false: "0" };

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?)?$/;
const TIME = /^(\d{2,}):(\d{2}):(\d{2})(\.\d+)?$/;

/**
 * Excel serial date (days since 1899-12-30) of a date, a time or a date and time
 * without time zone, with the style sqltoolsservice picks: Date when there is no
 * time part, Time for a time alone. Dates before 1900-03-01 stay text.
 */
export function parseDateTime(text: string): { serial: number; style: Style } | undefined {
    const time = TIME.exec(text);
    if (time) {
        const days = timeOfDay(time[1], time[2], time[3], time[4]);
        return { serial: days, style: days >= 1 ? Style.TimeMoreThan24Hours : Style.Time };
    }
    const match = DATE_TIME.exec(text);
    if (!match) {
        return undefined;
    }
    const [, year, month, day, hours, minutes, seconds, fraction] = match;
    const midnight = Date.UTC(Number(year), Number(month) - 1, Number(day));
    // Date.UTC maps years 0-99 to 1900-1999; such dates are before the cutoff anyway.
    if (Number.isNaN(midnight) || Number(year) < 1900 || midnight < EXCEL_DATE_CUTOFF) {
        return undefined;
    }
    const dayPart = Math.round((midnight - EXCEL_EPOCH) / MS_PER_DAY);
    const timePart = hours === undefined ? 0 : timeOfDay(hours, minutes, seconds, fraction);
    return { serial: dayPart + timePart, style: timePart === 0 ? Style.Date : Style.DateTime };
}

function timeOfDay(
    hours: string,
    minutes: string,
    seconds: string,
    fraction: string | undefined,
): number {
    const totalSeconds =
        Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction ?? 0);
    return totalSeconds / 86_400;
}

/*
 * Column widths come from the longest text of each column: header widths in pixels, widened
 * row by row, then converted to Excel units. sqltoolsservice measures the text in Calibri 11
 * with Skia; an average character width is close enough.
 */
function headerPixels(columns: ColumnInfo[], options: ExcelOptions): number[] {
    return columns.map((column) => {
        let width = 0;
        if (options.includeHeaders) {
            width = textPixels(column.columnName) * (options.boldHeaderRow ? 1.1 : 1);
            if (options.autoFilterHeaderRow) {
                width += AUTO_FILTER_PIXEL_WIDTH;
            }
        }
        return width;
    });
}

/** Widths in pixels, widened to the cells of `rows`. */
function widenColumns(pixels: number[], rows: (CellValue | undefined)[][]): number[] {
    for (const row of rows) {
        for (let i = 0; i < pixels.length; i++) {
            const cell = row[i];
            if (cell && !cell.isNull) {
                pixels[i] = Math.max(pixels[i], textPixels(cell.displayValue));
            }
        }
    }
    return pixels;
}

function toExcelWidth(pixels: number): number {
    const width = Math.trunc(((pixels + 15) / FONT_PIXEL_WIDTH) * 256) / 256;
    return Math.min(width, MAX_COLUMN_WIDTH);
}

/** Width of the longest line of a text, in pixels. */
function textPixels(text: string): number {
    let longest = 0;
    for (const line of text.split(/\r\n|\r|\n/)) {
        longest = Math.max(longest, line.length);
    }
    return longest * FONT_PIXEL_WIDTH;
}

/** "A1"-style reference of a 0-based column and a 1-based row. */
function cellReference(column: number, row: number): string {
    return `${columnName(column)}${row}`;
}

/** Excel column letters of a 0-based column: A, ..., Z, AA, ... */
export function columnName(column: number): string {
    let name = "";
    for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    }
    return name;
}

/** Escapes XML text and drops the characters XML cannot hold (sqltoolsservice's SanitizeXmlString). */
function escapeXml(text: string): string {
    return text
        .replace(/[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function writeContentTypes(sheetCount: number): string {
    const sheets = Array.from(
        { length: sheetCount },
        (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
            `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ).join("");
    return (
        `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `${sheets}</Types>`
    );
}

function writeWorkbook(sheetCount: number): string {
    const sheets = Array.from(
        { length: sheetCount },
        (_, i) => `<sheet name="sheet${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    ).join("");
    return `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheets}</sheets></workbook>`;
}

function writeWorkbookRels(sheetCount: number): string {
    const sheets = Array.from(
        { length: sheetCount },
        (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    ).join("");
    return (
        `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">` +
        `<Relationship Id="rId0" Type="${REL_NS}/styles" Target="styles.xml"/>${sheets}</Relationships>`
    );
}

/** sqltoolsservice's styles.xml: formats for date, time, date and time, [h]:mm:ss, and a bold font. */
const FONT =
    '<sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/>';
const STYLES =
    `${XML_HEADER}<styleSheet xmlns="${MAIN_NS}">` +
    '<numFmts count="4">' +
    '<numFmt numFmtId="166" formatCode="yyyy-mm-dd"/>' +
    '<numFmt numFmtId="167" formatCode="hh:mm:ss"/>' +
    '<numFmt numFmtId="168" formatCode="yyyy-mm-dd hh:mm:ss"/>' +
    '<numFmt numFmtId="169" formatCode="[h]:mm:ss"/>' +
    "</numFmts>" +
    `<fonts count="2"><font>${FONT}</font><font><b/>${FONT}</font></fonts>` +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="6">' +
    '<xf xfId="0"/>' +
    '<xf numFmtId="166" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="167" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="168" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="169" xfId="0" applyNumberFormat="1"/>' +
    '<xf xfId="0" fontId="1"/>' +
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" builtinId="0" xfId="0"/></cellStyles>' +
    "</styleSheet>";
