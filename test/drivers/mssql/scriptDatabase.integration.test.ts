import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import type { DriverConnection, ScriptDatabaseOptions } from "../../../src/drivers/types";
import { connectToDocker, runScript } from "./helpers";
import { fixtureTablesSql, objectsSql } from "./scriptReference";

// "Generate Scripts..." on a real SQL Server: the script of a database rich in object kinds and
// data types, run in a new empty database, must give a copy that scripts the same and holds the
// same rows.

const suffix = randomBytes(4).toString("hex");
const SOURCE = `yast_oe_sdb_src_${suffix}`;
const COPY = `yast_oe_sdb_copy_${suffix}`;
const BIG = `yast_oe_sdb_big_${suffix}`;
const BIG_ROWS = 100000;

const DATA = `
INSERT INTO [probe].[all_types] (c_bigint, c_int, c_smallint, c_tinyint, c_bit, c_decimal, c_numeric,
    c_money, c_smallmoney, c_float, c_float24, c_real, c_date, c_time, c_datetime, c_datetime2, c_dto,
    c_smalldatetime, c_char, c_varchar, c_varcharmax, c_nchar, c_nvarchar, c_nvarcharmax, c_text,
    c_ntext, c_binary, c_varbinary, c_varbinarymax, c_image, c_guid, c_xml, c_variant, c_hierarchy,
    c_geometry, c_geography, c_collated, c_phone, c_amount, c_sparse)
VALUES
    (-9223372036854775808, 2147483647, -32768, 255, 1, 12345678901234.5678, 99999,
     -922337203685477.5808, 214748.3647, 1.7976931348623157E+308, 3.14159, -1.25E-10,
     '0001-01-01', '23:59:59.999', '9999-12-31T23:59:59.997', '9999-12-31 23:59:59.999',
     '2024-06-30 12:34:56.1234567 -05:30', '2079-06-06T23:59:00', 'abc', 'it''s',
     REPLICATE(CAST('x' AS varchar(max)), 9000), N'é', N'漢字😀', N'line1' + NCHAR(13) + NCHAR(10) + N'line2',
     'text', N'ntext é', 0x00FF, 0x, 0xDEADBEEF, 0x01, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     N'<r a="1"><b/></r>', CAST(42 AS int), hierarchyid::Parse('/1/2/'),
     geometry::STGeomFromText('POINT(1 2)', 0), geography::Point(47.6, -122.3, 4326), 'éàç',
     '555-1234', 12.345, 7),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '2024-02-29', '00:00', '1753-01-01T00:00:00', '2024-01-01',
     '2024-01-01 00:00:00 +14:00', '1900-01-01T00:00:00', '', '', '', N' ', N'', N'', '', N'',
     0x, 0x, 0x, 0x, '00000000-0000-0000-0000-000000000000', N'', NULL,
     hierarchyid::GetRoot(), NULL, NULL, '', '', 0, NULL);
-- One statement each: the rows of a multi-row VALUES must have compatible types.
INSERT INTO [probe].[all_types] (c_variant) VALUES (CAST('2024-01-02T03:04:05.123' AS datetime2(3)));
INSERT INTO [probe].[all_types] (c_variant) VALUES (CAST(1.5 AS decimal(5, 2)));
INSERT INTO [probe].[all_types] (c_variant) VALUES (CAST(N'héllo' AS nvarchar(20)));
INSERT INTO [probe].[all_types] (c_variant) VALUES (CAST(0x0102 AS varbinary(10)));
INSERT INTO [probe].[all_types] (c_variant) VALUES (CAST(0.1 AS float));
INSERT INTO [probe].[parent] (code, qty, price) VALUES ('AAA', 2, 1.5), ('BBB', 0, NULL);
INSERT INTO [probe].[child] (child_id, parent_id, parent_code, note, status)
    VALUES (1, 100, 'AAA', N'n1', 1), (2, NULL, NULL, NULL, 2);
INSERT INTO [probe].[temporal] (id, v) VALUES (1, 10), (2, 20);
UPDATE [probe].[temporal] SET v = 11 WHERE id = 1;
INSERT INTO [probe].[idx_more] (id, a, b, pcode) VALUES (1, 'x', 13, NULL), (2, 'y', 5, 'BBB');
INSERT INTO [probe].[special] (id, area, note) VALUES (1, geography::Point(1, 2, 4326), N'n');
INSERT INTO [probe].[odd ]] table] VALUES (1, 2, N'x'), (1, 2, N'x');
`;

const dropDatabase = (name: string) => `
IF DB_ID('${name}') IS NOT NULL BEGIN
    ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE [${name}];
END`;

