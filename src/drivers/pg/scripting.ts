/**
 * "Script as" for PostgreSQL objects: Select, Create, Alter, Drop and Execute.
 *
 * Select has the layout of the SQL Server script (one column per line, leading commas), with LIMIT
 * at the end and no database prefix (a PostgreSQL connection is bound to one database). The other
 * scripts follow pg_dump (scriptText.ts) and are read by scriptCatalog.ts.
 */

import type { ObjectNode, ScriptOperation } from "../types";
import type { Queryable } from "./catalog";
import * as catalog from "./scriptCatalog";
import * as text from "./scriptText";

/** Rows returned by "Select Top 1000". */
export const SELECT_TOP_ROWS = 1000;

/**
 * Identifiers are quoted by the server (quote_ident), which is exact: only names that need
 * quotes get them. System columns (attnum < 0) and dropped columns are not listed.
 */
const relationQuery = `
    SELECT quote_ident(n.nspname) AS schema,
           quote_ident(c.relname) AS name,
           (SELECT coalesce(array_agg(quote_ident(a.attname) ORDER BY a.attnum), '{}')
            FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind::text = ANY('{r,p,v,m,f}')`;

/** Text of the script, from names that are already quoted where needed. */
export function buildSelectScript(schema: string, name: string, columns: string[]): string {
    // A table can have no column at all in PostgreSQL: SELECT * is still valid.
    const list = columns.length > 0 ? columns.join("\n      ,") : "*";
    return `SELECT ${list}\n  FROM ${schema}.${name}\n  LIMIT ${SELECT_TOP_ROWS}`;
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
    Trigger: ["create", "delete"],
    Index: ["create", "delete"],
    Key: ["create", "delete"],
    Schema: ["create", "delete"],
    Sequence: ["create", "delete"],
    UserDefinedDataType: ["create", "delete"],
    UserDefinedType: ["create", "delete"],
};

/**
 * `getClient` gives the Object Explorer's client of a database (Select only reads names);
 * `openClient` a new one, closed afterwards, whose search_path the script may change.
 */
export async function scriptObject(
    node: ObjectNode,
    operation: ScriptOperation,
    getClient: (database: string) => Promise<Queryable>,
    openClient: (database: string) => Promise<Queryable & { end(): Promise<void> }> = async () => {
        throw new Error("No client to script with.");
    },
): Promise<string> {
    const database = node.database ?? node.context?.database;
    const schema = node.metadata?.schema;
    const name = node.metadata?.name;
    if (!SCRIPT_OPERATIONS[node.nodeType]?.includes(operation)) {
        if (operation === "select" || !SCRIPT_OPERATIONS[node.nodeType]) {
            throw new Error(`Cannot script '${node.label}' as ${operation}.`);
        }
        throw new Error(`Scripting a ${node.nodeType} as ${operation} is not supported.`);
    }
    if (!database || !name) throw new Error(`Cannot script '${node.label}' as ${operation}.`);
    if (operation === "select") {
        if (!schema) throw new Error(`Cannot script '${node.label}' as select.`);
        const client = await getClient(database);
        const result = await client.query(relationQuery, [schema, name]);
        if (result.rows.length === 0) {
            throw new Error(`'${schema}.${name}' does not exist anymore.`);
        }
        const row = result.rows[0];
        return buildSelectScript(row.schema, row.name, row.columns);
    }

    const client = await openClient(database);
    try {
        return await scriptWith(client, node, operation);
    } finally {
        await client.end().catch(() => undefined);
    }
}

