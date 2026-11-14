import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRIPT_OPERATIONS as MSSQL } from "../../src/drivers/mssql/scripting";
import { SCRIPT_OPERATIONS as PG } from "../../src/drivers/pg/scripting";
import type { ScriptOperation } from "../../src/drivers/types";

// The "Script as" menu entries of package.json must never lead to "not supported": every node
// type they are shown on must support the operation on each engine whose tree has that type.

const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
const menus: Record<string, Array<{ command?: string; submenu?: string; when?: string }>> = manifest
    .contributes.menus;

/** nodeType values of each engine's Object Explorer tree that a menu can target. */
const MSSQL_TREE = [
    "Table",
    "View",
    "StoredProcedure",
    "TableValuedFunction",
    "ScalarValuedFunction",
    "AggregateFunction",
    "Trigger",
    "DatabaseTrigger",
    "Index",
    "Key",
    "Constraint",
    "Column",
    "Statistic",
    "Schema",
    "User",
    "DatabaseRole",
    "ApplicationRole",
    "UserDefinedTableType",
    "UserDefinedDataType",
    "Sequence",
    "Synonym",
];
const PG_TREE = [
    "Table",
    "View",
    "StoredProcedure",
    "TableValuedFunction",
    "ScalarValuedFunction",
    "AggregateFunction",
    "Trigger",
    "Index",
    "Key",
    "Constraint",
    "Column",
    "Schema",
    "Sequence",
    "UserDefinedDataType",
    "UserDefinedType",
];

const COMMANDS: Record<string, ScriptOperation> = {
    "yast.scriptSelect": "select",
    "yast.scriptCreate": "create",
    "yast.scriptDelete": "delete",
    "yast.scriptAlter": "alter",
    "yast.scriptExecute": "execute",
};

/** Node types named in a when clause's viewItem =~ /\btype=(A|B)\b/. */
const typesOf = (when: string) => /type=\(([^)]+)\)/.exec(when)?.[1].split("|") ?? [];

/** [operation, node types] of each scripting entry of the Object Explorer's context menu. */
function entries(): Array<[ScriptOperation, string[]]> {
    const result: Array<[ScriptOperation, string[]]> = [];
    for (const item of menus["view/item/context"]) {
        if (item.command && COMMANDS[item.command]) {
            result.push([COMMANDS[item.command], typesOf(item.when!)]);
        }
        if (item.submenu === "yast.sqlScriptsSubmenu") {
            for (const sub of menus["yast.sqlScriptsSubmenu"]) {
                result.push([COMMANDS[sub.command!], typesOf(item.when!)]);
            }
        }
    }
    return result;
}

describe("Script as menus", () => {
    it("has an entry for each operation, and the table submenu", () => {
        expect(new Set(entries().map(([operation]) => operation))).toEqual(
            new Set(Object.values(COMMANDS)),
        );
        expect(menus["yast.sqlScriptsSubmenu"].map((m) => m.command)).toEqual([
            "yast.scriptCreate",
            "yast.scriptDelete",
        ]);
    });

    for (const [operation, types] of entries()) {
        for (const type of types) {
            if (type === "HistoryTable") continue; // not a node type of our trees
            it(`${operation} works on ${type} for each engine that has it`, () => {
                expect(MSSQL_TREE.includes(type) || PG_TREE.includes(type)).toBe(true);
                if (MSSQL_TREE.includes(type)) expect(MSSQL[type]).toContain(operation);
                if (PG_TREE.includes(type)) expect(PG[type]).toContain(operation);
            });
        }
    }

    it("hides the scripting commands from the command palette", () => {
        const hidden = menus.commandPalette.filter((m) => m.when === "false").map((m) => m.command);
        for (const command of [...Object.keys(COMMANDS), "yast.scriptDatabase"]) {
            expect(hidden).toContain(command);
        }
    });

    it("offers Generate Scripts... on databases", () => {
        const entry = menus["view/item/context"].find((m) => m.command === "yast.scriptDatabase");
        expect(typesOf(entry!.when!)).toEqual(["Database"]);
    });
});
