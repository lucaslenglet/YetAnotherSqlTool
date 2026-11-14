import { describe, expect, it } from "vitest";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import type { Driver } from "../../src/drivers/types";
import {
    analyzeCompletionContext,
    type CompletionContext,
    type ScopeRelation,
} from "../../src/languageFeatures/completion/completionContext";

/** "|" marks the cursor. */
function analyze(driver: Driver, marked: string): CompletionContext {
    const offset = marked.indexOf("|");
    return analyzeCompletionContext(
        marked.slice(0, offset) + marked.slice(offset + 1),
        offset,
        driver,
    );
}

/** "dbo.customers c", "recent r (cte)", "(derived) d". */
function describeRelation(r: ScopeRelation): string {
    const name = r.kind === "derived" ? "(derived)" : r.parts.map((p) => p.name).join(".");
    const kind = r.kind === "table" ? "" : ` (${r.kind})`;
    return `${name}${r.alias ? ` ${r.alias.name}` : ""}${kind}${r.depth ? ` @${r.depth}` : ""}`;
}

const relations = (c: CompletionContext) => c.relations.map(describeRelation);
const qualifiers = (c: CompletionContext) => c.qualifiers.map((q) => q.name);

describe.each([
    ["SQL Server", mssqlDriver],
    ["PostgreSQL", pgDriver],
])("completion context (%s)", (_, driver) => {
    it.each([
        ["|", "keyword"],
        ["SEL|", "keyword"],
        ["SELECT |", "expression"],
        ["SELECT | FROM customers", "expression"],
        ["SELECT a, | FROM customers", "expression"],
        ["SELECT a |", "afterOperand"],
        ["SELECT * |", "afterOperand"],
        ["SELECT a AS |", "none"],
        ["SELECT * FROM |", "relation"],
        ["SELECT * FROM cust|", "relation"],
        ["SELECT * FROM a, |", "relation"],
        ["SELECT * FROM a JOIN |", "relation"],
        ["SELECT * FROM a LEFT OUTER JOIN |", "relation"],
        ["SELECT * FROM customers |", "afterOperand"],
        ["SELECT * FROM customers c |", "afterOperand"],
        ["SELECT * FROM customers WHERE |", "expression"],
        ["SELECT * FROM customers WHERE\n|", "expression"],
        ["SELECT * FROM customers WHERE a = |", "expression"],
        ["SELECT * FROM customers WHERE a = 1 AND |", "expression"],
        ["SELECT * FROM customers WHERE a IS NULL |", "afterOperand"],
        ["SELECT * FROM a JOIN b ON |", "expression"],
        ["SELECT * FROM a ORDER BY |", "expression"],
        ["SELECT a, COUNT(*) FROM a GROUP BY a, |", "expression"],
        ["SELECT COUNT(|", "expression"],
        ["SELECT * FROM a WHERE id IN (|", "expression"],
        ["INSERT INTO |", "relation"],
        ["INSERT INTO customers (|", "targetColumn"],
        ["INSERT INTO customers (id, |", "targetColumn"],
        ["INSERT INTO customers (id) VALUES (|", "expression"],
        ["UPDATE |", "relation"],
        ["UPDATE customers SET |", "targetColumn"],
        ["UPDATE customers SET a = 1, |", "targetColumn"],
        ["UPDATE customers SET a = |", "expression"],
        ["DELETE FROM |", "relation"],
        ["DROP TABLE |", "relation"],
        ["DROP TABLE IF EXISTS |", "relation"],
        ["ALTER TABLE |", "relation"],
        ["CREATE TABLE |", "none"],
        ["CREATE VIEW |", "none"],
        ["CREATE TABLE t (id |", "dataType"],
        ["CREATE TABLE t (id int, |", "keyword"],
        ["ALTER TABLE t ADD c |", "dataType"],
        ["SELECT CAST(a AS |", "dataType"],
        ["SELECT 'abc|' FROM a", "none"],
        ["SELECT 'abc' |", "afterOperand"],
        ["-- comment |\nSELECT 1", "none"],
        ["/* comment | */ SELECT 1", "none"],
        ["SELECT 1 /* comment */ |", "afterOperand"],
        ["SELECT * FROM a WHERE x = 1;\n|", "keyword"],
    ])("%j -> %s", (script, kind) => {
        expect(analyze(driver, script).kind).toBe(kind);
    });

    it("finds aliases, joins and comma joins", () => {
        const context = analyze(
            driver,
            "SELECT | FROM sales.orders o JOIN customers AS c ON c.id = o.customer_id, items i WHERE 1 = 1",
        );
        expect(relations(context)).toEqual(["sales.orders o", "customers c", "items i"]);
    });

    it("reads the qualifier of a column", () => {
        const context = analyze(driver, "SELECT c.em| FROM customers c");
        expect(context.kind).toBe("expression");
        expect(qualifiers(context)).toEqual(["c"]);
        expect(context.word.text).toBe("em");
        expect(relations(context)).toEqual(["customers c"]);
    });

    it("reads schema and database qualifiers", () => {
        expect(qualifiers(analyze(driver, "SELECT * FROM sales.|"))).toEqual(["sales"]);
        const context = analyze(driver, "SELECT * FROM db.sales.ord|");
        expect(context.kind).toBe("relation");
        expect(qualifiers(context)).toEqual(["db", "sales"]);
    });

    it("keeps the scope of a subquery and sees the outer query", () => {
        const context = analyze(
            driver,
            "SELECT * FROM customers c WHERE id IN (SELECT | FROM orders o WHERE o.x = 1)",
        );
        expect(context.kind).toBe("expression");
        expect(relations(context)).toEqual(["orders o", "customers c @1"]);
        // The outer query does not see the subquery's relations.
        expect(
            relations(
                analyze(driver, "SELECT | FROM customers c WHERE id IN (SELECT 1 FROM orders o)"),
            ),
        ).toEqual(["customers c"]);
    });

    it("derives the columns of CTEs and derived tables", () => {
        const cte = analyze(
            driver,
            "WITH recent (a, b) AS (SELECT 1, 2), other AS (SELECT id, x.amount AS total FROM t x) SELECT r.| FROM recent r JOIN other ON 1 = 1",
        );
        expect(cte.ctes.map((c) => [c.name.name, c.columns])).toEqual([
            ["recent", ["a", "b"]],
            ["other", ["id", "total"]],
        ]);
        expect(relations(cte)).toEqual(["recent r (cte)", "other (cte)"]);
        const derived = analyze(driver, "SELECT d.| FROM (SELECT a, b AS bb FROM t) d");
        expect(derived.relations[0]).toMatchObject({ kind: "derived", columns: ["a", "bb"] });
        expect(derived.relations[0].alias?.name).toBe("d");
        expect(
            analyze(driver, "SELECT d.| FROM (SELECT * FROM t) d").relations[0].columns,
        ).toBeUndefined();
    });

    it("finds the target of INSERT, UPDATE and the scope of UPDATE ... FROM", () => {
        expect(
            analyze(driver, "INSERT INTO sales.orders (|").target?.parts.map((p) => p.name),
        ).toEqual(["sales", "orders"]);
        const update = analyze(
            driver,
            "UPDATE c SET | FROM customers c JOIN orders o ON o.c = c.id",
        );
        expect(update.kind).toBe("targetColumn");
        expect(describeRelation(update.target!)).toBe("customers c");
    });

    it("handles MERGE", () => {
        const context = analyze(
            driver,
            "MERGE INTO customers AS t USING staged AS s ON t.id = s.|",
        );
        expect(qualifiers(context)).toEqual(["s"]);
        expect(relations(context)).toEqual(["customers t", "staged s"]);
    });

    it("takes the statement around the cursor only", () => {
        const context = analyze(
            driver,
            "SELECT * FROM a;\nSELECT * FROM b WHERE |;\nSELECT * FROM c",
        );
        expect(relations(context)).toEqual(["b"]);
    });

    it("does not take the word being typed for an alias", () => {
        expect(relations(analyze(driver, "SELECT * FROM customers c|"))).toEqual(["customers"]);
        expect(relations(analyze(driver, "SELECT * FROM cust|"))).toEqual([]);
    });
});

