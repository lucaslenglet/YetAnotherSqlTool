/**
 * "Script as" for SQL Server objects: Select (Select Top 1000), Create, Alter, Drop and Execute.
 *
 * Select has the layout SMO gives to sqltoolsservice's "Script as Select" (and SSMS's "Select Top
 * 1000 Rows" without its comment header): one column per line, leading commas, and the three-part
 * name of the object. The other scripts are read from the catalog (scriptCatalog.ts) and written
 * like SMO writes them (scriptText.ts); docs/reference/mssql-scripts.json is the reference.
 */

import type { ObjectNode, ScriptOperation } from "../types";
import type { MetadataQueryRunner } from "./objectExplorer";
import { ScriptCatalog } from "./scriptCatalog";
import * as text from "./scriptText";
import { quoteIdentifier } from "./sqlText";

/** Rows returned by "Select Top 1000". */
export const SELECT_TOP_ROWS = 1000;

/**
 * Columns in table order. sqltoolsservice (docs/reference/mssql-scripts.json) leaves out the period
 * columns of a temporal table, hidden or not, and the hidden graph columns; it keeps rowversion,
 * computed and spatial columns.
 */
const selectableColumnsQuery = (db: string) => `
    SELECT c.name
    FROM ${db}.sys.columns c
    JOIN ${db}.sys.objects o ON o.object_id = c.object_id
    JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
    WHERE s.name = @schema AND o.name = @name AND o.type IN ('U', 'V') AND c.is_hidden = 0
      AND c.generated_always_type = 0
    ORDER BY c.column_id`;

/** Text of the script, from the names as stored in the catalog (unquoted). */
export function buildSelectScript(
    database: string,
    schema: string,
    name: string,
    columns: string[],
): string {
    const list = columns.map(quoteIdentifier).join("\n      ,");
    const table = [database, schema, name].map(quoteIdentifier).join(".");
    return `SELECT TOP (${SELECT_TOP_ROWS}) ${list}\n  FROM ${table}`;
}

/**
 * Operations each node type can be scripted as. package.json shows the "Script as" menu entries
 * only on node types that support them; keep the two in sync.
 */
export const SCRIPT_OPERATIONS: Record<string, readonly ScriptOperation[]> = {
    Table: ["select", "create", "delete"],
    View: ["select", "create", "alter", "delete"],
    StoredProcedure: ["create", "alter", "delete", "execute"],
    TableValuedFunction: ["create", "alter", "delete"],
    ScalarValuedFunction: ["create", "alter", "delete"],
    Trigger: ["create", "alter", "delete"],
    DatabaseTrigger: ["create", "alter", "delete"],
    Index: ["create", "delete"],
    Key: ["create", "delete"],
    Schema: ["create", "delete"],
    User: ["create", "delete"],
    DatabaseRole: ["create", "delete"],
    ApplicationRole: ["create", "delete"],
    UserDefinedTableType: ["create", "delete"],
    UserDefinedDataType: ["create", "delete"],
    Sequence: ["create", "delete"],
    Synonym: ["create", "delete"],
};

