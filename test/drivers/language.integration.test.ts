// The vocabulary of each driver (SqlLanguage, used by highlighting and autocompletion) against
// the real servers: keywords, data types and built-in functions must exist there.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import { pgGrammarFunctions } from "../../src/drivers/pg/language";
import type { DriverConnection, ExecuteEvent } from "../../src/drivers/types";
import { pgOptions } from "../support/databases";
import { connectToDocker } from "./mssql/helpers";

/** Rows of the last result set of a batch, as display strings; fails on an error message. */
async function rows(connection: DriverConnection, sql: string): Promise<string[][]> {
    const events: ExecuteEvent[] = [];
    await connection.execute(
        { text: sql, startLine: 0 },
        (e) => events.push(e),
        new AbortController().signal,
    );
    const error = events.find((e) => e.type === "message" && e.isError);
    if (error && error.type === "message") throw new Error(error.text);
    let result: string[][] = [];
    for (const event of events) {
        if (event.type === "resultSetStart") result = [];
        if (event.type === "rows")
            result.push(...event.rows.map((row) => row.map((c) => c.displayValue)));
    }
    return result;
}

const literal = (words: Iterable<string>) => `'${[...words].join("|").replace(/'/g, "''")}'`;

describe("PostgreSQL vocabulary", () => {
    let connection: DriverConnection;
    const language = pgDriver.language;
    beforeAll(async () => {
        connection = await pgDriver.connect({ options: pgOptions() });
    });
    afterAll(async () => {
        await connection.close();
    });

    it("has every keyword of pg_get_keywords(), reserved ones flagged", async () => {
        const keywords = await rows(
            connection,
            "select upper(word), catcode from pg_get_keywords()",
        );
        expect(keywords.length).toBeGreaterThan(400);
        for (const [word, category] of keywords) {
            expect(language.keywords.has(word), word).toBe(true);
            expect(language.reservedKeywords.has(word), `${word} (${category})`).toBe(
                "RT".includes(category),
            );
        }
        const known = new Set(keywords.map(([word]) => word));
        expect([...language.keywords].filter((word) => !known.has(word))).toEqual([]);
    });

    it("knows the types of pg_type, and each of its types exists", async () => {
        const types = await rows(
            connection,
            `select upper(typname) from pg_type
             where typnamespace = 'pg_catalog'::regnamespace and typtype in ('b', 'r', 'm', 'p')
               and typcategory not in ('A', 'Z') and typname not like '\\_%' and typname <> 'any'`,
        );
        expect(types.length).toBeGreaterThan(50);
        for (const [type] of types) expect(language.dataTypes.has(type), type).toBe(true);

        // SERIAL and friends are shorthands of CREATE TABLE, not types.
        const serials = /^(SMALL|BIG)?SERIAL\d?$/;
        const listed = [...language.dataTypes].filter((type) => !serials.test(type));
        const unknown = await rows(
            connection,
            `select t from unnest(string_to_array(${literal(listed)}, '|')) t where to_regtype(t) is null`,
        );
        expect(unknown).toEqual([]);
    });

    it("lists functions that exist in pg_proc, or keywords parsed as functions", async () => {
        const grammar = new Set(pgGrammarFunctions);
        const missing = await rows(
            connection,
            `select f from unnest(string_to_array(${literal(
                [...language.functions].filter((f) => !grammar.has(f)),
            )}, '|')) f
             where not exists (select 1 from pg_proc where proname = lower(f))`,
        );
        expect(missing).toEqual([]);
        for (const name of grammar) expect(language.keywords.has(name), name).toBe(true);
        expect(language.functions.size).toBeGreaterThan(500);
    });
});

describe("SQL Server vocabulary", () => {
    let connection: DriverConnection;
    const language = mssqlDriver.language;
    beforeAll(async () => {
        connection = await connectToDocker();
    });
    afterAll(async () => {
        await connection.close();
    });

    /** Runs `statement` (where @w is each word) in its own batch; returns the words that failed, with the error. */
    async function failing(words: Iterable<string>, statement: string): Promise<string[][]> {
        return rows(
            connection,
            `SET NOCOUNT ON
            DECLARE @failed TABLE (word sysname, number int, message nvarchar(4000))
            DECLARE @w sysname
            DECLARE words CURSOR LOCAL FAST_FORWARD FOR
                SELECT value FROM STRING_SPLIT(N${literal(words)}, N'|')
            OPEN words
            FETCH NEXT FROM words INTO @w
            WHILE @@FETCH_STATUS = 0
            BEGIN
                BEGIN TRY
                    DECLARE @sql nvarchar(max) = N'SET NOEXEC ON; ' + ${statement}
                    EXEC (@sql)
                END TRY
                BEGIN CATCH
                    INSERT @failed VALUES (@w, ERROR_NUMBER(), ERROR_MESSAGE())
                END CATCH
                FETCH NEXT FROM words INTO @w
            END
            SELECT word, CAST(number AS nvarchar(10)), message FROM @failed ORDER BY word`,
        );
    }

    it("knows the types of sys.types, and each of its types can be declared", async () => {
        const types = await rows(
            connection,
            "SELECT UPPER(name) FROM sys.types WHERE is_user_defined = 0",
        );
        for (const [type] of types) expect(language.dataTypes.has(type), type).toBe(true);
        // Newer than the SQL Server of the tests (2025, Azure SQL).
        const newer = new Set(["JSON", "VECTOR"]);
        const listed = [...language.dataTypes].filter((type) => !newer.has(type));
        // A table column rather than a variable: TEXT, NTEXT and IMAGE cannot be variables.
        expect(await failing(listed, "N'DECLARE @t TABLE (c ' + @w + N')'")).toEqual([]);
    });

    it("lists functions that SQL Server knows", async () => {
        // Newer than the SQL Server of the tests (2025, Azure SQL).
        const newer = new Set(["VECTOR_DISTANCE", "VECTOR_NORM", "VECTOR_NORMALIZE"]);
        const listed = [...language.functions].filter((name) => !newer.has(name));
        const errors = await failing(
            listed,
            "N'SELECT ' + @w + CASE WHEN LEFT(@w, 2) = N'@@' THEN N'' ELSE N'()' END",
        );
        // 195: "'x' is not a recognized built-in function name"; 137: undeclared @@variable.
        const unknown = errors.filter(([, number]) => number === "195" || number === "137");
        // Rowset functions are only known in FROM: OPENJSON, STRING_SPLIT...
        const rowsets = await failing(
            unknown.map(([name]) => name),
            "N'SELECT * FROM ' + @w + N'()'",
        );
        expect(rowsets.filter(([, number]) => number === "195")).toEqual([]);
    });

    it("cannot use its reserved keywords as names, and can use the other keywords", async () => {
        // Reserved by the documentation, but still accepted as a table name by SQL Server 2022.
        const accepted = new Set(["DISK", "DUMP", "LOAD", "PRECISION", "SECURITYAUDIT", "WITHIN"]);
        const errors = await failing(language.keywords, "N'CREATE TABLE ' + @w + N' (c int)'");
        const rejected = new Set(errors.map(([word]) => word));
        for (const word of language.reservedKeywords) {
            expect(rejected.has(word), word).toBe(!accepted.has(word));
        }
        expect([...rejected].filter((word) => !language.reservedKeywords.has(word))).toEqual([]);
    });
});
