/**
 * Catalog reads for autocompletion (sqltoolsservice's IntelliSense binding queue reads the same
 * through SMO). Every query runs in the context of the editor's database through
 * `EXEC [database].sys.sp_executesql`, on a metadata connection: SCHEMA_NAME(), OBJECT_ID() and the
 * unqualified catalog views then refer to that database, and the session is never touched.
 */

import type { CompletionColumn, CompletionObject, CompletionObjectKind } from "../types";
import { columnTypeText, type Row } from "./objectExplorer";
import { quoteIdentifier } from "./sqlText";

/** Runs `sqlText` in `database` and returns its result sets; rejects when `signal` aborts. */
export type DatabaseQueryRunner = (
    database: string,
    sqlText: string,
    signal: AbortSignal,
) => Promise<Row[][]>;

const OBJECT_KINDS: Record<string, CompletionObjectKind> = {
    U: "table",
    V: "view",
    SN: "synonym",
    SO: "sequence",
    P: "procedure",
    PC: "procedure",
    X: "procedure",
    FN: "function",
    FS: "function",
    AF: "function",
    IF: "function",
    TF: "function",
    FT: "function",
};

const TABLE_FUNCTION_TYPES = ["IF", "TF", "FT"];

const typeColumns = (alias: string, typeAlias: string, baseAlias: string) => `
    ${typeAlias}.name AS typeName,
    ${baseAlias}.name AS baseTypeName,
    CASE WHEN ${typeAlias}.is_user_defined = 1 AND ${typeAlias}.is_assembly_type = 0 THEN 1 ELSE 0 END AS isAliasType,
    ${alias}.max_length AS maxLength,
    ${alias}.precision,
    ${alias}.scale`;

const typeJoins = (alias: string, typeAlias: string, baseAlias: string) => `
    JOIN sys.types ${typeAlias} ON ${typeAlias}.user_type_id = ${alias}.user_type_id
    LEFT JOIN sys.types ${baseAlias} ON ${baseAlias}.user_type_id = ${typeAlias}.system_type_id
        AND ${baseAlias}.system_type_id = ${baseAlias}.user_type_id`;

/**
 * 1. objects: user objects, and the views, table functions and procedures of sys and
 *    INFORMATION_SCHEMA (what users type); 2. parameters of the user routines, for their signature.
 */
const OBJECTS_QUERY = `
SELECT 'schema' AS kind, NULL AS schemaName, s.name, 0 AS isSystem, NULL AS type
FROM sys.schemas s
UNION ALL
SELECT 'database', NULL, d.name, 0, NULL FROM sys.databases d
UNION ALL
SELECT 'object', SCHEMA_NAME(o.schema_id), o.name, o.is_ms_shipped, RTRIM(o.type)
FROM sys.all_objects o
WHERE o.type IN (${Object.keys(OBJECT_KINDS)
    .map((t) => `'${t}'`)
    .join(", ")})
    AND (o.is_ms_shipped = 0 OR o.schema_id IN (SCHEMA_ID('sys'), SCHEMA_ID('INFORMATION_SCHEMA')))
    AND o.parent_object_id = 0
UNION ALL
SELECT 'type', SCHEMA_NAME(t.schema_id), t.name, 0, NULL FROM sys.types t WHERE t.is_user_defined = 1;

SELECT SCHEMA_NAME(o.schema_id) AS schemaName, o.name AS objectName, p.name, p.parameter_id AS parameterId,
    p.is_output AS isOutput, ${typeColumns("p", "t", "bt")}
FROM sys.objects o
JOIN sys.parameters p ON p.object_id = o.object_id
${typeJoins("p", "t", "bt")}
WHERE o.is_ms_shipped = 0 AND o.type IN ('P', 'PC', 'FN', 'FS', 'IF', 'TF', 'FT')
ORDER BY o.object_id, p.parameter_id;`;

