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

beforeAll(async () => {
    pool = new sql.ConnectionPool(buildSqlConfig(dockerOptions()));
    await pool.connect();
});

afterAll(() => pool.close());

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