describe("completion context (SQL Server)", () => {
    const d = mssqlDriver;

    it.each([
        ["EXEC |", "procedure"],
        ["EXECUTE dbo.|", "procedure"],
        ["USE |", "database"],
        ["TRUNCATE TABLE |", "relation"],
        ["DECLARE @x |", "dataType"],
        ["DECLARE @x AS |", "dataType"],
        ["DECLARE @a int, @b |", "dataType"],
        ["SELECT CONVERT(|", "dataType"],
        ["SELECT TOP 10 | FROM t", "expression"],
        ["SELECT TOP (10) | FROM t", "afterOperand"],
        ["SELECT * FROM t WITH (NOLOCK) WHERE |", "expression"],
        ["SELECT 1\nSELECT * FROM orders WHERE |", "expression"],
    ])("%j -> %s", (script, kind) => {
        expect(analyze(d, script).kind).toBe(kind);
    });

    it("statements without semicolons have their own scope", () => {
        expect(relations(analyze(d, "SELECT * FROM a\nSELECT * FROM b WHERE |"))).toEqual(["b"]);
    });

    it("reads bracketed words being typed", () => {
        const context = analyze(d, "SELECT * FROM sales.[Ord|");
        expect(context.kind).toBe("relation");
        expect(context.word).toMatchObject({ text: "[Ord", quote: "[" });
        expect(qualifiers(context)).toEqual(["sales"]);
        const aliased = analyze(d, "SELECT [x y].| FROM [My Table] AS [x y]");
        expect(qualifiers(aliased)).toEqual(["x y"]);
        expect(relations(aliased)).toEqual(["My Table x y"]);
    });

    it("lists the variables of the batch", () => {
        const context = analyze(
            d,
            "DECLARE @old int\nGO\nDECLARE @total INT, @name AS nvarchar(50); SET @total = 1; SELECT @|",
        );
        expect(context.word.text).toBe("@");
        expect(context.variables).toEqual([
            { name: "@total", type: "INT" },
            { name: "@name", type: "nvarchar" },
        ]);
    });

    it("sees table functions in CROSS APPLY", () => {
        const context = analyze(d, "SELECT f.| FROM a CROSS APPLY dbo.fn(a.id) f");
        expect(relations(context)).toEqual(["a", "dbo.fn f (function)"]);
    });
});