describe("scriptDatabase (SQL Server)", () => {
    let connection: DriverConnection;

    async function run(text: string) {
        const events = await runScript(connection, text);
        const errors = events.filter((e) => e.type === "message" && e.isError);
        expect(errors).toEqual([]);
    }

    /** The script of a database, and the texts given to `write`. */
    async function scriptOf(database: string, options: ScriptDatabaseOptions) {
        const chunks: string[] = [];
        await connection.scriptDatabase(
            database,
            options,
            (text) => {
                chunks.push(text);
            },
            new AbortController().signal,
        );
        return { script: chunks.join(""), chunks };
    }

    /** Displayed rows of every user table, sorted, without the columns the server fills itself. */
    async function contents(database: string): Promise<Record<string, string[]>> {
        const tables = await rows(
            `SELECT s.name + '.' + t.name AS name,
                STUFF((SELECT ', ' + QUOTENAME(c.name) FROM [${database}].sys.columns c
                       WHERE c.object_id = t.object_id AND c.generated_always_type = 0
                         AND TYPE_NAME(c.system_type_id) <> 'timestamp'
                       ORDER BY c.column_id FOR XML PATH('')), 1, 2, '') AS columns,
                QUOTENAME(s.name) + '.' + QUOTENAME(t.name) AS target
             FROM [${database}].sys.tables t JOIN [${database}].sys.schemas s ON s.schema_id = t.schema_id
             ORDER BY 1`,
        );
        const result: Record<string, string[]> = {};
        for (const [name, columns, target] of tables) {
            const data = await rows(`SELECT ${columns} FROM [${database}].${target}`);
            result[name] = data.map((r) => JSON.stringify(r)).sort();
        }
        return result;
    }

    async function rows(text: string): Promise<string[][]> {
        const events = await runScript(connection, text);
        expect(events.filter((e) => e.type === "message" && e.isError)).toEqual([]);
        return events.flatMap((e) =>
            e.type === "rows"
                ? e.rows.map((r) => r.map((c) => (c.isNull ? "<null>" : c.displayValue)))
                : [],
        );
    }

    beforeAll(async () => {
        connection = await connectToDocker();
        await run(`
BEGIN TRY CREATE LOGIN [yast_oe_probe_login] WITH PASSWORD = N'Pr0be-Login-Pass!', CHECK_POLICY = OFF END TRY
BEGIN CATCH END CATCH
GO
CREATE DATABASE [${SOURCE}]
GO
USE [${SOURCE}]
GO
${fixtureTablesSql}
GO
${objectsSql}
GO
${DATA}
GO
USE master
GO
CREATE DATABASE [${BIG}]
GO
CREATE TABLE [${BIG}].dbo.big (id int NOT NULL PRIMARY KEY, label nvarchar(40) NOT NULL)
GO
INSERT INTO [${BIG}].dbo.big (id, label)
SELECT TOP (${BIG_ROWS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)), N'row number ' + CONVERT(nvarchar(10), ROW_NUMBER() OVER (ORDER BY (SELECT NULL)))
FROM sys.all_columns a CROSS JOIN sys.all_columns b`);
    }, 120000);

    afterAll(async () => {
        await runScript(
            connection,
            `USE master\nGO\n${dropDatabase(SOURCE)}\n${dropDatabase(COPY)}\n${dropDatabase(BIG)}`,
        );
        await connection.close();
    });

    it("recreates the database in a new one: same script, same rows", async () => {
        const { script } = await scriptOf(SOURCE, { schema: true, data: true });
        expect(script).not.toMatch(/CREATE DATABASE|^USE /m);
        expect(script).toContain("SET IDENTITY_INSERT [probe].[parent] ON");
        expect(script).toContain("CAST(N'héllo' AS nvarchar(20))");

        await run(`CREATE DATABASE [${COPY}]\nGO\nUSE [${COPY}]`);
        const events = await runScript(connection, script);
        const errors = events.filter((e) => e.type === "message" && e.isError);
        expect(errors).toEqual([]);
        await run("USE master");

        const copy = await scriptOf(COPY, { schema: true, data: true });
        expect(copy.script).toBe(script);
        const [source, target] = [await contents(SOURCE), await contents(COPY)];
        expect(Object.keys(target)).toEqual(Object.keys(source));
        expect(target).toEqual(source);
        expect(source["probe.all_types"]).toHaveLength(7);
        expect(source["probe.temporal_history"]).toHaveLength(1);
    }, 120000);

    it("scripts the schema alone, or the data alone", async () => {
        const schema = (await scriptOf(SOURCE, { schema: true, data: false })).script;
        const data = (await scriptOf(SOURCE, { schema: false, data: true })).script;
        expect(schema).toContain("CREATE TABLE [probe].[parent]");
        expect(schema).not.toMatch(/^INSERT /m);
        expect(data).not.toContain("CREATE ");
        expect(data).toContain(
            "INSERT [dbo].[customers] ([id], [name], [email], [created_at]) VALUES (1, N'Alice'",
        );
    });

    it("streams the rows of a large table instead of holding them", async () => {
        const { script, chunks } = await scriptOf(BIG, { schema: false, data: true });
        expect(script.match(/^INSERT /gm)).toHaveLength(BIG_ROWS);
        expect(script.match(/^GO$/gm)!.length).toBeGreaterThanOrEqual(BIG_ROWS / 1000);
        expect(chunks.length).toBeGreaterThan(100);
        expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(100000);
    }, 120000);

    it("stops when canceled, and leaves the session's database as it was", async () => {
        await run("USE master");
        const controller = new AbortController();
        let written = 0;
        const done = connection.scriptDatabase(
            BIG,
            { schema: true, data: true },
            async (text) => {
                written += text.length;
                if (text.includes("INSERT ")) controller.abort();
            },
            controller.signal,
        );
        await expect(done).rejects.toThrow(/canceled/);
        expect(written).toBeLessThan(1000000);
        expect(await connection.getCurrentDatabase()).toBe("master");
        // The session still works.
        const events = await runScript(connection, "SELECT 1");
        expect(events.some((e) => e.type === "rows")).toBe(true);
    }, 120000);

    it("splits into batches the driver runs", () => {
        const batches = mssqlDriver.splitBatches("INSERT a\nGO\nINSERT b\nGO\n");
        expect(batches).toHaveLength(2);
    });
});
