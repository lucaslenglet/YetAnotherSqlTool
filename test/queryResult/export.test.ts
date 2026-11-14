import { describe, expect, it } from "vitest";
import type { CellValue, ColumnInfo, ValueKind } from "../../src/drivers/types";
import { formatCsv } from "../../src/queryResult/export/csv";
import { formatJson } from "../../src/queryResult/export/json";
import {
    formatInClause,
    formatInsert,
    formatSqlLiteral,
    quoteIdentifier,
} from "../../src/queryResult/export/sql";
import type { CsvOptions, ExportTable } from "../../src/queryResult/export/types";

const col = (columnName: string, kind: ValueKind = "string"): ColumnInfo => ({
    columnName,
    dataTypeName: kind,
    kind,
});
const v = (displayValue: string): CellValue => ({
    displayValue,
    isNull: false,
});
const NULL: CellValue = { displayValue: "NULL", isNull: true };

const csvOpts: CsvOptions = {
    includeHeaders: true,
    delimiter: ",",
    lineSeparator: "\n",
    textIdentifier: '"',
};
const csv = (
    rows: (CellValue | undefined)[][],
    o: Partial<CsvOptions> = {},
    columns = [col("a"), col("b")],
) => formatCsv({ columns, rows }, { ...csvOpts, ...o });

describe("formatCsv", () => {
    it("writes headers and ends every line with the separator", () => {
        expect(csv([[v("1"), v("2")]])).toBe("a,b\n1,2\n");
    });
    it("omits headers when asked", () => {
        expect(csv([[v("1"), v("2")]], { includeHeaders: false })).toBe("1,2\n");
    });
    it("quotes fields with delimiter, quote, CR or LF", () => {
        expect(csv([[v("x,y"), v('say "hi"')]], { includeHeaders: false })).toBe(
            '"x,y","say ""hi"""\n',
        );
        expect(csv([[v("a\nb"), v("a\rb")]], { includeHeaders: false })).toBe('"a\nb","a\rb"\n');
    });
    it("quotes fields starting or ending with space or tab", () => {
        const out = csv(
            [
                [v(" a"), v("b ")],
                [v("\tc"), v("d\t")],
                [v("a b"), v("ok")],
            ],
            { includeHeaders: false },
        );
        expect(out).toBe('" a","b "\n"\tc","d\t"\na b,ok\n');
    });
    it("quotes header names like fields", () => {
        expect(csv([], {}, [col("a,b"), col("c")])).toBe('"a,b",c\n');
    });
    it("distinguishes selected NULL from unselected cells", () => {
        expect(csv([[NULL, undefined]], { includeHeaders: false })).toBe("NULL,\n");
    });
    it("supports a custom delimiter and text identifier, using only the first character", () => {
        const out = csv([[v("a;b"), v("it's")]], {
            includeHeaders: false,
            delimiter: ";;",
            textIdentifier: "'",
        });
        expect(out).toBe("'a;b';'it''s'\n");
    });
    it("falls back to defaults when the options are empty", () => {
        expect(
            csv([[v("a,b"), v("c")]], {
                includeHeaders: false,
                delimiter: "",
                textIdentifier: "",
            }),
        ).toBe('"a,b",c\n');
    });
    it("uses the given line separator", () => {
        expect(csv([[v("1"), v("2")]], { lineSeparator: "\r\n" })).toBe("a,b\r\n1,2\r\n");
    });
});

