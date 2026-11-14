import { describe, expect, it } from "vitest";
import { tokenize, tokenIndexAt, type SqlDialect, type SqlToken } from "../../src/sql/lexer";
import { mssqlDialect } from "../../src/drivers/mssql/statements";
import { pgDialect } from "../../src/drivers/pg/statements";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";

/** [type, text] of every token. */
const lex = (script: string, dialect: SqlDialect) =>
    tokenize(script, dialect).map((t) => [t.type, script.slice(t.start, t.end)]);

/** Tokens never overlap, are in order, and only whitespace is left out. */
function expectWellFormed(script: string, tokens: SqlToken[]): void {
    let previousEnd = 0;
    for (const token of tokens) {
        expect(token.start).toBeGreaterThanOrEqual(previousEnd);
        expect(token.end).toBeGreaterThan(token.start);
        expect(script.slice(previousEnd, token.start).trim()).toBe("");
        previousEnd = token.end;
    }
    expect(script.slice(previousEnd).trim()).toBe("");
}

describe("lexer, SQL Server dialect", () => {
    const t = (script: string) => lex(script, mssqlDialect);

    it("returns no token for an empty or blank script", () => {
        expect(t("")).toEqual([]);
        expect(t(" \r\n\t ")).toEqual([]);
    });

    it("tells words, numbers, punctuation and operators apart", () => {
        expect(t("SELECT a.b, 1.5e3 FROM t WHERE x<=2;")).toEqual([
            ["word", "SELECT"],
            ["word", "a"],
            ["punctuation", "."],
            ["word", "b"],
            ["punctuation", ","],
            ["number", "1.5e3"],
            ["word", "FROM"],
            ["word", "t"],
            ["word", "WHERE"],
            ["word", "x"],
            ["operator", "<="],
            ["number", "2"],
            ["punctuation", ";"],
        ]);
    });

    it("reads strings, N strings and doubled quotes", () => {
        expect(t("N'it''s' 'a' n'b'")).toEqual([
            ["string", "N'it''s'"],
            ["string", "'a'"],
            ["string", "n'b'"],
        ]);
    });

    it("reads bracket and double-quoted identifiers", () => {
        expect(t('[my ]] col] "x ""y"""')).toEqual([
            ["quotedIdentifier", "[my ]] col]"],
            ["quotedIdentifier", '"x ""y"""'],
        ]);
    });

    it("reads variables, system functions, temp tables and $ words", () => {
        expect(t("@x @@ROWCOUNT #t ##g $action @a#1")).toEqual([
            ["variable", "@x"],
            ["variable", "@@ROWCOUNT"],
            ["word", "#t"],
            ["word", "##g"],
            ["word", "$action"],
            ["variable", "@a#1"],
        ]);
    });

    it("reads binary and money literals", () => {
        expect(t("0x1F $12.50 .5")).toEqual([
            ["number", "0x1F"],
            ["number", "$12.50"],
            ["number", ".5"],
        ]);
    });

    it("reads line comments without their line break, and nested block comments", () => {
        expect(t("a -- c1\r\nb /* x /* y */ z */ c")).toEqual([
            ["word", "a"],
            ["lineComment", "-- c1"],
            ["word", "b"],
            ["blockComment", "/* x /* y */ z */"],
            ["word", "c"],
        ]);
    });

    it("keeps multi-character operators whole", () => {
        expect(t("a+=1 b<>c d!=e f::g h%=2 i!<j")).toEqual([
            ["word", "a"],
            ["operator", "+="],
            ["number", "1"],
            ["word", "b"],
            ["operator", "<>"],
            ["word", "c"],
            ["word", "d"],
            ["operator", "!="],
            ["word", "e"],
            ["word", "f"],
            ["operator", "::"],
            ["word", "g"],
            ["word", "h"],
            ["operator", "%="],
            ["number", "2"],
            ["word", "i"],
            ["operator", "!<"],
            ["word", "j"],
        ]);
    });

    it("extends unterminated constructs to the end of the script", () => {
        expect(t("SELECT 'abc\nde")).toEqual([
            ["word", "SELECT"],
            ["string", "'abc\nde"],
        ]);
        expect(t("a /* b /* c */")).toEqual([
            ["word", "a"],
            ["blockComment", "/* b /* c */"],
        ]);
        expect(t("[abc")).toEqual([["quotedIdentifier", "[abc"]]);
        expect(t('"abc')).toEqual([["quotedIdentifier", '"abc']]);
        expect(t("--")).toEqual([["lineComment", "--"]]);
    });

    it("gives unknown characters a token of their own", () => {
        expect(t("{fn x} ? `")).toEqual([
            ["operator", "{"],
            ["word", "fn"],
            ["word", "x"],
            ["operator", "}"],
            ["operator", "?"],
            ["operator", "`"],
        ]);
    });

    it("reports exact UTF-16 offsets", () => {
        const script = "SELECT N'é😀', [ü]\n  FROM t";
        const tokens = tokenize(script, mssqlDialect);
        expect(tokens.map((x) => [x.start, x.end])).toEqual([
            [0, 6],
            [7, 13],
            [13, 14],
            [15, 18],
            [21, 25],
            [26, 27],
        ]);
        expectWellFormed(script, tokens);
    });

    it("is the driver's tokenize", () => {
        expect(mssqlDriver.tokenize("[a]")).toEqual([
            { type: "quotedIdentifier", start: 0, end: 3 },
        ]);
    });
});

