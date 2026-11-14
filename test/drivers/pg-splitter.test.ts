import { describe, expect, it } from "vitest";
import { offsetToPosition, splitStatements } from "../../src/drivers/pg/splitter";

const texts = (script: string) => splitStatements(script).map((s) => s.text);

describe("pg statement splitter", () => {
    it("splits on semicolons and ignores the empty tail", () => {
        expect(texts("SELECT 1; SELECT 2;\nSELECT 3")).toEqual([
            "SELECT 1",
            "SELECT 2",
            "SELECT 3",
        ]);
    });

    it("drops empty and comment-only statements", () => {
        expect(texts("")).toEqual([]);
        expect(texts("  ;; \n;")).toEqual([]);
        expect(texts("-- nothing here\n/* nor here */")).toEqual([]);
        expect(texts("-- first\nSELECT 1; -- trailing")).toEqual(["-- first\nSELECT 1"]);
    });

    it("keeps semicolons inside single-quoted strings", () => {
        expect(texts("SELECT 'a;b''c;d'; SELECT 2")).toEqual(["SELECT 'a;b''c;d'", "SELECT 2"]);
    });

    it("keeps semicolons inside double-quoted identifiers", () => {
        expect(texts('SELECT "a;b""c" FROM t; SELECT 2')).toEqual([
            'SELECT "a;b""c" FROM t',
            "SELECT 2",
        ]);
    });

    it("handles backslash escapes in E'' strings only", () => {
        expect(texts("SELECT E'it\\'s; ok'; SELECT 2")).toEqual([
            "SELECT E'it\\'s; ok'",
            "SELECT 2",
        ]);
        // In a normal string a backslash is a plain character: the quote after it closes the string.
        expect(texts("SELECT 'a\\'; SELECT 2")).toEqual(["SELECT 'a\\'", "SELECT 2"]);
        expect(texts("SELECT e'\\\\'; SELECT 2")).toEqual(["SELECT e'\\\\'", "SELECT 2"]);
    });

    it("does not mistake a name ending with e for an E string", () => {
        expect(texts("SELECT name'x\\'; SELECT 2")).toEqual(["SELECT name'x\\'", "SELECT 2"]);
    });

    it("keeps dollar-quoted bodies whole", () => {
        const body =
            "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql";
        expect(texts(`${body}; SELECT 2`)).toEqual([body, "SELECT 2"]);
    });

    it("handles tagged dollar quotes with a nested $$", () => {
        const body = "DO $body$ BEGIN PERFORM $$;$$; END $body$";
        expect(texts(`${body}; SELECT 2`)).toEqual([body, "SELECT 2"]);
    });

    it("does not treat parameters or identifiers with $ as dollar quotes", () => {
        expect(texts("SELECT $1; SELECT 2")).toEqual(["SELECT $1", "SELECT 2"]);
        expect(texts("SELECT a$b$ FROM t; SELECT 2")).toEqual(["SELECT a$b$ FROM t", "SELECT 2"]);
    });

    it("ignores semicolons in line comments", () => {
        expect(texts("SELECT 1 -- a; b\n; SELECT 2")).toEqual(["SELECT 1 -- a; b", "SELECT 2"]);
    });

    it("handles nested block comments", () => {
        expect(texts("SELECT 1 /* a; /* b; */ c; */; SELECT 2")).toEqual([
            "SELECT 1 /* a; /* b; */ c; */",
            "SELECT 2",
        ]);
    });

    it("ignores quote characters inside comments", () => {
        expect(texts("SELECT 1 -- it's\n; SELECT 2 /* ' */")).toEqual([
            "SELECT 1 -- it's",
            "SELECT 2 /* ' */",
        ]);
    });

    it("reports where each statement starts", () => {
        const script = "SELECT 1;\n  SELECT 2";
        const spans = splitStatements(script);
        expect(spans.map((s) => script.slice(s.start, s.start + s.text.length))).toEqual([
            "SELECT 1",
            "SELECT 2",
        ]);
    });

    it("converts offsets to line and column", () => {
        expect(offsetToPosition("ab\ncd\nef", 0)).toEqual({ line: 0, column: 0 });
        expect(offsetToPosition("ab\ncd\nef", 4)).toEqual({ line: 1, column: 1 });
        expect(offsetToPosition("ab\ncd\nef", 6)).toEqual({ line: 2, column: 0 });
    });
});