export async function scriptObject(
    node: ObjectNode,
    operation: ScriptOperation,
    runQuery: MetadataQueryRunner,
    serverMajorVersion = 16,
): Promise<string> {
    const database = node.database ?? node.context?.database;
    const metadata = node.metadata;
    if (!SCRIPT_OPERATIONS[node.nodeType]?.includes(operation)) {
        if (operation === "select" || !SCRIPT_OPERATIONS[node.nodeType]) {
            throw new Error(`Cannot script '${node.label}' as ${operation}.`);
        }
        throw new Error(`Scripting a ${node.nodeType} as ${operation} is not supported.`);
    }
    if (!database || !metadata?.name) {
        throw new Error(`Cannot script '${node.label}' as ${operation}.`);
    }
    if (operation === "select") return scriptSelect(node, database, runQuery);

    const catalog = new ScriptCatalog(database, runQuery, serverMajorVersion);
    const schema = metadata.schema ?? "";
    const name = metadata.name;
    const gone = () => new Error(`'${node.label}' does not exist anymore.`);
    const pick = <T>(rows: T[]): T => {
        if (rows.length === 0) throw gone();
        return rows[0];
    };
    const objectId = async (objectSchema: string, objectName: string) => {
        const id = await catalog.findObject(objectSchema, objectName);
        if (id === undefined) throw gone();
        return id;
    };

    switch (node.nodeType) {
        case "Table": {
            const model = pick(await catalog.tables({ objectId: await objectId(schema, name) }));
            return operation === "create"
                ? text.scriptTableCreate(model)
                : text.scriptTableDrop(model.table);
        }
        case "View": {
            const model = await catalog.view(await objectId(schema, name));
            if (!model) throw gone();
            if (operation === "create") return text.scriptViewCreate(model);
            if (operation === "alter") return text.scriptModuleAlter(model.view);
            return text.scriptModuleDrop(model.view);
        }
        case "StoredProcedure":
        case "TableValuedFunction":
        case "ScalarValuedFunction":
        case "Trigger": {
            const id = await objectId(schema, name);
            const module = await catalog.module(id);
            if (!module) throw gone();
            if (operation === "execute") {
                return text.scriptProcedureExecute(schema, name, await catalog.parameters(id));
            }
            return scriptModule(module, operation);
        }
        case "DatabaseTrigger":
            return scriptModule(pick(await catalog.databaseTriggers(name)), operation);
        case "Index":
        case "Key":
            return scriptTableChild(catalog, node, operation, objectId);
        case "Schema": {
            pick(await catalog.schemas(name));
            return operation === "create"
                ? text.scriptSchemaCreate(name)
                : text.scriptSchemaDrop(name);
        }
        case "User": {
            const user = pick(await catalog.principals(["S", "U", "G", "E", "X", "C", "K"], name));
            return operation === "create" ? text.scriptUserCreate(user) : text.scriptUserDrop(name);
        }
        case "DatabaseRole": {
            pick(await catalog.principals(["R"], name));
            return operation === "create" ? text.scriptRoleCreate(name) : text.scriptRoleDrop(name);
        }
        case "ApplicationRole": {
            const role = pick(await catalog.principals(["A"], name));
            return operation === "create"
                ? text.scriptApplicationRoleCreate(role)
                : text.scriptApplicationRoleDrop(name);
        }
        case "UserDefinedTableType": {
            const type = pick(await catalog.tableTypes(schema, name));
            return operation === "create"
                ? text.scriptTableTypeCreate(type)
                : text.scriptTypeDrop(schema, name);
        }
        case "UserDefinedDataType": {
            const type = pick(await catalog.types(schema, name));
            return operation === "create"
                ? text.scriptTypeCreate(type)
                : text.scriptTypeDrop(schema, name);
        }
        case "Sequence": {
            const sequence = pick(await catalog.sequences(schema, name));
            return operation === "create"
                ? text.scriptSequenceCreate(sequence)
                : text.scriptSequenceDrop(schema, name);
        }
        case "Synonym": {
            const synonym = pick(await catalog.synonyms(schema, name));
            return operation === "create"
                ? text.scriptSynonymCreate(synonym)
                : text.scriptSynonymDrop(schema, name);
        }
        default:
            throw new Error(`Cannot script '${node.label}' as ${operation}.`);
    }
}

function scriptModule(module: text.ModuleRow, operation: ScriptOperation): string {
    if (operation === "create") return text.scriptModuleCreate(module);
    if (operation === "alter") return text.scriptModuleAlter(module);
    return text.scriptModuleDrop(module);
}

/** Index or key of a table (or index of a view): found through its parent. */
async function scriptTableChild(
    catalog: ScriptCatalog,
    node: ObjectNode,
    operation: ScriptOperation,
    objectId: (schema: string, name: string) => Promise<number>,
): Promise<string> {
    const metadata = node.metadata!;
    const schema = metadata.schema ?? "";
    const parent = metadata.parentName;
    if (!parent) throw new Error(`Cannot script '${node.label}' as ${operation}.`);
    const id = await objectId(schema, parent);
    const gone = new Error(`'${node.label}' does not exist anymore.`);

    if (metadata.metadataTypeName === "ForeignKey") {
        const [table] = await catalog.tables({ objectId: id });
        const fk = table?.foreignKeys.find((f) => f.name === metadata.name);
        if (!fk) throw gone;
        return operation === "create"
            ? text.scriptForeignKeyCreate(schema, parent, fk)
            : text.scriptConstraintDrop(schema, parent, fk.name);
    }
    const onView = metadata.parentTypeName === "View";
    const indexes = onView
        ? ((await catalog.view(id))?.indexes ?? [])
        : ((await catalog.tables({ objectId: id }))[0]?.indexes ?? []);
    const index = indexes.find((i) => i.name === metadata.name);
    if (!index) throw gone;
    return operation === "create"
        ? text.scriptIndexCreate(schema, parent, index, onView)
        : text.scriptIndexDrop(schema, parent, index);
}

async function scriptSelect(
    node: ObjectNode,
    database: string,
    runQuery: MetadataQueryRunner,
): Promise<string> {
    const schema = node.metadata?.schema;
    const name = node.metadata?.name;
    if (!schema || !name) throw new Error(`Cannot script '${node.label}' as select.`);
    const rows = await runQuery(database, selectableColumnsQuery(quoteIdentifier(database)), {
        schema,
        name,
    });
    if (rows.length === 0) {
        throw new Error(`'${schema}.${name}' has no column to select.`);
    }
    return buildSelectScript(
        database,
        schema,
        name,
        rows.map((row) => row.name),
    );
}
