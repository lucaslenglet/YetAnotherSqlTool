import { describe, expect, it } from "vitest";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import type { Driver } from "../../src/drivers/types";
import { classifySql, type SqlTokenKind } from "../../src/languageFeatures/sqlClassifier";

/**
 * The script's classified tokens, one "text kind" string each, in order. Kinds are abbreviated
 * to keep the fixtures readable: kw, type, fn, id, var, str, num, op, cmt, $.
 */
function render(driver: Driver, script: string): string[] {
    const short: Record<SqlTokenKind, string> = {
        keyword: "kw",
        type: "type",
        function: "fn",
        identifier: "id",
        variable: "var",
        string: "str",
        number: "num",
        operator: "op",
        comment: "cmt",
        dollarQuote: "$",
    };
    return classifySql(script, driver).map(
        (token) => `${script.slice(token.start, token.end)} ${short[token.kind]}`,
    );
}

/** Kind of the `occurrence`-th token whose text is `text`. */
function kindOf(driver: Driver, script: string, text: string, occurrence = 1): string | undefined {
    return render(driver, script)
        .filter((line) => line.startsWith(`${text} `))
        [occurrence - 1]?.slice(text.length + 1);
}

describe("classifySql, PostgreSQL", () => {
    it("classifies a realistic query", () => {
        const script = [
            "-- active users",
            "SELECT u.id, u.name, count(*) AS n, now()::date",
            'FROM public."Users" u',
            "WHERE u.email ILIKE '%@x.org' AND u.created_at > $1",
            "  AND u.tags @> ARRAY['a'] /* json */ AND u.data->>'k' = E'\\n'",
            "RETURNING id;",
        ].join("\n");
        expect(render(pgDriver, script)).toEqual([
            "-- active users cmt",
            "SELECT kw",
            "u id",
            "id id",
            "u id",
            "name id",
            "count fn",
            "* op",
            "AS kw",
            "n id",
            "now fn",
            ":: op",
            "date type",
            "FROM kw",
            "public id",
            '"Users" id',
            "u id",
            "WHERE kw",
            "u id",
            "email id",
            "ILIKE kw",
            "'%@x.org' str",
            "AND kw",
            "u id",
            "created_at id",
            "> op",
            "$1 var",
            "AND kw",
            "u id",
            "tags id",
            "@> op",
            "ARRAY kw",
            "[ op",
            "'a' str",
            "] op",
            "/* json */ cmt",
            "AND kw",
            "u id",
            "data id",
            "->> op",
            "'k' str",
            "= op",
            "E'\\n' str",
            "RETURNING kw",
            "id id",
        ]);
    });

    it("does not color T-SQL words as keywords, types or functions", () => {
        const script = "SELECT TOP 10 GETDATE(), CAST(x AS NVARCHAR(10)), [x] FROM t\nGO";
        expect(kindOf(pgDriver, script, "TOP")).toBe("id");
        expect(kindOf(pgDriver, script, "GETDATE")).toBe("id");
        expect(kindOf(pgDriver, script, "NVARCHAR")).toBe("id");
        expect(kindOf(pgDriver, script, "GO")).toBe("id");
        expect(kindOf(pgDriver, script, "[")).toBe("op");
        expect(kindOf(pgDriver, script, "x", 2)).toBe("id");
    });

    it("tells functions, keywords and types apart by their context", () => {
        const script =
            "SELECT left(a, 1), replace(b, 'x', ''), date, text FROM t LEFT JOIN u ON true;\n" +
            "SELECT a::text, CAST(b AS timestamp with time zone), c::double precision, '1'::name;";
        expect(kindOf(pgDriver, script, "left")).toBe("fn");
        expect(kindOf(pgDriver, script, "replace")).toBe("fn");
        expect(kindOf(pgDriver, script, "date")).toBe("id");
        // TEXT is an unreserved keyword of PostgreSQL (COPY ... FORMAT text).
        expect(kindOf(pgDriver, script, "text")).toBe("kw");
        expect(kindOf(pgDriver, script, "LEFT")).toBe("kw");
        expect(kindOf(pgDriver, script, "true")).toBe("kw");
        expect(kindOf(pgDriver, script, "text", 2)).toBe("type");
        expect(kindOf(pgDriver, script, "CAST")).toBe("fn");
        for (const word of ["timestamp", "with", "time", "zone", "double", "precision", "name"]) {
            expect(kindOf(pgDriver, script, word), word).toBe("type");
        }
    });

    it("treats a word next to a dot as a name", () => {
        const script = "SELECT t.select, s.left, pg_catalog.now() FROM s.table t";
        expect(kindOf(pgDriver, script, "select")).toBe("id");
        expect(kindOf(pgDriver, script, "left")).toBe("id");
        expect(kindOf(pgDriver, script, "now")).toBe("id");
        expect(kindOf(pgDriver, script, "table")).toBe("id");
        expect(kindOf(pgDriver, script, "pg_catalog")).toBe("id");
    });

    it("finds column names and types in CREATE TABLE and ALTER TABLE", () => {
        const script = [
            "CREATE TABLE IF NOT EXISTS app.items (",
            "  id bigserial PRIMARY KEY,",
            "  name text NOT NULL,",
            "  value numeric(10, 2) DEFAULT 0,",
            "  at timestamp(3) with time zone,",
            "  CONSTRAINT items_value CHECK (value > 0)",
            ");",
            "ALTER TABLE app.items ADD COLUMN type varchar(20), ALTER COLUMN at TYPE date;",
        ].join("\n");
        const lines = render(pgDriver, script);
        expect(lines).toContain("id id");
        expect(lines).toContain("bigserial type");
        expect(kindOf(pgDriver, script, "name")).toBe("id");
        expect(kindOf(pgDriver, script, "text")).toBe("type");
        expect(kindOf(pgDriver, script, "value")).toBe("id");
        expect(kindOf(pgDriver, script, "numeric")).toBe("type");
        expect(kindOf(pgDriver, script, "timestamp")).toBe("type");
        expect(kindOf(pgDriver, script, "zone")).toBe("type");
        expect(kindOf(pgDriver, script, "3")).toBe("num");
        expect(kindOf(pgDriver, script, "CONSTRAINT")).toBe("kw");
        expect(kindOf(pgDriver, script, "type")).toBe("id");
        expect(kindOf(pgDriver, script, "varchar")).toBe("type");
        expect(kindOf(pgDriver, script, "date")).toBe("type");
    });

    it("finds parameter names and types of a function", () => {
        const script =
            "CREATE OR REPLACE FUNCTION f(IN a integer, b text DEFAULT 'x', int, OUT r jsonb)\n" +
            "RETURNS SETOF record AS 'select 1' LANGUAGE sql;";
        expect(kindOf(pgDriver, script, "IN")).toBe("kw");
        expect(kindOf(pgDriver, script, "a")).toBe("id");
        expect(kindOf(pgDriver, script, "integer")).toBe("type");
        expect(kindOf(pgDriver, script, "b")).toBe("id");
        expect(kindOf(pgDriver, script, "text")).toBe("type");
        expect(kindOf(pgDriver, script, "int")).toBe("type");
        expect(kindOf(pgDriver, script, "jsonb")).toBe("type");
        expect(kindOf(pgDriver, script, "'select 1'")).toBe("str");
    });

    it("classifies the SQL inside a function body and a DO block", () => {
        const script = [
            "CREATE FUNCTION add_one(x int) RETURNS int AS $body$",
            "  SELECT x + 1; -- inc",
            "$body$ LANGUAGE sql;",
            "DO $$ BEGIN PERFORM pg_sleep(1); EXECUTE $q$SELECT 1$q$; END $$;",
            "SELECT $$not code$$, $t$also not$t$;",
        ].join("\n");
        const lines = render(pgDriver, script);
        const body = lines.indexOf("$body$ $");
        expect(lines.slice(body, body + 7)).toEqual([
            "$body$ $",
            "SELECT kw",
            "x id",
            "+ op",
            "1 num",
            "-- inc cmt",
            "$body$ $",
        ]);
        expect(kindOf(pgDriver, script, "$$", 1)).toBe("$");
        expect(kindOf(pgDriver, script, "BEGIN")).toBe("kw");
        expect(kindOf(pgDriver, script, "pg_sleep")).toBe("fn");
        expect(kindOf(pgDriver, script, "$q$SELECT 1$q$")).toBe("str");
        expect(kindOf(pgDriver, script, "$$not code$$")).toBe("str");
        expect(kindOf(pgDriver, script, "$t$also not$t$")).toBe("str");
    });

    it("leaves the body of a function in another language as a string", () => {
        const script = "CREATE FUNCTION f() RETURNS int AS $$ return 1 $$ LANGUAGE plpython3u;";
        expect(kindOf(pgDriver, script, "$$ return 1 $$")).toBe("str");
    });

    it("keeps an unterminated dollar body as code up to the end", () => {
        const script = "DO $$ BEGIN SELECT 1";
        expect(render(pgDriver, script)).toEqual([
            "DO kw",
            "$$ $",
            "BEGIN kw",
            "SELECT kw",
            "1 num",
        ]);
    });
});

