/**
 * Catalog queries behind the PostgreSQL scripts: they read one object, or every user object of the
 * database, into the shapes of scriptText.ts.
 *
 * Run them on a client whose search_path is empty (see `useEmptySearchPath`): the server's
 * deparsers (pg_get_expr, pg_get_viewdef...) then qualify every name they print, like pg_dump.
 */

import type { Queryable } from "./catalog";
import type {
    PgArgument,
    PgColumn,
    PgConstraint,
    PgIndex,
    PgRoutine,
    PgSequence,
    PgTable,
    PgTrigger,
    PgType,
    PgView,
} from "./scriptText";

export async function useEmptySearchPath(client: Queryable): Promise<void> {
    await client.query("SELECT pg_catalog.set_config('search_path', '', false)");
}

const qualified = (schemaColumn: string, nameColumn: string) =>
    `pg_catalog.quote_ident(${schemaColumn}) || '.' || pg_catalog.quote_ident(${nameColumn})`;

const comment = (oid: string, catalog: string) =>
    `pg_catalog.quote_literal(pg_catalog.obj_description(${oid}, '${catalog}'))`;

/** Objects of user schemas, not installed by an extension. */
export const isUserObject = (namespace: string, catalog: string, oid: string) => `
    ${namespace} NOT IN ('pg_catalog', 'information_schema') AND ${namespace} NOT LIKE 'pg\\_%'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e
        WHERE e.classid = '${catalog}'::pg_catalog.regclass AND e.objid = ${oid} AND e.deptype = 'e')`;

/** A column of a catalog row that only recent servers have, or 0 (to_jsonb hides its absence). */
const optionalOid = (row: string, column: string) =>
    `COALESCE((pg_catalog.to_jsonb(${row}) ->> '${column}')::pg_catalog.oid, 0)`;

// ---------------------------------------------------------------------------
// Lookups by name (run with the normal search_path: names come from the Object Explorer)
// ---------------------------------------------------------------------------

/** oid of a relation of the given kinds, or undefined. */
export async function findRelation(
    db: Queryable,
    schema: string,
    name: string,
    kinds: string[],
): Promise<number | undefined> {
    const result = await db.query(
        `SELECT c.oid::int8 AS oid FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind::text = ANY($3)`,
        [schema, name, kinds],
    );
    return result.rows[0] ? Number(result.rows[0].oid) : undefined;
}