describe("completion context (PostgreSQL)", () => {
    const d = pgDriver;

    it.each([
        ["CALL |", "procedure"],
        ["TRUNCATE |", "relation"],
        ["SELECT a::|", "dataType"],
        ["ALTER TABLE t ALTER COLUMN c TYPE |", "dataType"],
        ["CREATE TABLE IF NOT EXISTS |", "none"],
        ["INSERT INTO t (a) VALUES (1) RETURNING |", "expression"],
        ["SELECT * FROM a JOIN b USING (|", "expression"],
        ["DELETE FROM a USING |", "relation"],
        ['SELECT * FROM "Cust|', "relation"],
        ["SELECT $$ body | $$", "none"],
        ["SELECT * FROM a LIMIT |", "expression"],
    ])("%j -> %s", (script, kind) => {
        expect(analyze(d, script).kind).toBe(kind);
    });

    it("reads double-quoted words being typed", () => {
        const context = analyze(d, 'SELECT "Order Lines".| FROM sales."Order Lines"');
        expect(qualifiers(context)).toEqual(["Order Lines"]);
        expect(relations(context)).toEqual(["sales.Order Lines"]);
        expect(analyze(d, 'SELECT * FROM "Cust|').word).toMatchObject({
            text: '"Cust',
            quote: '"',
        });
    });

    it("has no variables", () => {
        expect(analyze(d, "SELECT $1, |").variables).toEqual([]);
    });
});
