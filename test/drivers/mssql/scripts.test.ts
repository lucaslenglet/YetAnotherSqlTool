import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSelectScript, scriptObject } from "../../../src/drivers/mssql/scripting";
import { toAlterDefinition } from "../../../src/drivers/mssql/scriptText";
import type { Row } from "../../../src/drivers/mssql/objectExplorer";
import { capturedScripts, nodeFor, reference } from "./scriptReference";

// docs/reference/mssql-scripts.json: what sqltoolsservice returns for "Script as Select / Create /
// Drop / Alter / Execute" (tools/sts-script-probe.js).

const unbracket = (text: string) => text.slice(1, -1).replace(/]]/g, "]");

/** Database, schema, table and columns written in a captured script. */
function parse(script: string) {
    const lines = script.split("\n");
    const columns = [lines[0].replace("SELECT TOP (1000) ", ""), ...lines.slice(1, -1)].map((l) =>
        unbracket(l.replace(/^ {6},/, "")),
    );
    const parts = lines[lines.length - 1].replace("  FROM ", "").match(/\[(?:[^\]]|\]\])+\]/g)!;
    return { columns, parts: parts.map(unbracket) };
}

describe("buildSelectScript against sqltoolsservice's captured scripts", () => {
    const relations = Object.entries(reference.scripts).filter(
        ([, v]) => (v.type === "Table" || v.type === "View") && typeof v.select === "string",
    );

    it("has captures of tables and views", () => {
        expect(relations.length).toBeGreaterThanOrEqual(8);
    });

    for (const [name, captured] of relations) {
        it(`reproduces the script of ${name}`, () => {
            const script = captured.select as string;
            const { columns, parts } = parse(script);
            expect(buildSelectScript(parts[0], parts[1], parts[2], columns)).toBe(script);
        });
    }
});

// The catalog rows the driver read for each object on a real server, recorded by
// test/drivers/mssql/scriptObjects.integration.test.ts (RECORD_SCRIPT_CATALOG=1), replayed in order.
const recording = JSON.parse(
    readFileSync(resolve(__dirname, "../../fixtures/scripting/mssql-catalog.json"), "utf8"),
) as Record<string, Array<[Record<string, string>, Row[]]>>;

describe("Script as Create / Drop / Alter / Execute against sqltoolsservice's captured scripts", () => {
    const scripts = capturedScripts();

    it("covers every kind of object of the capture", () => {
        expect(scripts.length).toBeGreaterThanOrEqual(130);
        expect(new Set(scripts.map((s) => s.operation))).toEqual(
            new Set(["create", "delete", "alter", "execute"]),
        );
    });

    for (const { key, operation, script } of scripts) {
        it(`reproduces ${key} as ${operation} from its catalog rows`, async () => {
            const calls = [...(recording[`${key}|${operation}`] ?? [])];
            expect(calls.length, "recorded catalog rows").toBeGreaterThan(0);
            const replay = async (
                _database: string | undefined,
                _text: string,
                parameters = {},
            ) => {
                const [recordedParameters, rows] = calls.shift()!;
                expect(parameters).toEqual(recordedParameters);
                return rows;
            };
            expect(
                await scriptObject(nodeFor(key, "yast_oe_scripts")!, operation, replay, 16),
            ).toBe(script);
        });
    }
});

describe("toAlterDefinition", () => {
    it("replaces the CREATE keyword and keeps everything else", () => {
        expect(toAlterDefinition("CREATE   PROC p AS SELECT 1")).toBe("ALTER   PROC p AS SELECT 1");
        expect(toAlterDefinition("create view v as select 'CREATE' x")).toBe(
            "ALTER view v as select 'CREATE' x",
        );
    });

    it("skips the comments before it, nested ones included", () => {
        expect(toAlterDefinition("-- CREATE x\n/* a /* CREATE */ b */\r\n  CREATE TRIGGER t")).toBe(
            "-- CREATE x\n/* a /* CREATE */ b */\r\n  ALTER TRIGGER t",
        );
    });

    it("rejects a text that does not start with CREATE", () => {
        expect(() => toAlterDefinition("ALTER VIEW v AS SELECT 1")).toThrow(/CREATE/);
    });
});