/** oid of a function or procedure, told apart from its overloads by its identity arguments. */
export async function findRoutine(
    db: Queryable,
    schema: string,
    name: string,
    identityArguments: string,
): Promise<number | undefined> {
    const result = await db.query(
        `SELECT p.oid::int8 AS oid FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = $2
           AND pg_catalog.pg_get_function_identity_arguments(p.oid) = $3`,
        [schema, name, identityArguments],
    );
    return result.rows[0] ? Number(result.rows[0].oid) : undefined;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** One table (with its partitions), or every table that is not a partition. */
export async function loadTables(db: Queryable, oid?: number): Promise<PgTable[]> {
    const relations = await db.query(
        `WITH RECURSIVE wanted AS (
            SELECT c.oid FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind::text IN ('r', 'p')
              AND ${oid === undefined ? `${isUserObject("n.nspname", "pg_class", "c.oid")}` : "c.oid = $1"}
            UNION
            SELECT i.inhrelid FROM pg_catalog.pg_inherits i
            JOIN wanted w ON w.oid = i.inhparent
            JOIN pg_catalog.pg_class p ON p.oid = i.inhrelid AND p.relispartition
         )
         SELECT c.oid::int8 AS oid, ${qualified("n.nspname", "c.relname")} AS qualified_name,
            c.relkind::text AS kind, c.relpersistence = 'u' AS unlogged,
            CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partition_key,
            CASE WHEN c.relispartition THEN (SELECT i.inhparent::int8 FROM pg_catalog.pg_inherits i
                WHERE i.inhrelid = c.oid) END AS parent,
            pg_catalog.pg_get_expr(c.relpartbound, c.oid) AS partition_bound,
            COALESCE(c.reloptions, '{}') AS options,
            c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
            ${comment("c.oid", "pg_class")} AS comment
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid IN (SELECT oid FROM wanted)
         ORDER BY n.nspname, c.relname`,
        oid === undefined ? [] : [oid],
    );
    const oids = relations.rows.map((r) => String(r.oid));
    if (oids.length === 0) return [];
    const [columns, sequences, constraints, indexes, triggers] = [
        await loadColumns(db, oids),
        await loadOwnedSequences(db, oids),
        await loadConstraints(db, oids),
        await loadIndexes(db, oids),
        await loadTriggers(db, oids),
    ];

    const tables = new Map<string, PgTable & { parent: string | null }>();
    for (const row of relations.rows) {
        const key = String(row.oid);
        const own = sequences.filter((s) => s.rel === key);
        const identitySequence = (column: string) =>
            own.find((s) => s.column === column && s.identity)?.sequence ?? null;
        tables.set(key, {
            parent: row.parent === null ? null : String(row.parent),
            oid: Number(row.oid),
            qualifiedName: row.qualified_name,
            kind: row.kind,
            unlogged: row.unlogged,
            partitionKey: row.partition_key,
            partitionOf: null,
            partitionBound: row.partition_bound,
            options: row.options,
            rowSecurity: row.row_security,
            forceRowSecurity: row.force_row_security,
            comment: row.comment,
            columns: columns
                .filter((c) => c.rel === key)
                .map(({ rel: _rel, ...column }) => ({
                    ...column,
                    identitySequence: column.identity === "" ? null : identitySequence(column.name),
                })),
            constraints: constraints.filter((c) => c.rel === key).map(({ rel: _rel, ...c }) => c),
            indexes: indexes.filter((i) => i.rel === key).map(({ rel: _rel, ...i }) => i),
            triggers: triggers.filter((t) => t.rel === key).map(({ rel: _rel, ...t }) => t),
            ownedSequences: own.filter((s) => !s.identity).map((s) => s.sequence),
            partitions: [],
        });
    }
    const roots: PgTable[] = [];
    for (const table of tables.values()) {
        const parent = table.parent === null ? undefined : tables.get(table.parent);
        if (parent) {
            table.partitionOf = parent.qualifiedName;
            parent.partitions.push(table);
        } else if (table.parent === null || oid !== undefined) {
            roots.push(table);
        }
    }
    for (const table of tables.values()) delete (table as { parent?: unknown }).parent;
    // The table asked for comes first; a partition asked alone is written as a partition.
    if (oid !== undefined) {
        const asked = relations.rows.find((r) => Number(r.oid) === oid);
        const table = asked && tables.get(String(asked.oid));
        if (table && asked.parent !== null) {
            const parent = await db.query(
                `SELECT ${qualified("n.nspname", "c.relname")} AS name FROM pg_catalog.pg_class c
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1`,
                [asked.parent],
            );
            table.partitionOf = parent.rows[0]?.name ?? null;
        }
        return table ? [table] : [];
    }
    return roots;
}

async function loadColumns(db: Queryable, oids: string[]) {
    const result = await db.query(
        `SELECT a.attrelid::text AS rel, pg_catalog.quote_ident(a.attname) AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            CASE WHEN a.attcollation <> t.typcollation
                 THEN ${qualified("cn.nspname", "co.collname")} END AS collation,
            a.attnotnull AS not_null,
            CASE WHEN a.attgenerated = '' THEN pg_catalog.pg_get_expr(d.adbin, d.adrelid) END AS default_expression,
            a.attidentity::text AS identity,
            CASE WHEN a.attgenerated <> '' THEN pg_catalog.pg_get_expr(d.adbin, d.adrelid) END AS generated_expression,
            pg_catalog.quote_literal(pg_catalog.col_description(a.attrelid, a.attnum)) AS comment
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
         LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
         WHERE a.attrelid = ANY($1::pg_catalog.oid[]) AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attrelid, a.attnum`,
        [oids],
    );
    return result.rows.map((r): Omit<PgColumn, "identitySequence"> & { rel: string } => ({
        rel: r.rel,
        name: r.name,
        type: r.type,
        collation: r.collation,
        notNull: r.not_null,
        defaultExpression: r.default_expression,
        identity: r.identity,
        generatedExpression: r.generated_expression,
        comment: r.comment,
    }));
}

const SEQUENCE_COLUMNS = `
    s.oid::int8 AS oid, ${qualified("sn.nspname", "s.relname")} AS qualified_name,
    pg_catalog.format_type(sq.seqtypid, NULL) AS type, sq.seqstart::text AS start,
    sq.seqincrement::text AS increment, sq.seqmin::text AS min, sq.seqmax::text AS max,
    sq.seqcache::text AS cache, sq.seqcycle AS cycle,
    ${comment("s.oid", "pg_class")} AS comment`;

function toSequence(row: Record<string, any>, ownedBy: string | null): PgSequence {
    return {
        oid: Number(row.oid),
        qualifiedName: row.qualified_name,
        type: row.type,
        start: row.start,
        increment: row.increment,
        min: row.min,
        max: row.max,
        cache: row.cache,
        cycle: row.cycle,
        ownedBy,
        comment: row.comment,
    };
}

/** Sequences owned by a column: serial ones (deptype a) and identity ones (deptype i). */
async function loadOwnedSequences(db: Queryable, oids: string[]) {
    const result = await db.query(
        `SELECT d.refobjid::text AS rel, pg_catalog.quote_ident(a.attname) AS column_name,
            d.deptype = 'i' AS identity, ${qualified("tn.nspname", "t.relname")} AS table_name,
            ${SEQUENCE_COLUMNS}
         FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_class s ON s.oid = d.objid AND s.relkind = 'S'
         JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
         JOIN pg_catalog.pg_sequence sq ON sq.seqrelid = s.oid
         JOIN pg_catalog.pg_class t ON t.oid = d.refobjid
         JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
         WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
           AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
           AND d.deptype IN ('a', 'i') AND d.refobjid = ANY($1::pg_catalog.oid[])
         ORDER BY s.relname`,
        [oids],
    );
    return result.rows.map((r) => ({
        rel: r.rel as string,
        column: r.column_name as string,
        identity: r.identity as boolean,
        sequence: toSequence(r, `${r.table_name}.${r.column_name}`),
    }));
}

/** The relations' own constraints: not NOT NULL ones, nor those a partition inherits. */
async function loadConstraints(db: Queryable, oids: string[]) {
    const result = await db.query(
        `SELECT k.conrelid::text AS rel, pg_catalog.quote_ident(k.conname) AS name,
            k.contype::text AS type, pg_catalog.pg_get_constraintdef(k.oid) AS definition,
            k.convalidated AS validated, ${comment("k.oid", "pg_constraint")} AS comment
         FROM pg_catalog.pg_constraint k
         WHERE k.conrelid = ANY($1::pg_catalog.oid[]) AND k.contype::text IN ('p', 'u', 'f', 'c', 'x')
           AND k.conislocal AND ${optionalOid("k", "conparentid")} = 0
         ORDER BY k.conrelid, k.conname`,
        [oids],
    );
    return result.rows.map((r): PgConstraint & { rel: string } => ({
        rel: r.rel,
        name: r.name,
        type: r.type,
        definition: r.definition,
        validated: r.validated,
        comment: r.comment,
    }));
}

/** Indexes, except those a partition inherits from its parent's. */
async function loadIndexes(db: Queryable, oids: string[]) {
    const result = await db.query(
        `SELECT x.indrelid::text AS rel, ${qualified("n.nspname", "i.relname")} AS qualified_name,
            pg_catalog.quote_ident(i.relname) AS name,
            pg_catalog.pg_get_indexdef(x.indexrelid) AS definition,
            (SELECT pg_catalog.quote_ident(k.conname) FROM pg_catalog.pg_constraint k
             WHERE k.conindid = x.indexrelid AND k.conrelid = x.indrelid
               AND k.contype::text IN ('p', 'u', 'x')) AS constraint_name,
            ${comment("x.indexrelid", "pg_class")} AS comment
         FROM pg_catalog.pg_index x
         JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
         WHERE x.indrelid = ANY($1::pg_catalog.oid[])
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h WHERE h.inhrelid = x.indexrelid)
         ORDER BY x.indrelid, i.relname`,
        [oids],
    );
    return result.rows.map((r): PgIndex & { rel: string } => ({
        rel: r.rel,
        qualifiedName: r.qualified_name,
        name: r.name,
        definition: r.definition,
        constraintName: r.constraint_name,
        comment: r.comment,
    }));
}

/** User triggers, except the clones a partition gets from its parent's. */
async function loadTriggers(db: Queryable, oids: string[]) {
    const result = await db.query(
        `SELECT t.tgrelid::text AS rel, pg_catalog.quote_ident(t.tgname) AS name,
            pg_catalog.pg_get_triggerdef(t.oid) AS definition, t.tgenabled::text AS enabled,
            ${comment("t.oid", "pg_trigger")} AS comment
         FROM pg_catalog.pg_trigger t
         WHERE t.tgrelid = ANY($1::pg_catalog.oid[]) AND NOT t.tgisinternal
           AND ${optionalOid("t", "tgparentid")} = 0
         ORDER BY t.tgrelid, t.tgname`,
        [oids],
    );
    return result.rows.map((r): PgTrigger & { rel: string } => ({
        rel: r.rel,
        name: r.name,
        definition: r.definition,
        enabled: r.enabled,
        comment: r.comment,
    }));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** One view or materialized view, or all of them. */
export async function loadViews(
    db: Queryable,
    oid?: number,
): Promise<Array<PgView & { oid: number }>> {
    const result = await db.query(
        `SELECT c.oid::int8 AS oid, ${qualified("n.nspname", "c.relname")} AS qualified_name,
            c.relkind = 'm' AS materialized, pg_catalog.pg_get_viewdef(c.oid) AS definition,
            ARRAY(SELECT o FROM unnest(COALESCE(c.reloptions, '{}')) o
                  WHERE o NOT LIKE 'check\\_option=%') AS options,
            (SELECT substr(o, 14) FROM unnest(c.reloptions) o
             WHERE o LIKE 'check\\_option=%') AS check_option,
            c.relispopulated AS populated, ${comment("c.oid", "pg_class")} AS comment,
            ARRAY(SELECT pg_catalog.quote_ident(a.attname) || ' ' ||
                         pg_catalog.quote_literal(pg_catalog.col_description(c.oid, a.attnum))
                  FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attnum > 0
                    AND pg_catalog.col_description(c.oid, a.attnum) IS NOT NULL
                  ORDER BY a.attnum) AS column_comments
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind::text IN ('v', 'm')
           AND ${oid === undefined ? isUserObject("n.nspname", "pg_class", "c.oid") : "c.oid = $1"}
         ORDER BY n.nspname, c.relname`,
        oid === undefined ? [] : [oid],
    );
    const oids = result.rows.map((r) => String(r.oid));
    if (oids.length === 0) return [];
    const indexes = await loadIndexes(db, oids);
    const triggers = await loadTriggers(db, oids);
    return result.rows.map((r) => {
        const key = String(r.oid);
        return {
            oid: Number(r.oid),
            qualifiedName: r.qualified_name,
            materialized: r.materialized,
            definition: r.definition,
            options: r.options,
            checkOption: r.check_option,
            populated: r.populated,
            comment: r.comment,
            // "name 'comment'": the quoted name never contains an unquoted space.
            columnComments: (r.column_comments as string[]).map((text) => {
                const split = splitQuotedName(text);
                return { name: split[0], comment: split[1] };
            }),
            indexes: indexes.filter((i) => i.rel === key).map(({ rel: _rel, ...i }) => i),
            triggers: triggers.filter((t) => t.rel === key).map(({ rel: _rel, ...t }) => t),
        };
    });
}

/** Splits `"a b" 'x'` (a quote_ident name, a space, the rest) into its two parts. */
function splitQuotedName(text: string): [string, string] {
    let i: number;
    if (text.startsWith('"')) {
        i = 1;
        while (i < text.length) {
            if (text[i] === '"' && text[i + 1] === '"') i += 2;
            else if (text[i] === '"') break;
            else i++;
        }
        i++;
    } else {
        i = text.indexOf(" ");
    }
    return [text.slice(0, i), text.slice(i + 1)];
}

// ---------------------------------------------------------------------------
// Functions and procedures
// ---------------------------------------------------------------------------

/** One function or procedure, or all of them (aggregates and window functions excluded). */
export async function loadRoutines(
    db: Queryable,
    oid?: number,
): Promise<Array<PgRoutine & { oid: number }>> {
    const result = await db.query(
        `SELECT p.oid::int8 AS oid, ${qualified("n.nspname", "p.proname")} AS qualified_name,
            pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
            p.prokind = 'p' AS is_procedure, pg_catalog.pg_get_functiondef(p.oid) AS definition,
            ARRAY(SELECT CASE WHEN COALESCE(a, '') = '' THEN '' ELSE pg_catalog.quote_ident(a) END
                  FROM unnest(p.proargnames) WITH ORDINALITY u(a, i) ORDER BY i) AS names,
            COALESCE(p.proargmodes::text[], '{}') AS modes,
            ARRAY(SELECT pg_catalog.format_type(t, NULL)
                  FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::pg_catalog.oid[]))
                       WITH ORDINALITY u(t, i) ORDER BY i) AS types,
            ${comment("p.oid", "pg_proc")} AS comment
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prokind::text IN ('f', 'p')
           AND ${oid === undefined ? isUserObject("n.nspname", "pg_proc", "p.oid") : "p.oid = $1"}
           -- Constructors of range and multirange types come with the type.
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend i
               WHERE i.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND i.objid = p.oid
                 AND i.deptype = 'i')
         ORDER BY n.nspname, p.proname, identity_arguments`,
        oid === undefined ? [] : [oid],
    );
    return result.rows.map((r) => ({
        oid: Number(r.oid),
        qualifiedName: r.qualified_name,
        identityArguments: r.identity_arguments,
        isProcedure: r.is_procedure,
        definition: r.definition,
        arguments: (r.types as string[]).map((type, i): PgArgument => ({
            name: (r.names as string[])[i] ?? "",
            mode: (r.modes as string[])[i] ?? "i",
            type,
        })),
        comment: r.comment,
    }));
}

// ---------------------------------------------------------------------------
// Schemas, sequences, types
// ---------------------------------------------------------------------------

/** User schemas: [quoted name, comment]. */
export async function loadSchemas(
    db: Queryable,
    name?: string,
): Promise<Array<[string, string | null]>> {
    const result = await db.query(
        `SELECT pg_catalog.quote_ident(n.nspname) AS name, ${comment("n.oid", "pg_namespace")} AS comment
         FROM pg_catalog.pg_namespace n
         WHERE ${name === undefined ? isUserObject("n.nspname", "pg_namespace", "n.oid") : "n.nspname = $1"}
         ORDER BY n.nspname`,
        name === undefined ? [] : [name],
    );
    return result.rows.map((r) => [r.name, r.comment]);
}

/** Sequences that no column owns, or one sequence by oid. */
export async function loadSequences(db: Queryable, oid?: number): Promise<PgSequence[]> {
    const result = await db.query(
        `SELECT ${SEQUENCE_COLUMNS},
            (SELECT ${qualified("tn.nspname", "t.relname")} || '.' || pg_catalog.quote_ident(a.attname)
             FROM pg_catalog.pg_depend d
             JOIN pg_catalog.pg_class t ON t.oid = d.refobjid
             JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
             JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
             WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = s.oid
               AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
               AND d.deptype IN ('a', 'i')) AS owned_by
         FROM pg_catalog.pg_class s
         JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
         JOIN pg_catalog.pg_sequence sq ON sq.seqrelid = s.oid
         WHERE ${oid === undefined ? isUserObject("sn.nspname", "pg_class", "s.oid") : "s.oid = $1"}
         ORDER BY sn.nspname, s.relname`,
        oid === undefined ? [] : [oid],
    );
    return result.rows
        .filter((r) => oid !== undefined || r.owned_by === null)
        .map((r) => toSequence(r, r.owned_by));
}

/** Every sequence (owned or not) with its current state, for setval after the data. */
export async function loadSequenceStates(
    db: Queryable,
): Promise<Array<{ qualifiedName: string; literal: string }>> {
    const result = await db.query(
        `SELECT ${qualified("n.nspname", "s.relname")} AS qualified_name
         FROM pg_catalog.pg_class s
         JOIN pg_catalog.pg_namespace n ON n.oid = s.relnamespace
         WHERE s.relkind = 'S' AND ${isUserObject("n.nspname", "pg_class", "s.oid")}
         ORDER BY n.nspname, s.relname`,
    );
    return result.rows.map((r) => ({
        qualifiedName: r.qualified_name,
        literal: `'${String(r.qualified_name).replace(/'/g, "''")}'`,
    }));
}

/** Domains, enums, composite and range types of user schemas, or one of them. */
export async function loadTypes(
    db: Queryable,
    oid?: number,
): Promise<Array<PgType & { oid: number }>> {
    const result = await db.query(
        `SELECT t.oid::int8 AS oid, ${qualified("n.nspname", "t.typname")} AS qualified_name,
            t.typtype::text AS kind,
            CASE t.typtype WHEN 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod)
                           WHEN 'r' THEN (SELECT pg_catalog.format_type(r.rngsubtype, NULL)
                                          FROM pg_catalog.pg_range r WHERE r.rngtypid = t.oid) END AS base_type,
            CASE WHEN t.typtype = 'd' AND t.typcollation <> bt.typcollation
                 THEN ${qualified("cn.nspname", "co.collname")} END AS collation,
            t.typnotnull AS not_null,
            pg_catalog.pg_get_expr(t.typdefaultbin, 0) AS default_expression,
            ARRAY(SELECT pg_catalog.quote_ident(k.conname) || ' ' || pg_catalog.pg_get_constraintdef(k.oid)
                  FROM pg_catalog.pg_constraint k WHERE k.contypid = t.oid AND k.contype = 'c'
                  ORDER BY k.conname) AS constraints,
            ARRAY(SELECT pg_catalog.quote_literal(e.enumlabel) FROM pg_catalog.pg_enum e
                  WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS labels,
            ARRAY(SELECT pg_catalog.quote_ident(a.attname) || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
                  FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
                  ORDER BY a.attnum) AS attributes,
            ARRAY(SELECT 'subtype_diff = ' || r.rngsubdiff::pg_catalog.regproc::text
                  FROM pg_catalog.pg_range r WHERE r.rngtypid = t.oid AND r.rngsubdiff <> 0) AS range_options,
            ${comment("t.oid", "pg_type")} AS comment
         FROM pg_catalog.pg_type t
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         LEFT JOIN pg_catalog.pg_type bt ON bt.oid = t.typbasetype
         LEFT JOIN pg_catalog.pg_collation co ON co.oid = t.typcollation
         LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
         LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
         WHERE (t.typtype::text IN ('d', 'e', 'r') OR (t.typtype = 'c' AND c.relkind = 'c'))
           AND ${oid === undefined ? isUserObject("n.nspname", "pg_type", "t.oid") : "t.oid = $1"}
         ORDER BY n.nspname, t.typname`,
        oid === undefined ? [] : [oid],
    );
    return result.rows.map((r) => ({
        oid: Number(r.oid),
        qualifiedName: r.qualified_name,
        kind: r.kind,
        baseType: r.base_type,
        collation: r.collation,
        notNull: r.not_null,
        defaultExpression: r.default_expression,
        constraints: (r.constraints as string[]).map((text) => splitQuotedName(text)),
        labels: r.labels,
        attributes: (r.attributes as string[]).map((text) => {
            const [name, type] = splitQuotedName(text);
            return { name, type, collation: null };
        }),
        rangeOptions: r.range_options,
        comment: r.comment,
    }));
}

/** oid of a type by name. */
export async function findType(
    db: Queryable,
    schema: string,
    name: string,
): Promise<number | undefined> {
    const result = await db.query(
        `SELECT t.oid::int8 AS oid FROM pg_catalog.pg_type t
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = $1 AND t.typname = $2`,
        [schema, name],
    );
    return result.rows[0] ? Number(result.rows[0].oid) : undefined;
}

/**
 * Dependencies between user objects, from pg_depend, as pairs of keys: "c<oid>" a relation,
 * "p<oid>" a function or procedure, "t<oid>" a type. A default, a check or a rule counts for its
 * relation; foreign keys and indexes are left out (they are created after the data).
 */
export async function loadDependencies(db: Queryable): Promise<Array<[string, string]>> {
    const key = (cls: string, id: string) => `CASE ${cls}
        WHEN 'pg_catalog.pg_class'::pg_catalog.regclass THEN
            (SELECT CASE WHEN c.relkind = 'i' THEN NULL
                         WHEN c.relkind = 'c' THEN 't' || c.reltype
                         ELSE 'c' || c.oid END FROM pg_catalog.pg_class c WHERE c.oid = ${id})
        WHEN 'pg_catalog.pg_rewrite'::pg_catalog.regclass THEN
            (SELECT 'c' || r.ev_class FROM pg_catalog.pg_rewrite r WHERE r.oid = ${id})
        WHEN 'pg_catalog.pg_attrdef'::pg_catalog.regclass THEN
            (SELECT 'c' || a.adrelid FROM pg_catalog.pg_attrdef a WHERE a.oid = ${id})
        WHEN 'pg_catalog.pg_constraint'::pg_catalog.regclass THEN
            (SELECT CASE WHEN k.contype = 'f' THEN NULL WHEN k.conrelid <> 0 THEN 'c' || k.conrelid
                         ELSE 't' || k.contypid END FROM pg_catalog.pg_constraint k WHERE k.oid = ${id})
        WHEN 'pg_catalog.pg_proc'::pg_catalog.regclass THEN 'p' || ${id}
        WHEN 'pg_catalog.pg_type'::pg_catalog.regclass THEN
            (SELECT CASE WHEN t.typrelid <> 0 THEN
                            (SELECT CASE WHEN c.relkind = 'c' THEN 't' || t.oid ELSE 'c' || c.oid END
                             FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid)
                         WHEN t.typelem <> 0 AND t.typcategory = 'A' THEN 't' || t.typelem
                         ELSE 't' || t.oid END FROM pg_catalog.pg_type t WHERE t.oid = ${id})
        END`;
    const result = await db.query(
        `SELECT DISTINCT s.k AS from_key, r.k AS to_key
         FROM pg_catalog.pg_depend d
         CROSS JOIN LATERAL (SELECT ${key("d.classid", "d.objid")} AS k) s
         CROSS JOIN LATERAL (SELECT ${key("d.refclassid", "d.refobjid")} AS k) r
         WHERE d.deptype IN ('n', 'a') AND d.objid >= 16384 AND d.refobjid >= 16384
           AND s.k IS NOT NULL AND r.k IS NOT NULL AND s.k <> r.k`,
    );
    return result.rows.map((r) => [r.from_key, r.to_key]);
}
