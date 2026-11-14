import { describe, expect, it } from "vitest";
import {
    dataQuery,
    dependencyOrder,
    insertableColumns,
    tableAfterData,
    tableBeforeData,
} from "../../../src/drivers/mssql/scriptDatabase";
import type {
    ColumnRow,
    IndexRow,
    ModuleRow,
    TableModel,
} from "../../../src/drivers/mssql/scriptText";

// Parts of the SQL Server database script, without a database
// (test/drivers/mssql/scriptDatabase.integration.test.ts runs the whole script).

const column = (name: string, extra: Partial<ColumnRow> = {}): ColumnRow => ({
    objectId: 1,
    columnId: 1,
    name,
    typeName: "int",
    typeSchema: "sys",
    isUserDefined: false,
    maxLength: 4,
    precision: 10,
    scale: 0,
    isNullable: false,
    isIdentity: false,
    seedValue: null,
    incrementValue: null,
    notForReplication: false,
    computedDefinition: null,
    isPersisted: false,
    isSparse: false,
    isRowGuidCol: false,
    generatedAlwaysType: 0,
    isHidden: false,
    defaultName: null,
    defaultDefinition: null,
    defaultSystemNamed: false,
    ...extra,
});

const index = (name: string, extra: Partial<IndexRow> = {}): IndexRow => ({
    objectId: 1,
    indexId: 1,
    name,
    type: 2,
    isUnique: false,
    isPrimaryKey: false,
    isUniqueConstraint: false,
    isSystemNamed: false,
    ignoreDupKey: false,
    fillFactor: 0,
    isPadded: false,
    allowRowLocks: true,
    allowPageLocks: true,
    filterDefinition: null,
    noRecompute: false,
    optimizeForSequentialKey: false,
    dataSpace: "PRIMARY",
    dataSpaceType: "FG",
    partitionColumn: null,
    columns: [
        {
            keyOrdinal: 1,
            isDescending: false,
            isIncluded: false,
            columnName: "id",
            typeName: "int",
        },
    ],
    ...extra,
});

const model: TableModel = {
    table: {
        objectId: 1,
        schemaName: "s",
        name: "t",
        usesAnsiNulls: true,
        temporalType: 2,
        historySchema: "s",
        historyName: "t_history",
        periodStart: "from",
        periodEnd: "to",
        dataSpace: "PRIMARY",
        dataSpaceType: "FG",
        partitionColumn: null,
        lobDataSpace: null,
    },
    columns: [
        column("id", { isIdentity: true, seedValue: "1", incrementValue: "1" }),
        column("v", { typeName: "sql_variant", isNullable: true }),
        column("twice", { computedDefinition: "([id]*(2))" }),
        column("version", { typeName: "timestamp" }),
        column("from", { typeName: "datetime2", generatedAlwaysType: 1, isHidden: true }),
        column("to", { typeName: "datetime2", generatedAlwaysType: 2, isHidden: true }),
        column("area", { typeName: "geography", isNullable: true }),
    ],
    indexes: [
        index("PK_t", {
            isPrimaryKey: true,
            isUnique: true,
            type: 1,
            columns: [
                {
                    keyOrdinal: 1,
                    isDescending: true,
                    isIncluded: false,
                    columnName: "id",
                    typeName: "int",
                },
            ],
        }),
        index("IX_t", { indexId: 2 }),
    ],
    foreignKeys: [],
    checks: [],
    triggers: [],
};

describe("SQL Server database script", () => {
    it("inserts only the columns an INSERT can set", () => {
        expect(insertableColumns(model).map((c) => c.name)).toEqual(["id", "v", "area"]);
    });

    it("reads the rows in key order, with literals for sql_variant and spatial values", () => {
        const query = dataQuery(model);
        expect(query).toMatch(
            /^SELECT \[id\], CASE WHEN \[v\] IS NULL THEN NULL ELSE 'CAST\(' \+ /,
        );
        expect(query).toContain(
            "CONVERT(varbinary(max), [area]) AS [area] FROM [s].[t] ORDER BY [id] DESC",
        );
    });

    it("creates a temporal table without versioning, and turns it on after the data", () => {
        const before = tableBeforeData(model);
        expect(before).toContain("PERIOD FOR SYSTEM_TIME ([from], [to])");
        expect(before).not.toContain("SYSTEM_VERSIONING");
        expect(before).toContain("ADD  CONSTRAINT [PK_t] PRIMARY KEY CLUSTERED");
        expect(before).not.toContain("[IX_t]");
        const after = tableAfterData(model);
        expect(after).toContain("CREATE NONCLUSTERED INDEX [IX_t]");
        expect(
            after.endsWith(
                "ALTER TABLE [s].[t] SET (SYSTEM_VERSIONING = ON (HISTORY_TABLE = [s].[t_history]))\nGO\n",
            ),
        ).toBe(true);
    });

    it("orders tables and modules by their dependencies, then tables, functions, views, procedures", () => {
        const table = (objectId: number, name: string) =>
            ({ ...model, table: { ...model.table, objectId, name } }) as TableModel;
        const module = (objectId: number, name: string, type: string) =>
            ({ objectId, schemaName: "s", name, type }) as ModuleRow;
        const order = dependencyOrder(
            [table(1, "b"), table(2, "a")],
            [module(3, "p", "P"), module(4, "v", "V"), module(5, "f", "FN")],
            [
                { from: 1, to: 5 }, // a computed column of b calls f
                { from: 4, to: 1 },
                { from: 4, to: 99 }, // not a user object
            ],
        );
        expect(order.map((i) => ("table" in i ? i.table.name : i.name))).toEqual([
            "a",
            "f",
            "b",
            "v",
            "p",
        ]);
    });
});
