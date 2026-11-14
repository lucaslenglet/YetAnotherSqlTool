import { describe, expect, it } from "vitest";
import * as mssql from "../../src/drivers/mssql/scripting";
import * as pg from "../../src/drivers/pg/scripting";
import type { ObjectNode } from "../../src/drivers/types";

describe("SQL Server select script", () => {
    it("lays out one column per line with leading commas and a three-part name", () => {
        expect(mssql.buildSelectScript("yast", "dbo", "customers", ["id", "name", "email"])).toBe(
            [
                "SELECT TOP (1000) [id]",
                "      ,[name]",
                "      ,[email]",
                "  FROM [yast].[dbo].[customers]",
            ].join("\n"),
        );
    });

    it("quotes names with spaces and doubles closing brackets", () => {
        expect(mssql.buildSelectScript("my db", "s]x", "t]]", ["a b", "c]"])).toBe(
            ["SELECT TOP (1000) [a b]", "      ,[c]]]", "  FROM [my db].[s]]x].[t]]]]]"].join("\n"),
        );
    });

    it("handles a single column", () => {
        expect(mssql.buildSelectScript("d", "s", "t", ["x"])).toBe(
            "SELECT TOP (1000) [x]\n  FROM [d].[s].[t]",
        );
    });

    it("rejects operations other than select and nodes that are not relations", async () => {
        const node: ObjectNode = {
            nodePath: "x",
            parentNodePath: "",
            nodeType: "Table",
            label: "dbo.t",
            isLeaf: false,
            database: "d",
        };
        const run = async () => [];
        await expect(mssql.scriptObject(node, "alter", run)).rejects.toThrow(/not supported/);
        await expect(
            mssql.scriptObject({ ...node, nodeType: "Folder" }, "select", run),
        ).rejects.toThrow(/Cannot script/);
    });
});

describe("PostgreSQL select script", () => {
    it("lays out one column per line and ends with LIMIT", () => {
        expect(pg.buildSelectScript("public", "customers", ["id", "name"])).toBe(
            ["SELECT id", "      ,name", "  FROM public.customers", "  LIMIT 1000"].join("\n"),
        );
    });

    it("keeps the quotes the server added", () => {
        expect(pg.buildSelectScript('"My Schema"', '"Mixed"', ['"Col A"', "b"])).toBe(
            ['SELECT "Col A"', "      ,b", '  FROM "My Schema"."Mixed"', "  LIMIT 1000"].join("\n"),
        );
    });

    it("selects * from a table without columns", () => {
        expect(pg.buildSelectScript("public", "empty", [])).toBe(
            "SELECT *\n  FROM public.empty\n  LIMIT 1000",
        );
    });

    it("rejects operations other than select and relations that are gone", async () => {
        const node: ObjectNode = {
            nodePath: "x",
            parentNodePath: "",
            nodeType: "Table",
            label: "t",
            isLeaf: false,
            database: "d",
            metadata: { schema: "public", name: "t" } as ObjectNode["metadata"],
        };
        const client = { query: async () => ({ rows: [] }) };
        await expect(pg.scriptObject(node, "execute", async () => client)).rejects.toThrow(
            /not supported/,
        );
        await expect(pg.scriptObject(node, "select", async () => client)).rejects.toThrow(
            /does not exist/,
        );
    });
});
