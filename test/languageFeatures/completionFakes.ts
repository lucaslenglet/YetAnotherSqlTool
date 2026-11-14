/** A fake catalog for the completion tests: what a driver would return for a small database. */

import type { CompletionColumn, CompletionObject, DriverConnection } from "../../src/drivers/types";

export const MSSQL_OBJECTS: CompletionObject[] = [
    { kind: "database", name: "master" },
    { kind: "database", name: "shop" },
    { kind: "schema", name: "dbo" },
    { kind: "schema", name: "sales" },
    { kind: "schema", name: "sys" },
    { kind: "schema", name: "INFORMATION_SCHEMA" },
    { kind: "table", schema: "dbo", name: "customers" },
    { kind: "table", schema: "dbo", name: "orders" },
    { kind: "table", schema: "dbo", name: "select" },
    { kind: "view", schema: "dbo", name: "customer_orders" },
    { kind: "synonym", schema: "dbo", name: "clients" },
    { kind: "table", schema: "sales", name: "Order Lines" },
    {
        kind: "function",
        schema: "dbo",
        name: "order_total",
        detail: "(@customer_id int) RETURNS decimal(10,2)",
    },
    {
        kind: "function",
        schema: "sales",
        name: "top_lines",
        detail: "(@n int) RETURNS TABLE",
        returnsTable: true,
    },
    { kind: "procedure", schema: "dbo", name: "archive_orders", detail: "@before datetime2(7)" },
    { kind: "procedure", schema: "sys", name: "sp_help", system: true },
    { kind: "view", schema: "sys", name: "objects", system: true },
    { kind: "view", schema: "INFORMATION_SCHEMA", name: "TABLES", system: true },
    { kind: "type", schema: "dbo", name: "phone" },
    { kind: "sequence", schema: "dbo", name: "order_numbers" },
];

const column = (name: string, dataType: string, nullable = false): CompletionColumn => ({
    name,
    dataType,
    nullable,
});

export const COLUMNS: Record<string, CompletionColumn[]> = {
    "dbo.customers": [
        column("id", "int"),
        column("name", "nvarchar(100)", true),
        column("email", "nvarchar(255)"),
    ],
    "dbo.orders": [
        column("id", "int"),
        column("customer_id", "int"),
        column("amount", "decimal(10,2)"),
        column("status", "nvarchar(20)"),
    ],
    "sales.Order Lines": [column("line_id", "int"), column("Unit Price", "money", true)],
    "dbo.clients": [column("id", "int")],
};

export type FakeConnection = Pick<
    DriverConnection,
    "listCompletionObjects" | "listCompletionColumns" | "listDefaultSchemas"
> & {
    calls: {
        objects: number;
        columns: { schema: string; name: string }[][];
        defaultSchemas: number;
    };
};

export function fakeConnection(
    options: {
        objects?: CompletionObject[];
        columns?: Record<string, CompletionColumn[]>;
        defaultSchemas?: string[];
        /** Promise the object load waits for. */
        objectsGate?: Promise<void>;
        columnsGate?: Promise<void>;
    } = {},
): FakeConnection {
    const calls: FakeConnection["calls"] = { objects: 0, columns: [], defaultSchemas: 0 };
    const columns = options.columns ?? COLUMNS;
    return {
        calls,
        async listCompletionObjects() {
            calls.objects++;
            await options.objectsGate;
            return options.objects ?? MSSQL_OBJECTS;
        },
        async listDefaultSchemas() {
            calls.defaultSchemas++;
            return options.defaultSchemas ?? ["dbo"];
        },
        async listCompletionColumns(_database, relations) {
            calls.columns.push(relations);
            await options.columnsGate;
            return relations.map((r) => columns[`${r.schema}.${r.name}`] ?? []);
        },
    };
}