describe("formatJson", () => {
    const opts = { lineSeparator: "\n" };
    it("matches the Newtonsoft indented layout", () => {
        const table: ExportTable = {
            columns: [col("id", "number"), col("name")],
            rows: [
                [v("1"), v("a")],
                [v("2"), NULL],
            ],
        };
        expect(formatJson(table, opts)).toBe(
            [
                "[",
                "  {",
                '    "id": 1,',
                '    "name": "a"',
                "  },",
                "  {",
                '    "id": 2,',
                '    "name": null',
                "  }",
                "]",
            ].join("\n"),
        );
    });
    it("writes [] for zero rows", () => {
        expect(formatJson({ columns: [col("a")], rows: [] }, opts)).toBe("[]");
    });
    it("writes unselected cells as null", () => {
        expect(formatJson({ columns: [col("a")], rows: [[undefined]] }, opts)).toBe(
            '[\n  {\n    "a": null\n  }\n]',
        );
    });
    it("writes numbers raw when valid JSON numbers, else as strings", () => {
        const table: ExportTable = {
            columns: [
                col("a", "number"),
                col("b", "number"),
                col("c", "number"),
                col("d", "number"),
            ],
            rows: [[v("12345678901234567890.123456789"), v("-1.5e10"), v("NaN"), v("01")]],
        };
        const out = formatJson(table, opts);
        expect(out).toContain('"a": 12345678901234567890.123456789,');
        expect(out).toContain('"b": -1.5e10,');
        expect(out).toContain('"c": "NaN",');
        expect(out).toContain('"d": "01"');
    });
    it("writes booleans for both engines and falls back to strings", () => {
        const table: ExportTable = {
            columns: [
                col("a", "boolean"),
                col("b", "boolean"),
                col("c", "boolean"),
                col("d", "boolean"),
                col("e", "boolean"),
            ],
            rows: [[v("1"), v("0"), v("true"), v("false"), v("maybe")]],
        };
        const out = formatJson(table, opts);
        expect(out).toContain('"a": true,');
        expect(out).toContain('"b": false,');
        expect(out).toContain('"c": true,');
        expect(out).toContain('"d": false,');
        expect(out).toContain('"e": "maybe"');
    });
    it("escapes strings and keeps duplicate column names", () => {
        const table: ExportTable = {
            columns: [col("x"), col("x")],
            rows: [[v('a"b\n'), v("2")]],
        };
        expect(formatJson(table, opts)).toBe('[\n  {\n    "x": "a\\"b\\n",\n    "x": "2"\n  }\n]');
    });
    it("uses the given line separator", () => {
        expect(
            formatJson({ columns: [col("a")], rows: [[v("x")]] }, { lineSeparator: "\r\n" }),
        ).toBe('[\r\n  {\r\n    "a": "x"\r\n  }\r\n]');
    });
});

describe("quoteIdentifier", () => {
    it("mssql leaves simple names and brackets the rest", () => {
        expect(quoteIdentifier("Name_1", "mssql")).toBe("Name_1");
        expect(quoteIdentifier("a@b#c$", "mssql")).toBe("a@b#c$");
        expect(quoteIdentifier("@p", "mssql")).toBe("[@p]");
        expect(quoteIdentifier("my col", "mssql")).toBe("[my col]");
        expect(quoteIdentifier("1abc", "mssql")).toBe("[1abc]");
        expect(quoteIdentifier("a]b", "mssql")).toBe("[a]]b]");
        expect(quoteIdentifier("", "mssql")).toBe("");
    });
    it("pg leaves lower-case names and quotes the rest", () => {
        expect(quoteIdentifier("name_1$", "pg")).toBe("name_1$");
        expect(quoteIdentifier("Name", "pg")).toBe('"Name"');
        expect(quoteIdentifier("1abc", "pg")).toBe('"1abc"');
        expect(quoteIdentifier('a"b', "pg")).toBe('"a""b"');
        expect(quoteIdentifier("my col", "pg")).toBe('"my col"');
        expect(quoteIdentifier("", "pg")).toBe("");
    });
});