describe("lexer, PostgreSQL dialect", () => {
    const t = (script: string) => lex(script, pgDialect);

    it("reads E strings with backslash escapes and other prefixes", () => {
        expect(t("E'it\\'s' e'\\\\' 'a\\' B'101' X'1F' U&'d\\0061'")).toEqual([
            ["string", "E'it\\'s'"],
            ["string", "e'\\\\'"],
            ["string", "'a\\'"],
            ["string", "B'101'"],
            ["string", "X'1F'"],
            ["string", "U&'d\\0061'"],
        ]);
    });

    it("reads dollar-quoted strings", () => {
        expect(t("$$a;'b$$ $fn$ SELECT $$x$$; $fn$ $x")).toEqual([
            ["string", "$$a;'b$$"],
            ["string", "$fn$ SELECT $$x$$; $fn$"],
            ["operator", "$"],
            ["word", "x"],
        ]);
        expect(t("$body$ unterminated")).toEqual([["string", "$body$ unterminated"]]);
    });

    it("keeps $ inside words and reads positional parameters", () => {
        expect(t("a$b$ $1 $23")).toEqual([
            ["word", "a$b$"],
            ["variable", "$1"],
            ["variable", "$23"],
        ]);
    });

    it("has no bracket identifiers but double-quoted ones", () => {
        expect(t('[1] "a""b"')).toEqual([
            ["operator", "["],
            ["number", "1"],
            ["operator", "]"],
            ["quotedIdentifier", '"a""b"'],
        ]);
    });

    it("keeps PostgreSQL operators whole", () => {
        expect(t("a::int b->>'k' c#>>'{x}' d||e f@>g h<->i j~*k")).toEqual([
            ["word", "a"],
            ["operator", "::"],
            ["word", "int"],
            ["word", "b"],
            ["operator", "->>"],
            ["string", "'k'"],
            ["word", "c"],
            ["operator", "#>>"],
            ["string", "'{x}'"],
            ["word", "d"],
            ["operator", "||"],
            ["word", "e"],
            ["word", "f"],
            ["operator", "@>"],
            ["word", "g"],
            ["word", "h"],
            ["operator", "<->"],
            ["word", "i"],
            ["word", "j"],
            ["operator", "~*"],
            ["word", "k"],
        ]);
    });

    it("reads numbers with underscores, hex and exponents", () => {
        expect(t("1_000 0xFF 1.5e-3 2.")).toEqual([
            ["number", "1_000"],
            ["number", "0xFF"],
            ["number", "1.5e-3"],
            ["number", "2."],
        ]);
    });

    it("treats # as an operator, not a word", () => {
        expect(t("#t")).toEqual([
            ["operator", "#"],
            ["word", "t"],
        ]);
    });

    it("nests block comments", () => {
        expect(t("/* a /* b */ c */ d")).toEqual([
            ["blockComment", "/* a /* b */ c */"],
            ["word", "d"],
        ]);
    });

    it("is the driver's tokenize", () => {
        expect(pgDriver.tokenize("$1")).toEqual([{ type: "variable", start: 0, end: 2 }]);
    });

    it("produces well-formed tokens on a realistic script", () => {
        const script = [
            "CREATE FUNCTION f(a int) RETURNS int AS $$",
            "BEGIN RETURN a + 1; END $$ LANGUAGE plpgsql;",
            "SELECT f(1)::text || E'\\n', data->>'k' FROM t WHERE id = $1; -- done",
            "/* unterminated",
        ].join("\r\n");
        expectWellFormed(script, tokenize(script, pgDialect));
    });
});

describe("tokenIndexAt", () => {
    const tokens = tokenize("SELECT a,  b", mssqlDialect);

    it("finds the token containing an offset, or the last one before it", () => {
        expect(tokenIndexAt(tokens, 0)).toBe(0);
        expect(tokenIndexAt(tokens, 7)).toBe(1);
        expect(tokenIndexAt(tokens, 9)).toBe(2); // in the spaces after ","
        expect(tokenIndexAt(tokens, 11)).toBe(3);
        expect(tokenIndexAt(tokens, 99)).toBe(3);
    });

    it("returns -1 before the first token", () => {
        expect(tokenIndexAt(tokenize("  a", mssqlDialect), 0)).toBe(-1);
        expect(tokenIndexAt([], 0)).toBe(-1);
    });
});
