import * as sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    listCompletionColumns,
    listCompletionObjects,
    listDefaultSchemas,
    type DatabaseQueryRunner,
} from "../../../src/drivers/mssql/completion";
import { databaseBatch } from "../../../src/drivers/mssql/connection";
import { buildSqlConfig } from "../../../src/drivers/mssql/connectionConfig";
import type { Row } from "../../../src/drivers/mssql/objectExplorer";
import { dockerOptions } from "./helpers";

// Cloud engines read autocompletion metadata on a connection logged in to the database itself,
// and then send the catalog queries as they are instead of through `EXEC [db].sys.sp_executesql`.
// Both forms must return the same thing: this compares them on SQL Server, on a connection logged
// in to the test database.

const DATABASE = String(dockerOptions().database);
let pool: sql.ConnectionPool;

// Names that need care in a literal or an identifier: ], ' and a dot.
const ODD_TABLE = "yast_oi_cols ]] it's.odd";
const ODD_VIEW = "yast_oi_cols_view";
const SYNONYM = "yast_oi_cols_synonym";

beforeAll(async () => {
    pool = new sql.ConnectionPool(buildSqlConfig(dockerOptions()));
    await pool.connect();
    await pool.request().batch(`
        DROP SYNONYM IF EXISTS dbo.${SYNONYM};
        DROP VIEW IF EXISTS dbo.${ODD_VIEW};
        DROP TABLE IF EXISTS dbo.[${ODD_TABLE}];
        CREATE TABLE dbo.[${ODD_TABLE}] (z int NOT NULL, a nvarchar(20) NULL, m decimal(10,2) NULL);`);
    await pool
        .request()
        .batch(`CREATE VIEW dbo.${ODD_VIEW} AS SELECT a, z FROM dbo.[${ODD_TABLE}]`);
    await pool.request().batch(`CREATE SYNONYM dbo.${SYNONYM} FOR dbo.[${ODD_TABLE}]`);
});

afterAll(async () => {
    await pool.request().batch(`
        DROP SYNONYM IF EXISTS dbo.${SYNONYM};
        DROP VIEW IF EXISTS dbo.${ODD_VIEW};
        DROP TABLE IF EXISTS dbo.[${ODD_TABLE}];`);
    await pool.close();
});

/** Runs like MssqlConnection.runInDatabase, the pool being logged in to `connectedDatabase`. */
function runner(connectedDatabase: string): DatabaseQueryRunner {
    return async (database, text) => {
        const batch = databaseBatch(database, connectedDatabase, text);
        const request = pool.request();
        if (batch.statement !== undefined)
            request.input("yast_statement", sql.NVarChar(sql.MAX), batch.statement);
        const result = await request.query(batch.text);
        return result.recordsets as unknown as Row[][];
    };
}

describe("catalog reads of autocompletion", () => {
    const signal = () => new AbortController().signal;
    const direct = runner(DATABASE);
    const wrapped = runner("");

    it("return the same objects with or without sp_executesql of the database", async () => {
        const objects = await listCompletionObjects(direct, DATABASE, signal());
        expect(objects.length).toBeGreaterThan(0);
        expect(objects).toEqual(await listCompletionObjects(wrapped, DATABASE, signal()));
    });

    it("return the same columns and default schemas with or without sp_executesql of the database", async () => {
        const relations = [{ schema: "dbo", name: "customers" }];
        const columns = await listCompletionColumns(direct, DATABASE, relations, signal());
        expect(columns[0].length).toBeGreaterThan(0);
        expect(columns).toEqual(
            await listCompletionColumns(wrapped, DATABASE, relations, signal()),
        );
        expect(await listDefaultSchemas(direct, DATABASE, signal())).toEqual(
            await listDefaultSchemas(wrapped, DATABASE, signal()),
        );
    });
});

// A dedicated SQL pool gets a query without a table value constructor, APPLY or synonyms (see
// completion.ts). Run on SQL Server, it must answer like the general query, whatever it is asked.
describe("column query of a dedicated SQL pool", () => {
    const signal = () => new AbortController().signal;
    const direct = runner(DATABASE);
    const oddName = ODD_TABLE.replace("]]", "]");

    it("answers like the general query: order, unknown relations, repeated relations, odd names", async () => {
        const relations = [
            { schema: "dbo", name: oddName },
            { schema: "dbo", name: "no_such_relation" },
            { schema: "dbo", name: "customers" },
            { schema: "dbo", name: ODD_VIEW },
            { schema: "dbo", name: oddName },
            { schema: "no_such_schema", name: "customers" },
            { schema: "sys", name: "schemas" },
        ];
        const general = await listCompletionColumns(direct, DATABASE, relations, signal());
        const pool = await listCompletionColumns(direct, DATABASE, relations, signal(), true);

        expect(pool).toEqual(general);
        expect(pool[0]).toEqual([
            { name: "z", dataType: "int", nullable: false },
            { name: "a", dataType: "nvarchar(20)", nullable: true },
            { name: "m", dataType: "decimal(10,2)", nullable: true },
        ]);
        expect(pool[1]).toEqual([]);
        expect(pool[2].length).toBeGreaterThan(0);
        expect(pool[3].map((c) => c.name)).toEqual(["a", "z"]);
        expect(pool[4]).toEqual(pool[0]);
        expect(pool[5]).toEqual([]);
        expect(pool[6].map((c) => c.name)).toContain("schema_id");
    });

    it("does not follow synonyms, which a pool does not have; the general query does", async () => {
        const relations = [{ schema: "dbo", name: SYNONYM }];
        const general = await listCompletionColumns(direct, DATABASE, relations, signal());
        const pool = await listCompletionColumns(direct, DATABASE, relations, signal(), true);

        expect(general[0].map((c) => c.name)).toEqual(["z", "a", "m"]);
        expect(pool).toEqual([[]]);
    });
});