describe("formatSqlLiteral", () => {
    it("writes NULL for NULL and unselected cells", () => {
        expect(formatSqlLiteral(NULL, col("a"), "mssql")).toBe("NULL");
        expect(formatSqlLiteral(undefined, col("a", "number"), "pg")).toBe("NULL");
    });
    it("writes numbers raw, non-numeric ones quoted", () => {
        const n = col("a", "number");
        expect(formatSqlLiteral(v("-1.5e3"), n, "mssql")).toBe("-1.5e3");
        expect(formatSqlLiteral(v(".5"), n, "pg")).toBe(".5");
        expect(formatSqlLiteral(v("NaN"), n, "pg")).toBe("'NaN'");
        expect(formatSqlLiteral(v("Infinity"), n, "pg")).toBe("'Infinity'");
    });
    it("writes booleans raw", () => {
        const b = col("a", "boolean");
        expect(formatSqlLiteral(v("1"), b, "mssql")).toBe("1");
        expect(formatSqlLiteral(v("true"), b, "pg")).toBe("true");
    });
    it("writes binary raw on mssql and quoted on pg", () => {
        const b = col("a", "binary");
        expect(formatSqlLiteral(v("0xDEAD"), b, "mssql")).toBe("0xDEAD");
        expect(formatSqlLiteral(v("\\xdead"), b, "pg")).toBe("'\\xdead'");
    });
    it("quotes strings per dialect and doubles single quotes", () => {
        expect(formatSqlLiteral(v("it's"), col("a"), "mssql")).toBe("N'it''s'");
        expect(formatSqlLiteral(v("it's \\n"), col("a"), "pg")).toBe("'it''s \\n'");
        expect(formatSqlLiteral(v("2024-01-01"), col("a", "datetime"), "mssql")).toBe(
            "N'2024-01-01'",
        );
    });
});

describe("formatInsert", () => {
    const base = {
        dialect: "mssql" as const,
        tableName: "TableName",
        includeHeaders: true,
        lineSeparator: "\n",
    };
    it("writes one statement with columns", () => {
        const table: ExportTable = {
            columns: [col("id", "number"), col("my name")],
            rows: [
                [v("1"), v("a")],
                [v("2"), NULL],
            ],
        };
        expect(formatInsert(table, base)).toBe(
            "INSERT INTO TableName (id, [my name])\nVALUES\n    (1, N'a'),\n    (2, NULL);\n\n",
        );
    });
    it("omits the column list without headers and quotes the table name", () => {
        const table: ExportTable = {
            columns: [col("a", "number")],
            rows: [[v("1")]],
        };
        expect(
            formatInsert(table, {
                ...base,
                dialect: "pg",
                tableName: "My Table",
                includeHeaders: false,
            }),
        ).toBe('INSERT INTO "My Table"\nVALUES\n    (1);\n\n');
    });
    it("returns an empty string for zero rows", () => {
        expect(formatInsert({ columns: [col("a")], rows: [] }, base)).toBe("");
    });
    it("splits 1001 rows into two statements", () => {
        const rows = Array.from({ length: 1001 }, (_, i) => [v(String(i))]);
        const out = formatInsert({ columns: [col("a", "number")], rows }, base);
        expect(out.match(/INSERT INTO/g)).toHaveLength(2);
        expect(out.endsWith("    (1000);\n\n")).toBe(true);
        expect(out).toContain("    (999);\n\nINSERT INTO");
    });
});

describe("formatInClause", () => {
    const opts = { dialect: "mssql" as const, lineSeparator: "\n" };
    it("lays out values one per line", () => {
        const table: ExportTable = {
            columns: [col("a")],
            rows: [[v("x")], [NULL], [v("y")]],
        };
        expect(formatInClause(table, opts)).toBe("IN\n(\n    N'x',\n    NULL,\n    N'y'\n)\n");
    });
    it("skips unselected cells", () => {
        const table: ExportTable = {
            columns: [col("a", "number")],
            rows: [[v("1")], [undefined], [v("2")]],
        };
        expect(formatInClause(table, { ...opts, dialect: "pg" })).toBe("IN\n(\n    1,\n    2\n)\n");
    });
    it("requires exactly one column", () => {
        const msg = "Copying as an IN clause requires selecting exactly one column.";
        expect(() => formatInClause({ columns: [col("a"), col("b")], rows: [] }, opts)).toThrow(
            msg,
        );
        expect(() => formatInClause({ columns: [], rows: [] }, opts)).toThrow(msg);
    });
});
