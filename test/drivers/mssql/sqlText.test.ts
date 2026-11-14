import { describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import type { CellValue, ColumnInfo } from "../../../src/drivers/types";

const column = (dataTypeName: string, kind: ColumnInfo["kind"]): ColumnInfo => ({
    columnName: "c",
    dataTypeName,
    kind,
});
const cell = (displayValue: string): CellValue => ({ displayValue, isNull: false });
const literal = (displayValue: string, dataTypeName: string, kind: ColumnInfo["kind"]) =>
    mssqlDriver.toSqlLiteral(cell(displayValue), column(dataTypeName, kind));

describe("quoteIdentifier", () => {
    it("wraps in brackets and doubles closing brackets", () => {
        expect(mssqlDriver.quoteIdentifier("customers")).toBe("[customers]");
        expect(mssqlDriver.quoteIdentifier("we]ird")).toBe("[we]]ird]");
        expect(mssqlDriver.quoteIdentifier("a b[c")).toBe("[a b[c]");
    });
});

describe("toSqlLiteral", () => {
    it("renders NULL", () => {
        expect(
            mssqlDriver.toSqlLiteral(
                { displayValue: "NULL", isNull: true },
                column("int", "number"),
            ),
        ).toBe("NULL");
    });

    it("renders numbers raw", () => {
        expect(literal("42", "int", "number")).toBe("42");
        expect(literal("-0.01", "decimal", "number")).toBe("-0.01");
        expect(literal("1E+300", "float", "number")).toBe("1E+300");
    });

    it("renders bit as 0 / 1", () => {
        expect(literal("1", "bit", "boolean")).toBe("1");
        expect(literal("0", "bit", "boolean")).toBe("0");
    });

    it("renders strings as N'...' with doubled quotes", () => {
        expect(literal("it's", "varchar", "string")).toBe("N'it''s'");
        expect(literal("日本", "nvarchar", "string")).toBe("N'日本'");
        expect(literal("<a/>", "xml", "xml")).toBe("N'<a/>'");
    });

    it("renders binary as a hex literal", () => {
        expect(literal("0xDEADBEEF", "varbinary", "binary")).toBe("0xDEADBEEF");
        expect(literal("0x", "varbinary", "binary")).toBe("0x");
    });

    it("renders dates and times as quoted display values", () => {
        expect(literal("2024-03-15 13:45:30.1234567", "datetime2", "datetime")).toBe(
            "'2024-03-15 13:45:30.1234567'",
        );
        expect(literal("2024-03-15 13:45:30.1234567 +02:00", "datetimeoffset", "datetime")).toBe(
            "'2024-03-15 13:45:30.1234567 +02:00'",
        );
        expect(literal("13:45:30", "time", "datetime")).toBe("'13:45:30'");
    });

    it("renders uniqueidentifier without the N prefix", () => {
        expect(literal("6f9619ff-8b86-d011-b42d-00c04fc964ff", "uniqueidentifier", "string")).toBe(
            "'6f9619ff-8b86-d011-b42d-00c04fc964ff'",
        );
    });

    it("renders datetime and smalldatetime in ISO 8601, which no DATEFORMAT reads otherwise", () => {
        expect(literal("2024-01-02 03:04:05.007", "datetime", "datetime")).toBe(
            "'2024-01-02T03:04:05.007'",
        );
        expect(literal("2024-01-02 03:04:00", "smalldatetime", "datetime")).toBe(
            "'2024-01-02T03:04:00'",
        );
    });
});
