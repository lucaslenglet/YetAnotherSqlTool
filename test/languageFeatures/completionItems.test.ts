import { describe, expect, it } from "vitest";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import type { Driver } from "../../src/drivers/types";
import {
    computeCompletions,
    type CompletionOptions,
    type CompletionResult,
    type Suggestion,
} from "../../src/languageFeatures/completion/completionItems";
import { CompletionMetadata } from "../../src/languageFeatures/completion/completionMetadata";
import { fakeConnection, type FakeConnection } from "./completionFakes";

const OPTIONS: CompletionOptions = { lowerCaseSuggestions: false, budgetMs: 200, maxItems: 3000 };

async function complete(
    marked: string,
    {
        driver = mssqlDriver as Driver,
        connection = fakeConnection(),
        options = OPTIONS,
        database = "shop",
    }: {
        driver?: Driver;
        connection?: FakeConnection;
        options?: CompletionOptions;
        database?: string;
    } = {},
): Promise<CompletionResult> {
    const offset = marked.indexOf("|");
    const metadata = new CompletionMetadata(connection, database);
    return computeCompletions(
        marked.slice(0, offset) + marked.slice(offset + 1),
        offset,
        driver,
        metadata,
        options,
    );
}

/** Items in the order VS Code shows them before any filtering. */
const sorted = (result: CompletionResult) =>
    [...result.items].sort((a, b) =>
        a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0,
    );
const labels = (result: CompletionResult, kind?: Suggestion["kind"]) =>
    sorted(result)
        .filter((i) => !kind || i.kind === kind)
        .map((i) => i.label);
const item = (result: CompletionResult, label: string) =>
    result.items.find((i) => i.label === label);