describe("classifySql, SQL Server", () => {
    it("classifies a realistic batch", () => {
        const script = [
            "DECLARE @n INT = 5, @name NVARCHAR(50) = N'x';",
            "SELECT TOP (@n) [o].[name], o.type, GETDATE() AS now, @@ROWCOUNT",
            "FROM sys.objects AS o",
            "WHERE o.name LIKE 'sys%' -- system",
            "GO",
        ].join("\n");
        expect(render(mssqlDriver, script)).toEqual([
            "DECLARE kw",
            "@n var",
            "INT type",
            "= op",
            "5 num",
            "@name var",
            "NVARCHAR type",
            "50 num",
            "= op",
            "N'x' str",
            "SELECT kw",
            "TOP kw",
            "@n var",
            "[o] id",
            "[name] id",
            "o id",
            "type id",
            "GETDATE fn",
            "AS kw",
            // Microsoft's grammar has NOW among its keywords.
            "now kw",
            "@@ROWCOUNT fn",
            "FROM kw",
            "sys id",
            "objects id",
            "AS kw",
            "o id",
            "WHERE kw",
            "o id",
            "name id",
            "LIKE kw",
            "'sys%' str",
            "-- system cmt",
            "GO kw",
        ]);
    });

    it("does not color PostgreSQL words as keywords, types or functions", () => {
        const script =
            "SELECT x::jsonb, jsonb_build_object() FROM t WHERE a ILIKE 'b' RETURNING id";
        expect(kindOf(mssqlDriver, script, "jsonb")).toBe("id");
        expect(kindOf(mssqlDriver, script, "jsonb_build_object")).toBe("id");
        expect(kindOf(mssqlDriver, script, "ILIKE")).toBe("id");
        expect(kindOf(mssqlDriver, script, "RETURNING")).toBe("id");
    });

    it("colors GO only alone on its line", () => {
        const script = "SELECT go FROM t\n  GO 3 -- again\r\nSELECT 1 GO";
        expect(kindOf(mssqlDriver, script, "go")).toBe("id");
        expect(kindOf(mssqlDriver, script, "GO", 1)).toBe("kw");
        expect(kindOf(mssqlDriver, script, "GO", 2)).toBe("id");
    });

    it("tells functions from keywords, and finds types in CAST, CONVERT and tables", () => {
        const script = [
            "SELECT LEFT(a, 1), CONVERT(VARCHAR(10), d, 120), CAST(x AS date), date",
            "FROM a LEFT JOIN b ON 1 = 1",
            "CREATE TABLE #t (id INT IDENTITY(1, 1), [key] sysname, value DECIMAL(9, 2))",
            "DECLARE @t TABLE (type TINYINT)",
            "ALTER TABLE dbo.t ADD flag BIT",
        ].join("\n");
        expect(kindOf(mssqlDriver, script, "LEFT", 1)).toBe("fn");
        expect(kindOf(mssqlDriver, script, "LEFT", 2)).toBe("kw");
        expect(kindOf(mssqlDriver, script, "CONVERT")).toBe("fn");
        expect(kindOf(mssqlDriver, script, "VARCHAR")).toBe("type");
        expect(kindOf(mssqlDriver, script, "date", 1)).toBe("type");
        // Microsoft's grammar has the type names among its keywords.
        expect(kindOf(mssqlDriver, script, "date", 2)).toBe("kw");
        expect(kindOf(mssqlDriver, script, "#t")).toBe("id");
        expect(kindOf(mssqlDriver, script, "IDENTITY")).toBe("fn");
        expect(kindOf(mssqlDriver, script, "sysname")).toBe("type");
        expect(kindOf(mssqlDriver, script, "value")).toBe("id");
        expect(kindOf(mssqlDriver, script, "DECIMAL")).toBe("type");
        expect(kindOf(mssqlDriver, script, "type")).toBe("id");
        expect(kindOf(mssqlDriver, script, "TINYINT")).toBe("type");
        expect(kindOf(mssqlDriver, script, "flag")).toBe("id");
        expect(kindOf(mssqlDriver, script, "BIT")).toBe("type");
    });

    it("never fails on unfinished text", () => {
        for (const script of ["SELECT '", "SELECT [a", "/* x", "CAST(", "CREATE TABLE t (", "::"]) {
            expect(() => classifySql(script, mssqlDriver)).not.toThrow();
            expect(() => classifySql(script, pgDriver)).not.toThrow();
        }
    });
});