export async function listCompletionObjects(
    run: DatabaseQueryRunner,
    database: string,
    signal: AbortSignal,
): Promise<CompletionObject[]> {
    const [objects, parameters] = await run(database, OBJECTS_QUERY, signal);
    const signatures = routineSignatures(parameters);
    return objects.map((row): CompletionObject => {
        if (row.kind !== "object") {
            return {
                kind: row.kind,
                schema: row.kind === "type" ? row.schemaName : undefined,
                name: row.name,
            };
        }
        const kind = OBJECT_KINDS[row.type];
        const returnsTable = TABLE_FUNCTION_TYPES.includes(row.type);
        const signature = signatures.get(`${row.schemaName}.${row.name}`);
        return {
            kind,
            schema: row.schemaName,
            name: row.name,
            detail: signatureDetail(kind, returnsTable, signature),
            returnsTable: returnsTable || undefined,
            system: row.isSystem ? true : undefined,
        };
    });
}

interface Signature {
    parameters: string[];
    returns?: string;
}

function routineSignatures(rows: Row[]): Map<string, Signature> {
    const signatures = new Map<string, Signature>();
    for (const row of rows) {
        const key = `${row.schemaName}.${row.objectName}`;
        let signature = signatures.get(key);
        if (!signature) {
            signature = { parameters: [] };
            signatures.set(key, signature);
        }
        if (row.parameterId === 0) {
            // A scalar function's return value is parameter 0, without a name.
            signature.returns = columnTypeText(row);
        } else {
            signature.parameters.push(
                `${row.name} ${columnTypeText(row)}${row.isOutput ? " OUTPUT" : ""}`,
            );
        }
    }
    return signatures;
}

/** "@before datetime2(7)" for a procedure, "(@id int) RETURNS decimal(10,2)" for a function (sqltoolsservice's). */
function signatureDetail(
    kind: CompletionObjectKind,
    returnsTable: boolean,
    signature: Signature | undefined,
): string | undefined {
    if (kind === "procedure") {
        return signature?.parameters.join(", ") || undefined;
    }
    if (kind !== "function") return undefined;
    const parameters = `(${signature?.parameters.join(", ") ?? ""})`;
    const returns = returnsTable ? "TABLE" : signature?.returns;
    return returns ? `${parameters} RETURNS ${returns}` : parameters;
}

const quoteString = (text: string) => `N'${text.replace(/'/g, "''")}'`;

export async function listCompletionColumns(
    run: DatabaseQueryRunner,
    database: string,
    relations: { schema: string; name: string }[],
    signal: AbortSignal,
): Promise<CompletionColumn[][]> {
    const result: CompletionColumn[][] = relations.map(() => []);
    if (relations.length === 0) return result;
    const values = relations
        .map(
            (r, index) =>
                `(${index}, ${quoteString(quoteIdentifier(r.schema) + "." + quoteIdentifier(r.name))})`,
        )
        .join(", ");
    // A synonym gives the columns of its target when that target is in the same database.
    const [rows] = await run(
        database,
        `
        SELECT r.idx, c.name, c.is_nullable AS isNullable, ${typeColumns("c", "t", "bt")}
        FROM (VALUES ${values}) AS r(idx, objectName)
        CROSS APPLY (
            SELECT COALESCE(
                (SELECT OBJECT_ID(s.base_object_name) FROM sys.synonyms s
                 WHERE s.object_id = OBJECT_ID(r.objectName) AND PARSENAME(s.base_object_name, 3) IS NULL),
                OBJECT_ID(r.objectName)) AS id
        ) o
        JOIN sys.all_columns c ON c.object_id = o.id
        ${typeJoins("c", "t", "bt")}
        ORDER BY r.idx, c.column_id`,
        signal,
    );
    for (const row of rows) {
        result[row.idx].push({
            name: row.name,
            dataType: columnTypeText(row),
            nullable: !!row.isNullable,
        });
    }
    return result;
}

/** The user's default schema, then dbo: the order SQL Server resolves a name without schema. */
export async function listDefaultSchemas(
    run: DatabaseQueryRunner,
    database: string,
    signal: AbortSignal,
): Promise<string[]> {
    const [rows] = await run(database, "SELECT SCHEMA_NAME() AS name", signal);
    const schema: string | null = rows[0]?.name ?? null;
    return schema && schema !== "dbo" ? [schema, "dbo"] : ["dbo"];
}
