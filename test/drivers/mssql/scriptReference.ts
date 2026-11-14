import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ObjectMetadata } from "vscode-mssql";
import type { ObjectNode, ScriptOperation } from "../../../src/drivers/types";
import { SCRIPT_OPERATIONS } from "../../../src/drivers/mssql/scripting";

// What the SQL Server scripting tests share: docs/reference/mssql-scripts.json (captured by
// tools/sts-script-probe.js on the objects of test/fixtures/scripting/mssql-objects.sql) and the
// Object Explorer node of each captured object.

type Captured = string | { error: string };

export interface ReferenceEntry {
    type: string;
    select: Captured;
    create: Captured;
    delete: Captured;
    alter: Captured;
    execute: Captured;
}

export const reference = JSON.parse(
    readFileSync(resolve(__dirname, "../../../docs/reference/mssql-scripts.json"), "utf8"),
) as { serverVersion: string; scripts: Record<string, ReferenceEntry> };

export const fixtureTablesSql = readFileSync(
    resolve(__dirname, "../../fixtures/mssql/01-schema.sql"),
    "utf8",
)
    .split(/^GO$/m)
    .filter((batch) => !/CREATE DATABASE|^\s*USE /m.test(batch))
    .join("GO");

export const objectsSql = readFileSync(
    resolve(__dirname, "../../fixtures/scripting/mssql-objects.sql"),
    "utf8",
);

/** nodeType of the Object Explorer for a captured object, from its key and SMO type. */
function nodeTypeOf(key: string, type: string): string | undefined {
    switch (type) {
        case "Table":
        case "View":
        case "StoredProcedure":
        case "UserDefinedTableType":
        case "UserDefinedDataType":
        case "Sequence":
        case "Synonym":
        case "Schema":
        case "User":
        case "ApplicationRole":
            return type;
        case "UserDefinedFunction":
            return key === "probe.f_scalar" ? "ScalarValuedFunction" : "TableValuedFunction";
        case "Role":
            return "DatabaseRole";
        case "Trigger":
            return key.includes("/") ? "Trigger" : undefined; // database trigger: see below
        case "DdlTrigger":
            return "DatabaseTrigger";
        case "Index":
        case "ForeignKey":
            return key.includes("/") ? (type === "ForeignKey" ? "Key" : "Index") : undefined;
        default:
            return undefined;
    }
}

/**
 * The Object Explorer node of a captured object in `database`, or undefined for captures that do
 * not correspond to a node of our tree (the database trigger asked as "Trigger" or
 * "DatabaseDdlTrigger", which SMO cannot script; the DdlTrigger capture stands for it).
 */
export function nodeFor(key: string, database: string): ObjectNode | undefined {
    const entry = reference.scripts[key];
    const nodeType = nodeTypeOf(key, entry.type);
    if (!nodeType) return undefined;
    const [objectPart, child] = key.split("/");
    let schema: string | null = null;
    let name = objectPart;
    let parentName: string | null = null;
    let parentTypeName: string | null = null;
    const qualified = ["Schema", "User", "DatabaseRole", "ApplicationRole", "DatabaseTrigger"];
    if (!qualified.includes(nodeType)) {
        const dot = objectPart.indexOf(".");
        schema = objectPart.slice(0, dot);
        name = objectPart.slice(dot + 1);
    }
    if (child !== undefined && nodeType !== "DatabaseTrigger") {
        parentName = name;
        parentTypeName = name.startsWith("v_") ? "View" : "Table";
        name = child;
    }
    return {
        nodePath: `x/${key}`,
        parentNodePath: "x",
        nodeType,
        label: key,
        isLeaf: true,
        database,
        metadata: {
            metadataType: 0,
            metadataTypeName: entry.type === "Role" ? "Role" : entry.type,
            schema,
            name,
            parentName,
            parentTypeName,
            urn: "",
        } as unknown as ObjectMetadata,
    };
}

/** Pairs (key, operation) whose capture is a script and that our tree offers for that node. */
export function capturedScripts(): Array<{
    key: string;
    operation: ScriptOperation;
    script: string;
}> {
    const result = [];
    for (const [key, entry] of Object.entries(reference.scripts)) {
        const node = nodeFor(key, "db");
        if (!node) continue;
        for (const operation of ["create", "delete", "alter", "execute"] as const) {
            const script = entry[operation];
            if (typeof script !== "string" || script.trim() === "" || script === "\nGO\n") continue;
            if (!SCRIPT_OPERATIONS[node.nodeType].includes(operation)) continue;
            result.push({ key, operation, script });
        }
    }
    return result;
}