describe("completion items", () => {
    it("offers relations after FROM: default schema plain, other schemas qualified, no system objects", async () => {
        const result = await complete("SELECT * FROM |");
        const names = labels(result).filter(
            (l) => !["dbo", "sales", "sys", "INFORMATION_SCHEMA", "master", "shop"].includes(l),
        );
        expect(names).toEqual([
            "clients",
            "customer_orders",
            "customers",
            "orders",
            "select",
            "sales.Order Lines",
            "sales.top_lines",
        ]);
        expect(item(result, "customers")).toMatchObject({
            kind: "table",
            insertText: "customers",
            detail: "table dbo.customers",
        });
        expect(item(result, "select")?.insertText).toBe("[select]");
        expect(item(result, "sales.Order Lines")?.insertText).toBe("sales.[Order Lines]");
        expect(item(result, "sales.top_lines")).toMatchObject({
            insertText: "sales.top_lines($0)",
            snippet: true,
        });
        expect(labels(result, "schema")).toEqual(["dbo", "INFORMATION_SCHEMA", "sales", "sys"]);
        expect(labels(result, "database")).toEqual(["master", "shop"]);
        // Relations before schemas before databases.
        expect(labels(result).indexOf("sales.top_lines")).toBeLessThan(
            labels(result).indexOf("dbo"),
        );
        expect(labels(result).indexOf("sys")).toBeLessThan(labels(result).indexOf("master"));
        expect(result.items.some((i) => i.kind === "keyword")).toBe(false);
    });

    it("offers the objects of a schema after its name, system ones included", async () => {
        expect(labels(await complete("SELECT * FROM dbo.|"))).toEqual([
            "clients",
            "customer_orders",
            "customers",
            "orders",
            "select",
        ]);
        expect(labels(await complete("SELECT * FROM sys.|"))).toEqual(["objects"]);
        expect(labels(await complete("SELECT * FROM shop.sales.|"))).toEqual([
            "Order Lines",
            "top_lines",
        ]);
        expect(labels(await complete("SELECT * FROM shop.|"), "schema")).toContain("sales");
        // Another database's objects are not known.
        expect(labels(await complete("SELECT * FROM master.dbo.|"))).toEqual([]);
    });

    it("quotes with the bracket the user typed", async () => {
        const result = await complete("SELECT * FROM sales.[Ord|");
        expect(item(result, "Order Lines")).toMatchObject({
            insertText: "[Order Lines]",
            filterText: "[Order Lines]",
        });
        expect(result.range).toEqual({ start: 20, end: 24, replaceEnd: 24 });
    });

    it("offers an alias's columns in table order, with their types", async () => {
        const result = await complete("SELECT c.| FROM dbo.customers c");
        expect(labels(result)).toEqual(["id", "name", "email"]);
        expect(item(result, "name")).toMatchObject({
            kind: "column",
            description: "nvarchar(100)",
            detail: "column dbo.customers.name (nvarchar(100), null)",
            insertText: "name",
        });
        expect(labels(await complete("SELECT customers.| FROM dbo.customers"))).toEqual([
            "id",
            "name",
            "email",
        ]);
        expect(labels(await complete("SELECT dbo.customers.| FROM dbo.customers"))).toEqual([
            "id",
            "name",
            "email",
        ]);
        // A synonym gives its target's columns (the driver resolves it).
        expect(labels(await complete("SELECT x.| FROM clients x"))).toEqual(["id"]);
        expect(
            item(await complete("SELECT l.| FROM sales.[Order Lines] l"), "Unit Price")?.insertText,
        ).toBe("[Unit Price]");
    });

    it("qualifies the columns found in several relations, then offers aliases, functions and keywords", async () => {
        const result = await complete(
            "SELECT * FROM dbo.customers c JOIN dbo.orders o ON o.customer_id = c.id WHERE |",
        );
        const all = labels(result);
        expect(all.slice(0, 7)).toEqual([
            "c.id",
            "name",
            "email",
            "o.id",
            "customer_id",
            "amount",
            "status",
        ]);
        expect(item(result, "c.id")?.insertText).toBe("c.id");
        expect(all.slice(7, 9)).toEqual(["c", "o"]);
        expect(item(result, "c")).toMatchObject({
            kind: "alias",
            detail: "table dbo.customers AS c",
        });
        expect(item(result, "order_total")).toMatchObject({
            kind: "function",
            insertText: "order_total($0)",
            snippet: true,
        });
        expect(item(result, "GETDATE")).toMatchObject({
            kind: "builtInFunction",
            insertText: "GETDATE($0)",
        });
        const firstKeyword = all.indexOf("SELECT");
        expect(firstKeyword).toBeGreaterThan(all.indexOf("GETDATE"));
        expect(all.indexOf("order_total")).toBeLessThan(all.indexOf("GETDATE"));
    });

    it("offers the target's columns only in INSERT column lists and UPDATE SET", async () => {
        expect(labels(await complete("INSERT INTO dbo.customers (|"))).toEqual([
            "id",
            "name",
            "email",
        ]);
        expect(labels(await complete("UPDATE dbo.orders SET status = 'x', |"))).toEqual([
            "id",
            "customer_id",
            "amount",
            "status",
        ]);
    });

    it("offers CTE columns and names", async () => {
        const result = await complete(
            "WITH recent AS (SELECT id, amount FROM dbo.orders) SELECT r.| FROM recent r",
        );
        expect(labels(result)).toEqual(["id", "amount"]);
        expect(labels(await complete("WITH recent AS (SELECT 1 AS x) SELECT * FROM rec|"))[0]).toBe(
            "recent",
        );
    });

    it("offers procedures after EXEC, system ones unqualified (like sqltoolsservice) and after", async () => {
        const result = await complete("EXEC |");
        const all = labels(result);
        expect(all[0]).toBe("archive_orders");
        expect(item(result, "archive_orders")?.detail).toBe(
            "stored procedure dbo.archive_orders @before datetime2(7)",
        );
        expect(item(result, "sp_help")).toMatchObject({
            insertText: "sp_help",
            detail: "stored procedure sys.sp_help",
        });
        expect(item(result, "sp_help")?.filterText).toBeUndefined();
        expect(item(result, "sys.sp_help")).toBeUndefined();
        expect(all.indexOf("sp_help")).toBeGreaterThan(all.indexOf("archive_orders"));
        expect(all.indexOf("sp_help")).toBeLessThan(all.indexOf("dbo"));
        expect(labels(await complete("EXEC dbo.|"))).toEqual(["archive_orders"]);
        // Typed by the user, sys. still lists them.
        expect(item(await complete("EXEC sys.|"), "sp_help")?.insertText).toBe("sp_help");
    });

    it("offers databases after USE", async () => {
        expect(labels(await complete("USE |"))).toEqual(["master", "shop"]);
    });

    it("offers data types where a type goes", async () => {
        const result = await complete("DECLARE @x |");
        expect(item(result, "NVARCHAR")?.kind).toBe("dataType");
        expect(item(result, "phone")?.kind).toBe("type");
        expect(result.items.some((i) => i.kind === "column" || i.kind === "keyword")).toBe(false);
    });

    it("offers the batch's variables after @", async () => {
        const result = await complete("DECLARE @total INT; SELECT @|");
        // The batch's variables, then the @@ globals; nothing that does not start with @.
        expect(labels(result)[0]).toBe("@total");
        expect(item(result, "@@ROWCOUNT")).toMatchObject({
            insertText: "@@ROWCOUNT",
            detail: "global variable",
        });
        expect(result.items.every((i) => i.label.startsWith("@"))).toBe(true);
        expect(item(result, "@total")).toMatchObject({
            kind: "variable",
            detail: "local variable @total INT",
        });
        expect(result.range.start).toBe("DECLARE @total INT; SELECT ".length);
    });

    it("offers keywords at the start of a statement and after an operand", async () => {
        expect(labels(await complete("|"))).toContain("SELECT");
        const after = await complete("SELECT * FROM dbo.customers |");
        expect(new Set(after.items.map((i) => i.kind))).toEqual(new Set(["keyword"]));
        expect(item(after, "WHERE")).toMatchObject({
            insertText: "WHERE",
            detail: "WHERE keyword",
        });
    });

    it("follows lowerCaseSuggestions", async () => {
        const result = await complete("SELECT | FROM dbo.customers", {
            options: { ...OPTIONS, lowerCaseSuggestions: true },
        });
        expect(item(result, "getdate")?.insertText).toBe("getdate($0)");
        expect(item(result, "from")).toBeDefined();
        expect(item(result, "FROM")).toBeUndefined();
    });

    it("offers nothing in strings and comments", async () => {
        expect((await complete("SELECT 'a|'")).items).toEqual([]);
        expect((await complete("-- a|")).items).toEqual([]);
    });

    it("answers with keywords and an incomplete list while the objects load", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const connection = fakeConnection({ objectsGate: gate });
        const metadata = new CompletionMetadata(connection, "shop");
        const options = { ...OPTIONS, budgetMs: 20 };
        const first = await computeCompletions(
            "SELECT * FROM ",
            14,
            mssqlDriver,
            metadata,
            options,
        );
        expect(first.incomplete).toBe(true);
        expect(first.items).toEqual([]);
        release();
        const second = await computeCompletions(
            "SELECT * FROM ",
            14,
            mssqlDriver,
            metadata,
            options,
        );
        expect(second.incomplete).toBe(false);
        expect(labels(second)).toContain("customers");
        expect(connection.calls.objects).toBe(1);
    });

    it("answers without the columns that are still loading, and has them next time", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const connection = fakeConnection({ columnsGate: gate });
        const metadata = new CompletionMetadata(connection, "shop");
        const options = { ...OPTIONS, budgetMs: 20 };
        const script = "SELECT c. FROM dbo.customers c";
        const first = await computeCompletions(script, 9, mssqlDriver, metadata, options);
        expect(first).toMatchObject({ incomplete: true, items: [] });
        release();
        await gate;
        const second = await computeCompletions(script, 9, mssqlDriver, metadata, options);
        expect(second.incomplete).toBe(false);
        expect(labels(second)).toEqual(["id", "name", "email"]);
        // Loaded once, kept.
        await computeCompletions(script, 9, mssqlDriver, metadata, options);
        expect(connection.calls.columns).toEqual([[{ schema: "dbo", name: "customers" }]]);
    });

    it("keeps the matching items of a huge database and asks again", async () => {
        const objects = Array.from({ length: 5000 }, (_, i) => ({
            kind: "table" as const,
            schema: "dbo",
            name: `table_${String(i).padStart(4, "0")}`,
        }));
        const connection = fakeConnection({
            objects: [{ kind: "schema", name: "dbo" }, ...objects],
        });
        const result = await complete("SELECT * FROM table_12|", {
            connection,
            options: { ...OPTIONS, maxItems: 1000 },
        });
        expect(result.incomplete).toBe(true);
        expect(result.items.length).toBe(100); // table_1200..table_1299
        expect(result.items.every((i) => i.label.startsWith("table_12"))).toBe(true);
    });

    it("quotes PostgreSQL names that need it", async () => {
        const connection = fakeConnection({
            objects: [
                { kind: "schema", name: "public" },
                { kind: "schema", name: "Sales" },
                { kind: "table", schema: "public", name: "Customers" },
                { kind: "table", schema: "public", name: "orders" },
                { kind: "table", schema: "Sales", name: "lines" },
            ],
            defaultSchemas: ["public"],
        });
        const result = await complete("SELECT * FROM |", { driver: pgDriver, connection });
        expect(item(result, "Customers")?.insertText).toBe('"Customers"');
        expect(item(result, "orders")?.insertText).toBe("orders");
        expect(item(result, "Sales.lines")?.insertText).toBe('"Sales".lines');
        const quoted = await complete('SELECT * FROM "Cust|', { driver: pgDriver, connection });
        expect(item(quoted, "Customers")).toMatchObject({
            insertText: '"Customers"',
            filterText: '"Customers"',
        });
    });

    it("offers nothing database-related without metadata", async () => {
        const result = await computeCompletions(
            "SELECT * FROM ",
            14,
            mssqlDriver,
            undefined,
            OPTIONS,
        );
        expect(result).toMatchObject({ items: [], incomplete: false });
    });
});
