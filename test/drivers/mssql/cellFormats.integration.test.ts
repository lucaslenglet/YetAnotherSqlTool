import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CellValue, DriverConnection } from "../../../src/drivers/types";
import { connectToDocker, runBatch } from "./helpers";

// Captured from Microsoft's sqltoolsservice by tools/sts-query-probe.js.
const reference = JSON.parse(
    readFileSync(resolve(__dirname, "../../../docs/reference/mssql-cell-formats.json"), "utf8"),
) as {
    columns: { columnName: string; dataTypeName: string }[];
    queries: Record<string, string>;
    sets: Record<string, CellValue[]>;
};

describe("cell formatting matches sqltoolsservice", () => {
    let connection: DriverConnection;
    beforeAll(async () => {
        connection = await connectToDocker();
    });
    afterAll(() => connection.close());

    for (const [setName, query] of Object.entries(reference.queries)) {
        it(`displayValue of the "${setName}" row`, async () => {
            const events = await runBatch(connection, query);
            const rows = events.flatMap((event) => (event.type === "rows" ? event.rows : []));
            expect(rows).toHaveLength(1);

            const actual = rows[0];
            const expected = reference.sets[setName];
            expect(actual).toHaveLength(expected.length);
            reference.columns.forEach((column, index) => {
                expect({ column: column.columnName, ...actual[index] }, column.columnName).toEqual({
                    column: column.columnName,
                    displayValue: expected[index].displayValue,
                    isNull: expected[index].isNull,
                });
            });
        });
    }

    it("reports the same type names as sqltoolsservice", async () => {
        const events = await runBatch(connection, reference.queries.typical);
        const start = events.find((event) => event.type === "resultSetStart");
        if (start?.type !== "resultSetStart") throw new Error("no result set");
        const actualNames = start.columns.map((c) => [c.columnName, c.dataTypeName]);
        const expectedNames = reference.columns.map((c) => [
            c.columnName,
            c.dataTypeName === "yast.sys.hierarchyid" ? "hierarchyid" : c.dataTypeName,
        ]);
        expect(actualNames).toEqual(expectedNames);
    });
});
