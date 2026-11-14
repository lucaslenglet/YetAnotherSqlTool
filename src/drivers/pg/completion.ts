/**
 * Catalog reads for autocompletion. They run on the Object Explorer client of the database, never on
 * the query session, and read pg_catalog directly (information_schema is much slower).
 */

import type { CompletionColumn, CompletionObject } from "../types";
import type { Queryable } from "./catalog";

/** pg_toast and temporary schemas are never offered. */
const VISIBLE_SCHEMA = `n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;
const SYSTEM_SCHEMA = `n.nspname IN ('pg_catalog', 'information_schema')`;

/**
 * Schemas, relations (partitions left out: there can be thousands), sequences, user routines and
 * user types. pg_catalog and information_schema relations are flagged as system; their thousands of
 * functions are left to the built-in function list.
 */
const OBJECTS_QUERY = `
SELECT 'schema' AS kind, NULL AS schema, n.nspname AS name, NULL AS detail,
       false AS returns_table, false AS system
FROM pg_namespace n
WHERE ${VISIBLE_SCHEMA}
UNION ALL
SELECT CASE WHEN c.relkind IN ('v', 'm') THEN 'view'
            WHEN c.relkind = 'S' THEN 'sequence'
            ELSE 'table' END,
       n.nspname, c.relname,
       CASE c.relkind WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table'
                      WHEN 'p' THEN 'partitioned table' END,
       false, ${SYSTEM_SCHEMA}
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S') AND NOT c.relispartition AND ${VISIBLE_SCHEMA}
UNION ALL
SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
       n.nspname, p.proname,
       '(' || pg_get_function_identity_arguments(p.oid) || ')'
           || CASE WHEN p.prokind = 'p' THEN '' ELSE ' RETURNS ' || pg_get_function_result(p.oid) END,
       p.prokind <> 'p' AND (p.proretset OR t.typtype = 'c' OR 't' = ANY(p.proargmodes)),
       false
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_type t ON t.oid = p.prorettype
WHERE NOT ${SYSTEM_SCHEMA} AND ${VISIBLE_SCHEMA}
UNION ALL
SELECT 'type', n.nspname, t.typname,
       CASE t.typtype WHEN 'd' THEN 'domain' WHEN 'e' THEN 'enum' WHEN 'r' THEN 'range'
                      WHEN 'm' THEN 'multirange' ELSE 'composite type' END,
       false, false
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
LEFT JOIN pg_class c ON c.oid = t.typrelid
WHERE NOT ${SYSTEM_SCHEMA} AND ${VISIBLE_SCHEMA}
  AND (t.typtype IN ('d', 'e', 'r', 'm') OR (t.typtype = 'c' AND c.relkind = 'c'))
`;

export async function listCompletionObjects(db: Queryable): Promise<CompletionObject[]> {
    const { rows } = await db.query(OBJECTS_QUERY);
    const objects: CompletionObject[] = [];
    // Overloads share one entry: the first signature, and how many others there are.
    const routines = new Map<string, { object: CompletionObject; overloads: number }>();
    for (const row of rows) {
        const object: CompletionObject = {
            kind: row.kind,
            schema: row.schema ?? undefined,
            name: row.name,
            detail: row.detail ?? undefined,
            returnsTable: row.returns_table || undefined,
            system: row.system || undefined,
        };
        if (row.kind === "function" || row.kind === "procedure") {
            const key = `${row.schema}.${row.name}`;
            const existing = routines.get(key);
            if (existing) {
                existing.overloads++;
                existing.object.returnsTable ||= object.returnsTable;
                continue;
            }
            routines.set(key, { object, overloads: 0 });
        }
        objects.push(object);
    }
    for (const { object, overloads } of routines.values()) {
        if (overloads > 0) {
            object.detail = `${object.detail} (+${overloads} overload${overloads > 1 ? "s" : ""})`;
        }
    }
    return objects;
}

/**
 * Columns of relations, and of functions returning rows (OUT / TABLE parameters, or the row type
 * they return). For overloaded functions, the first one.
 */
const COLUMNS_QUERY = `
WITH r AS (
    SELECT * FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS r(schema, name, idx)
)
SELECT r.idx, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
       NOT a.attnotnull AS nullable, a.attnum AS position
FROM r
JOIN pg_namespace n ON n.nspname = r.schema
JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = r.name
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT r.idx, x.name, format_type(x.type, NULL), true, x.position
FROM r
JOIN pg_namespace n ON n.nspname = r.schema
CROSS JOIN LATERAL (
    SELECT p.* FROM pg_proc p
    WHERE p.pronamespace = n.oid AND p.proname = r.name
    ORDER BY p.oid LIMIT 1
) p
CROSS JOIN LATERAL (
    SELECT u.name, u.type, u.position
    FROM unnest(p.proargnames, p.proallargtypes, p.proargmodes) WITH ORDINALITY AS u(name, type, mode, position)
    WHERE u.mode IN ('o', 'b', 't')
    UNION ALL
    SELECT a.attname, a.atttypid, a.attnum
    FROM pg_type t
    JOIN pg_attribute a ON a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE t.oid = p.prorettype AND p.proallargtypes IS NULL
) x
WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relname = r.name)
ORDER BY 1, 5
`;

export async function listCompletionColumns(
    db: Queryable,
    relations: { schema: string; name: string }[],
): Promise<CompletionColumn[][]> {
    const result: CompletionColumn[][] = relations.map(() => []);
    if (relations.length === 0) return result;
    const { rows } = await db.query(COLUMNS_QUERY, [
        relations.map((r) => r.schema),
        relations.map((r) => r.name),
    ]);
    for (const row of rows) {
        result[Number(row.idx) - 1].push({
            name: row.name,
            dataType: row.type,
            nullable: row.nullable,
        });
    }
    return result;
}

/**
 * Schemas of the effective search_path that exist, in order (current_schemas(false)): the profile's
 * search path when it has one (the query session applies it), else the role's or database's default.
 * A SET search_path run in the editor is not seen: reading it would mean querying the session.
 */
export async function listDefaultSchemas(
    db: Queryable,
    profileSearchPath: string | undefined,
): Promise<string[]> {
    const { rows } = await db.query(
        `SELECT current_user AS "user", current_setting('search_path') AS path,
                array(SELECT nspname FROM pg_namespace)::text[] AS schemas`,
    );
    const { user, path, schemas } = rows[0];
    const existing = new Set<string>(schemas);
    const result: string[] = [];
    for (const entry of parseSearchPath(profileSearchPath ?? path)) {
        const schema = entry === "$user" ? user : entry;
        if (existing.has(schema) && !result.includes(schema)) result.push(schema);
    }
    return result;
}

/** `"$user", public, "My Schema"` -> ["$user", "public", "My Schema"]: unquoted names fold to lower case. */
export function parseSearchPath(path: string): string[] {
    const names: string[] = [];
    const pattern = /\s*(?:"((?:[^"]|"")*)"|([^,]+?))\s*(?:,|$)/gy;
    let match: RegExpExecArray | null;
    while (pattern.lastIndex < path.length && (match = pattern.exec(path))) {
        if (match[1] !== undefined) names.push(match[1].replace(/""/g, '"'));
        else if (match[2]) names.push(match[2].trim().toLowerCase());
    }
    return names;
}
