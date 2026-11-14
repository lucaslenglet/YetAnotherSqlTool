import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueryRunner } from "../../src/queries/queryRunner";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import type { Driver, DriverConnection } from "../../src/drivers/types";
import { formatInClause, formatInsert } from "../../src/queryResult/export/sql";
import { formatJson } from "../../src/queryResult/export/json";
import type { ExportTable } from "../../src/queryResult/export/types";
import { connectToDocker } from "../drivers/mssql/helpers";
import { pgOptions } from "../support/databases";

// Round trip: the rows of a query are exported as INSERT, the script runs into a
// copy of the table, and reading the copy back gives the same display values.

async function run(
    driver: Driver,
    connection: DriverConnection,
    sql: string,
): Promise<QueryRunner> {
    const runner = new QueryRunner("file:///export.sql", "export.sql");
    const errors: string[] = [];
    runner.onMessage((m) => m.isError && errors.push(m.message));
    await runner.run(driver, connection, sql, { line: 0, column: 0 });
    expect(errors).toEqual([]);
    return runner;
}

/** All the cells of a result set, read from its store. */
async function exportTable(runner: QueryRunner, batchId: number): Promise<ExportTable | undefined> {
    const source = runner.getExportSource(batchId, 0);
    if (!source) return undefined;
    const rows: ExportTable["rows"] = [];
    for await (const chunk of source.chunks()) rows.push(...chunk);
    return { columns: source.columns, rows };
}

/** Rows of the last result set of the script. */
async function lastTable(runner: QueryRunner): Promise<ExportTable> {
    let table;
    for (let batchId = 0; batchId < 20; batchId++) {
        table = (await exportTable(runner, batchId)) ?? table;
    }
    return table!;
}

async function displayRows(runner: QueryRunner): Promise<string[][]> {
    return (await lastTable(runner)).rows.map((row) => row.map((c) => c!.displayValue));
}

describe("INSERT export on SQL Server", () => {
    let connection: DriverConnection;
    beforeAll(async () => {
        connection = await connectToDocker();
    });
    afterAll(async () => {
        await connection.close();
    });

    it("gives back the same values once executed", async () => {
        const create = `CREATE TABLE #src (
            [id] int, [big] bigint, [dec] decimal(38, 10), [flt] float, [money] money, [ok] bit,
            [txt] nvarchar(100), [Odd Name] varchar(20), [d] date, [dt] datetime2(7), [dto] datetimeoffset(3),
            [t] time(7), [bin] varbinary(10), [guid] uniqueidentifier, [x] xml, [nul] int
        );
        INSERT INTO #src VALUES
            (1, 9223372036854775807, 12345678901234567890.0123456789, 1.5e300, 922337203685477.5807, 1,
             N'l''été 日本 \\ x', 'a,b', '0001-01-01', '2024-03-15 10:30:00.1234567', '2024-03-15 10:30:00.123 +01:00',
             '23:59:59.9999999', 0x00FF, 'B0C6D2E1-0000-4000-8000-000000000001', '<r a="1"/>', NULL),
            (-2, 0, 0, -0.25, 0, 0, N'', '', '9999-12-31', '1900-01-01', '2000-01-01 00:00:00 -08:00',
             '00:00:00', 0x, '00000000-0000-0000-0000-000000000000', '<r/>', NULL);`;
        const source = await run(
            mssqlDriver,
            connection,
            `${create}\nSELECT * FROM #src ORDER BY id;`,
        );
        const insert = formatInsert(await lastTable(source), {
            dialect: "mssql",
            tableName: "#dst",
            includeHeaders: true,
            lineSeparator: "\n",
        });
        expect(insert).toContain("[Odd Name]");
        expect(insert).toContain("N'l''été 日本 \\ x'");

        const copy = await run(
            mssqlDriver,
            connection,
            `SELECT TOP 0 * INTO #dst FROM #src;\n${insert}\nSELECT * FROM #dst ORDER BY id;\nDROP TABLE #src, #dst;`,
        );
        expect(await displayRows(copy)).toEqual(await displayRows(source));
    });

    it("copies a column as an IN clause that SQL Server accepts", async () => {
        const source = await run(
            mssqlDriver,
            connection,
            "SELECT name FROM sys.types WHERE name LIKE 'n%' ORDER BY name",
        );
        const inClause = formatInClause((await exportTable(source, 0))!, {
            dialect: "mssql",
            lineSeparator: "\n",
        });
        const check = await run(
            mssqlDriver,
            connection,
            `SELECT COUNT(*) FROM sys.types WHERE name ${inClause}`,
        );
        expect((await displayRows(check))[0][0]).toBe(
            String((await exportTable(source, 0))!.rows.length),
        );
    });
});

describe("INSERT export on PostgreSQL", () => {
    let connection: DriverConnection;
    beforeAll(async () => {
        connection = await pgDriver.connect({ options: pgOptions() });
    });
    afterAll(async () => {
        await connection.close();
    });

    it("gives back the same values once executed", async () => {
        const create = `CREATE TEMP TABLE src (
            id int, big bigint, num numeric, flt double precision, ok boolean, txt text, "Odd Name" varchar(20),
            d date, ts timestamp, tstz timestamptz, t time, iv interval, bin bytea, u uuid, j jsonb, arr int[],
            nan double precision, nul int
        );
        INSERT INTO src VALUES
            (1, 9223372036854775807, 12345678901234567890.0123456789, 1.5e300, true, E'l''été 日本 \\\\ x', 'a,b',
             '2024-03-15', '2024-03-15 10:30:00.123456', '2024-03-15 10:30:00+01', '23:59:59', '1 day 02:00',
             '\\x00ff', 'b0c6d2e1-0000-4000-8000-000000000001', '{"a": [1, "x"]}', '{1,2}', 'NaN', NULL),
            (-2, 0, 0, -0.25, false, '', '', '0001-01-01 BC', '1900-01-01', 'infinity', '00:00', '-3 mons', '\\x', NULL,
             'null', '{}', 'Infinity', NULL);`;
        const source = await run(pgDriver, connection, `${create}\nSELECT * FROM src ORDER BY id;`);
        const sourceRows = await displayRows(source);
        const insert = formatInsert(await lastTable(source), {
            dialect: "pg",
            tableName: "dst",
            includeHeaders: true,
            lineSeparator: "\n",
        });
        expect(insert).toContain('"Odd Name"');

        const copy = await run(
            pgDriver,
            connection,
            `CREATE TEMP TABLE dst (LIKE src);\n${insert}\nSELECT * FROM dst ORDER BY id;\nDROP TABLE src, dst;`,
        );
        expect(await displayRows(copy)).toEqual(sourceRows);
    });

    it("writes numbers, booleans and NULL as JSON values", async () => {
        const source = await run(
            pgDriver,
            connection,
            "SELECT 1 AS n, 2.50::numeric AS d, true AS b, NULL::int AS z, 'x' AS s",
        );
        expect(
            JSON.parse(formatJson((await exportTable(source, 0))!, { lineSeparator: "\n" })),
        ).toEqual([{ n: 1, d: 2.5, b: true, z: null, s: "x" }]);
    });
});