async function scriptWith(
    client: Queryable,
    node: ObjectNode,
    operation: ScriptOperation,
): Promise<string> {
    const metadata = node.metadata!;
    const schema = metadata.schema ?? "";
    const name = metadata.name;
    const gone = () => new Error(`'${node.label}' does not exist anymore.`);
    const found = <T>(value: T | undefined): T => {
        if (value === undefined) throw gone();
        return value;
    };

    // Names are looked up with the default search_path, then everything is read without one.
    switch (node.nodeType) {
        case "Table": {
            const oid = found(await catalog.findRelation(client, schema, name, ["r", "p"]));
            await catalog.useEmptySearchPath(client);
            const table = found((await catalog.loadTables(client, oid))[0]);
            return operation === "create"
                ? text.scriptTableCreate(table)
                : text.scriptTableDrop(table);
        }
        case "View": {
            const oid = found(await catalog.findRelation(client, schema, name, ["v", "m"]));
            await catalog.useEmptySearchPath(client);
            const view = found((await catalog.loadViews(client, oid))[0]);
            if (operation === "create") return text.scriptViewCreate(view);
            if (operation === "alter") return text.scriptViewAlter(view);
            return text.scriptViewDrop(view);
        }
        case "StoredProcedure":
        case "TableValuedFunction":
        case "ScalarValuedFunction": {
            // The node's label is "name(identity arguments)".
            const label = node.label;
            const args = label.startsWith(`${name}(`) ? label.slice(name.length + 1, -1) : "";
            const oid = found(await catalog.findRoutine(client, schema, name, args));
            await catalog.useEmptySearchPath(client);
            const routine = found((await catalog.loadRoutines(client, oid))[0]);
            if (operation === "create") return text.scriptRoutineCreate(routine);
            if (operation === "alter") return text.scriptRoutineAlter(routine);
            if (operation === "execute") {
                if (!routine.isProcedure) throw new Error(`'${node.label}' is not a procedure.`);
                return text.scriptProcedureExecute(routine);
            }
            return text.scriptRoutineDrop(routine);
        }
        case "Trigger":
        case "Index":
        case "Key": {
            const parent = metadata.parentName;
            if (!parent) throw new Error(`Cannot script '${node.label}' as ${operation}.`);
            const oid = found(
                await catalog.findRelation(client, schema, parent, ["r", "p", "v", "m"]),
            );
            await catalog.useEmptySearchPath(client);
            return scriptTableChild(client, oid, node, operation, gone);
        }
        case "Schema": {
            const [schemaRow] = await catalog.loadSchemas(client, name);
            const [quoted, comment] = found(schemaRow);
            return operation === "create"
                ? text.scriptSchemaCreate(quoted, comment)
                : text.scriptSchemaDrop(quoted);
        }
        case "Sequence": {
            const oid = found(await catalog.findRelation(client, schema, name, ["S"]));
            await catalog.useEmptySearchPath(client);
            const sequence = found((await catalog.loadSequences(client, oid))[0]);
            return operation === "create"
                ? text.scriptSequenceCreate(sequence)
                : text.scriptSequenceDrop(sequence);
        }
        case "UserDefinedDataType":
        case "UserDefinedType": {
            const oid = found(await catalog.findType(client, schema, name));
            await catalog.useEmptySearchPath(client);
            const type = found((await catalog.loadTypes(client, oid))[0]);
            return operation === "create" ? text.scriptTypeCreate(type) : text.scriptTypeDrop(type);
        }
        default:
            throw new Error(`Cannot script '${node.label}' as ${operation}.`);
    }
}

/** Trigger, index or key of a table (or of a view). */
async function scriptTableChild(
    client: Queryable,
    oid: number,
    node: ObjectNode,
    operation: ScriptOperation,
    gone: () => Error,
): Promise<string> {
    const metadata = node.metadata!;
    const quotedName = (
        await client.query("SELECT pg_catalog.quote_ident($1) AS name", [metadata.name])
    ).rows[0].name as string;
    const table = (await catalog.loadTables(client, oid))[0];
    const owner: { qualifiedName: string; triggers: text.PgTrigger[]; indexes: text.PgIndex[] } =
        table ?? (await catalog.loadViews(client, oid))[0];
    if (!owner) throw gone();

    if (node.nodeType === "Trigger") {
        const trigger = owner.triggers.find((t) => t.name === quotedName);
        if (!trigger) throw gone();
        return operation === "create"
            ? text.scriptTriggerCreate(owner.qualifiedName, trigger)
            : text.scriptTriggerDrop(owner.qualifiedName, trigger.name);
    }
    if (node.nodeType === "Key") {
        const constraint = table?.constraints.find((c) => c.name === quotedName);
        if (!table || !constraint) throw gone();
        return operation === "create"
            ? text.scriptConstraintCreate(table, constraint)
            : text.scriptConstraintDrop(table, constraint.name);
    }
    const index = owner.indexes.find((i) => i.name === quotedName);
    if (!index) throw gone();
    if (!table) {
        return operation === "create"
            ? `${index.definition};\n`
            : `DROP INDEX IF EXISTS ${index.qualifiedName};\n`;
    }
    return operation === "create"
        ? text.scriptIndexCreate(table, index)
        : text.scriptIndexDrop(table, index);
}
