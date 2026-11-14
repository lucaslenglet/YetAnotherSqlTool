import { describe, expect, it } from "vitest";
import { getPgStatementAt } from "../../src/drivers/pg/statements";
import { splitStatements } from "../../src/drivers/pg/splitter";
import { pgDriver } from "../../src/drivers/pg";
import { statementAt, withCursor } from "../sql/statementCases";

const at = (marked: string) => statementAt(getPgStatementAt, marked);
const lines = (...l: string[]) => l.join("\n");

/** [what, script with a "|" cursor, statement expected to run]. */
const cases: [string, string, string | undefined][] = [
    ["empty script", "|", undefined],
    ["blank script", " \n|  ", undefined],
    ["comment only", "-- |nothing", undefined],
    ["single statement without semicolon", "SELECT |1", "SELECT 1"],
    ["the semicolon belongs to the statement", "SELECT |1;", "SELECT 1;"],
    ["after the semicolon", "SELECT 1;|", "SELECT 1;"],
    ["second of three on separate lines", "SELECT 1;\nSELECT |2;\nSELECT 3;", "SELECT 2;"],
    ["third, without a final semicolon", "SELECT 1;\nSELECT 2;\nSELECT |3", "SELECT 3"],
    ["several on one line", "SELECT 1; SELECT |2; SELECT 3;", "SELECT 2;"],
    ["cursor between two statements of a line", "SELECT 1; | SELECT 2;", undefined],
    ["single statement on the cursor line, cursor after it", "SELECT 1;   |", "SELECT 1;"],
    ["blank line between statements", "SELECT 1;\n|\nSELECT 2;", undefined],
    [
        "multi-line statement",
        lines("SELECT a,", "  |b", "FROM t", "WHERE a = 1;", "SELECT 2;"),
        lines("SELECT a,", "  b", "FROM t", "WHERE a = 1;"),
    ],
    ["no semicolon: lines run together like psql", "SELECT 1\nSELECT |2", "SELECT 1\nSELECT 2"],
    ["CRLF line endings", "SELECT 1;\r\nSELECT |2;\r\nSELECT 3;\r\n", "SELECT 2;"],
    [
        "comments around are not part of it",
        lines("-- first", "SELECT |1; -- trailing", "SELECT 2;"),
        "SELECT 1;",
    ],
    ["semicolon in a string", "SELECT 'a;b' |AS x; SELECT 2;", "SELECT 'a;b' AS x;"],
    ["semicolon in an E string", "SELECT E'a\\';b' |AS x; SELECT 2;", "SELECT E'a\\';b' AS x;"],
    ["semicolon in a quoted identifier", 'SELECT 1 AS "a;b" |; SELECT 2;', 'SELECT 1 AS "a;b" ;'],
    ["semicolon in a comment", "SELECT 1 /* ; */ + |1; SELECT 2;", "SELECT 1 /* ; */ + 1;"],
    [
        "dollar-quoted function body",
        lines(
            "SELECT 0;",
            "CREATE FUNCTION f() RETURNS int AS $$",
            "BEGIN",
            "  RETURN |1;",
            "END;",
            "$$ LANGUAGE plpgsql;",
            "SELECT f();",
        ),
        lines(
            "CREATE FUNCTION f() RETURNS int AS $$",
            "BEGIN",
            "  RETURN 1;",
            "END;",
            "$$ LANGUAGE plpgsql;",
        ),
    ],
    [
        "tagged dollar quote containing $$",
        "DO $body$ BEGIN PERFORM $$;$$; |END $body$; SELECT 1;",
        "DO $body$ BEGIN PERFORM $$;$$; END $body$;",
    ],
    ["positional parameter is not a dollar quote", "SELECT $1, |$2; SELECT 3;", "SELECT $1, $2;"],
    ["stray semicolons", ";; SELECT |1;;", "SELECT 1;"],
    [
        "unterminated string runs to the end",
        "SELECT 1;\nSELECT 'a|b;\nSELECT 3;",
        "SELECT 'ab;\nSELECT 3;",
    ],
];

describe("pg getStatementAt", () => {
    it.each(cases)("%s", (_what, marked, expected) => {
        expect(at(marked)).toBe(expected);
    });

    it("is the driver's getStatementAt", () => {
        const { script, position } = withCursor("SELECT 1;\n  SELECT |2;");
        expect(pgDriver.getStatementAt(script, position)).toEqual({
            start: { line: 1, column: 2 },
            end: { line: 1, column: 11 },
        });
    });

    it("finds the same statements as the splitter that runs them", () => {
        const script = lines(
            "SELECT 'a;b', $$c;d$$, E'e\\';f';",
            "SELECT 2;;",
            "INSERT INTO t VALUES (1)",
        );
        const run = splitStatements(script).map((s) => s.text);
        const found: string[] = [];
        for (const statement of splitStatements(script)) {
            const marked =
                script.slice(0, statement.start + 1) + "|" + script.slice(statement.start + 1);
            found.push(at(marked)!.replace(/;$/, "").trim());
        }
        expect(found).toEqual(run);
    });
});
