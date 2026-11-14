import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { CellValue, ColumnInfo, ValueKind } from "../../src/drivers/types";
import { columnName, formatExcel, parseDateTime } from "../../src/queryResult/export/excel";
import type { ExcelOptions, ExportTable } from "../../src/queryResult/export/types";

const column = (columnName: string, kind: ValueKind): ColumnInfo => ({
    columnName,
    dataTypeName: kind,
    kind,
});
const cell = (displayValue: string): CellValue => ({ displayValue, isNull: false });
const NULL: CellValue = { displayValue: "NULL", isNull: true };

const defaults: ExcelOptions = {
    includeHeaders: true,
    freezeHeaderRow: false,
    boldHeaderRow: false,
    autoFilterHeaderRow: false,
    autoSizeColumns: false,
};

function unzip(
    table: ExportTable,
    options: Partial<ExcelOptions> = {},
    maxRows?: number,
): Record<string, string> {
    const files = unzipSync(formatExcel(table, { ...defaults, ...options }, maxRows));
    return Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [name, strFromU8(bytes)]),
    );
}

describe("formatExcel", () => {
    const table: ExportTable = {
        columns: [
            column("id", "number"),
            column("name", "string"),
            column("ok", "boolean"),
            column("at", "datetime"),
        ],
        rows: [
            [cell("1"), cell("a <b> & c"), cell("1"), cell("2024-03-15 10:30:00.000")],
            [cell("2.5"), NULL, cell("false"), cell("2024-03-15")],
            [cell("NaN"), cell(" x "), undefined, cell("2024-03-15 10:30:00+01")],
        ],
    };

    it("writes the parts of a minimal workbook", () => {
        const files = unzip(table);
        expect(Object.keys(files).sort()).toEqual([
            "[Content_Types].xml",
            "_rels/.rels",
            "xl/_rels/workbook.xml.rels",
            "xl/styles.xml",
            "xl/workbook.xml",
            "xl/worksheets/sheet1.xml",
        ]);
        expect(files["xl/workbook.xml"]).toContain(
            '<sheet name="sheet1" sheetId="1" r:id="rId1"/>',
        );
    });

    it("types the cells from the column kind", () => {
        const sheet = unzip(table)["xl/worksheets/sheet1.xml"];
        expect(sheet).toContain(
            '<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">id</t></is></c>',
        );
        expect(sheet).toContain('<c r="A2"><v>1</v></c>');
        expect(sheet).toContain('<t xml:space="preserve">a &lt;b&gt; &amp; c</t>');
        expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
        expect(sheet).toContain('<c r="C3" t="b"><v>0</v></c>');
        // 2024-03-15 is serial 45366; 10:30 is 0.4375 of a day.
        expect(sheet).toContain('<c r="D2" s="3"><v>45366.4375</v></c>');
        expect(sheet).toContain('<c r="D3" s="1"><v>45366</v></c>');
        // NULL cells are left out.
        expect(sheet).not.toContain('r="B3"');
        // Not a number, a time zone: text.
        expect(sheet).toContain('<c r="A4" t="inlineStr"><is><t xml:space="preserve">NaN</t>');
        expect(sheet).toContain('<t xml:space="preserve"> x </t>');
        expect(sheet).not.toContain('r="C4"');
        expect(sheet).toContain('<t xml:space="preserve">2024-03-15 10:30:00+01</t>');
    });

    it("applies the header options", () => {
        const sheet = unzip(table, {
            freezeHeaderRow: true,
            boldHeaderRow: true,
            autoFilterHeaderRow: true,
            autoSizeColumns: true,
        })["xl/worksheets/sheet1.xml"];
        expect(sheet).toMatch(
            /<sheetViews>.*state="frozen".*<\/sheetViews><cols>.*<\/cols><sheetData>/,
        );
        expect(sheet).toContain('<c r="A1" t="inlineStr" s="5">');
        expect(sheet).toContain('<autoFilter ref="A1:D1"/>');
        expect(sheet).toMatch(/<col min="1" max="1" width="[\d.]+" bestFit="1" customWidth="1"\/>/);
    });

    it("has no header options without headers", () => {
        const sheet = unzip(table, {
            includeHeaders: false,
            freezeHeaderRow: true,
            autoFilterHeaderRow: true,
        })["xl/worksheets/sheet1.xml"];
        expect(sheet).not.toContain("sheetViews");
        expect(sheet).not.toContain("autoFilter");
        expect(sheet).toContain('<row r="1"><c r="A1"><v>1</v></c>');
    });

    it("starts a new sheet, with its header, when one is full", () => {
        const rows = Array.from({ length: 5 }, (_, i) => [cell(String(i))]);
        const files = unzip({ columns: [column("n", "number")], rows }, {}, 3);
        expect(Object.keys(files).filter((f) => f.startsWith("xl/worksheets/"))).toHaveLength(3);
        expect(files["xl/worksheets/sheet3.xml"]).toContain('<row r="1"><c r="A1" t="inlineStr">');
        expect(files["xl/worksheets/sheet3.xml"]).toContain(
            '<row r="2"><c r="A2"><v>4</v></c></row>',
        );
        expect(files["[Content_Types].xml"]).toContain("/xl/worksheets/sheet3.xml");
    });

    it("writes one sheet for an empty result", () => {
        const files = unzip({ columns: [column("n", "number")], rows: [] });
        expect(files["xl/worksheets/sheet1.xml"]).toContain('<sheetData><row r="1">');
    });

    it("drops characters XML cannot hold", () => {
        const sheet = unzip({ columns: [column("s", "string")], rows: [[cell("a\u0001b")]] })[
            "xl/worksheets/sheet1.xml"
        ];
        expect(sheet).toContain('<t xml:space="preserve">ab</t>');
    });
});

describe("parseDateTime", () => {
    it("reads dates, times and dates with times", () => {
        expect(parseDateTime("1900-03-01")).toEqual({ serial: 61, style: 1 });
        expect(parseDateTime("10:30:00.1234567")?.style).toBe(2);
        expect(parseDateTime("10:30:00")?.serial).toBeCloseTo(0.4375);
        expect(parseDateTime("25:00:00")?.style).toBe(4);
        expect(parseDateTime("2024-03-15T00:00:00")).toEqual({ serial: 45366, style: 1 });
    });

    it("keeps as text what Excel cannot show as a date", () => {
        expect(parseDateTime("1900-02-28")).toBeUndefined();
        expect(parseDateTime("0099-01-01")).toBeUndefined();
        expect(parseDateTime("2024-03-15 10:30:00+01")).toBeUndefined();
        expect(parseDateTime("2024-03-15 BC")).toBeUndefined();
        expect(parseDateTime("1 day 02:00:00")).toBeUndefined();
    });
});

describe("columnName", () => {
    it("counts in letters", () => {
        expect([0, 25, 26, 701, 702, 16383].map(columnName)).toEqual([
            "A",
            "Z",
            "AA",
            "ZZ",
            "AAA",
            "XFD",
        ]);
    });
});
