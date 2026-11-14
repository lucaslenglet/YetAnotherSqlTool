/**
 * Object information for PostgreSQL, the counterpart of SQL Server's sp_help (SSMS's Alt+F1).
 *
 * The name the user selected is resolved like the server would (to_regclass / to_regtype, and
 * pg_proc through search_path for routines), then only the catalog queries relevant to that kind of
 * object run, each one producing one result set. Topics without rows are handled the way sp_help
 * handles them: a message instead of an empty grid, or a "No identity column defined." row.
 * Everything is read-only and leaves the session (search_path, transaction) as it was.
 */

import type { ExecuteEvent } from "../types";
import { notOwnedByExtension } from "./catalog";
import { rawTextTypes } from "./clients";
import {
    ROWS_PER_CHUNK,
    QUERY_CANCELED,
    canceledMessage,
    columnInfo,
    formatServerText,
    isServerError,
    toCells,
    type ExecutionSession,
    type PgField,
} from "./execute";

type Emit = (event: ExecuteEvent) => void;

interface Rows {
    fields: PgField[];
    rows: (string | null)[][];
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export interface NamePart {
    /** The identifier as the server reads it: unquoted names are folded to lower case. */
    name: string;
    /** The part as it must be written to be parsed back to `name`. */
    text: string;
}

/**
 * Splits what the user selected into identifiers: `public.customers`, `"My Table"`,
 * `Sales."Order Lines"`. A trailing argument list (`my_func(int)`) and semicolon are ignored.
 * Returns undefined when the text is not a (qualified) name.
 */
export function parseObjectName(input: string): NamePart[] | undefined {
    const parts: NamePart[] = [];
    let i = 0;
    const skipSpaces = () => {
        while (i < input.length && /\s/.test(input[i])) i++;
    };
    skipSpaces();
    while (true) {
        let part: NamePart;
        if (input[i] === '"') {
            let name = "";
            i++;
            while (true) {
                if (i >= input.length) return undefined;
                if (input[i] === '"') {
                    if (input[i + 1] === '"') {
                        name += '"';
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                name += input[i++];
            }
            if (name === "") return undefined;
            part = { name, text: quote(name) };
        } else {
            const start = i;
            while (i < input.length && /[\p{L}\p{N}_$]/u.test(input[i])) i++;
            const word = input.slice(start, i);
            if (word === "" || /^[0-9$]/.test(word)) return undefined;
            part = { name: word.replace(/[A-Z]/g, (c) => c.toLowerCase()), text: word };
        }
        parts.push(part);
        skipSpaces();
        if (input[i] === ".") {
            i++;
            skipSpaces();
            continue;
        }
        break;
    }
    if (input[i] === "(") {
        // Argument list: skip to the matching parenthesis (quotes inside are not interpreted: good enough).
        let depth = 0;
        for (; i < input.length; i++) {
            if (input[i] === "(") depth++;
            else if (input[i] === ")" && --depth === 0) {
                i++;
                break;
            }
        }
        if (depth !== 0) return undefined;
        skipSpaces();
    }
    while (input[i] === ";") {
        i++;
        skipSpaces();
    }
    return i === input.length ? parts : undefined;
}

function quote(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Catalog queries. $1 is the oid (as text) of the object; see each one for the others.
// ---------------------------------------------------------------------------

const RELKIND_TYPES: Record<string, string> = {
    r: "table",
    p: "partitioned table",
    f: "foreign table",
    m: "materialized view",
    v: "view",
    S: "sequence",
    i: "index",
    I: "partitioned index",
    c: "composite type",
};

const TYPTYPE_TYPES: Record<string, string> = {
    b: "base type",
    c: "composite type",
    d: "domain",
    e: "enum type",
    r: "range type",
    m: "multirange type",
    p: "pseudo-type",
};

const sql = {
    resolveRelation: `
        SELECT c.oid::text AS oid, c.relkind::text AS relkind
        FROM pg_class c WHERE c.oid = to_regclass($1::text)`,

    resolveType: `
        SELECT t.oid::text AS oid, t.typtype::text AS typtype
        FROM pg_type t WHERE t.oid = to_regtype($1::text)`,

    /** $1: schema (null = visible through search_path), $2: routine name. */
    resolveRoutines: `
        SELECT p.oid::text AS oid
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = $2::text
          AND (CASE WHEN $1::text IS NULL THEN pg_function_is_visible(p.oid) ELSE n.nspname = $1::text END)
        ORDER BY n.nspname, pg_get_function_identity_arguments(p.oid)`,

    /** Objects of the current database outside the system schemas. */
    databaseObjects: `
        SELECT n.nspname::text AS "Schema", o.name AS "Name", o.owner AS "Owner", o.type AS "Object_type"
        FROM (
            SELECT c.relnamespace AS ns, c.relname::text AS name, pg_get_userbyid(c.relowner)::text AS owner,
                   CASE c.relkind::text WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table'
                        WHEN 'f' THEN 'foreign table' WHEN 'm' THEN 'materialized view'
                        WHEN 'v' THEN 'view' WHEN 'S' THEN 'sequence' END AS type
            FROM pg_class c
            WHERE c.relkind::text IN ('r', 'p', 'f', 'm', 'v', 'S') AND ${notOwnedByExtension("pg_class", "c")}
            UNION ALL
            SELECT p.pronamespace, p.proname::text, pg_get_userbyid(p.proowner)::text,
                   CASE p.prokind::text WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate function'
                        WHEN 'w' THEN 'window function' ELSE 'function' END
            FROM pg_proc p
            WHERE ${notOwnedByExtension("pg_proc", "p")}
        ) o
        JOIN pg_namespace n ON n.oid = o.ns
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
          AND (n.nspname !~ '^pg_temp_' OR n.oid = pg_my_temp_schema())
        ORDER BY n.nspname, o.name, o.type`,

    /** User-defined types of the current database (second grid of sp_help without argument). */
    databaseTypes: `
        SELECT n.nspname::text AS "Schema", t.typname::text AS "Type_name",
               pg_get_userbyid(t.typowner)::text AS "Owner",
               CASE t.typtype::text WHEN 'd' THEN 'domain' WHEN 'e' THEN 'enum' WHEN 'c' THEN 'composite'
                    WHEN 'r' THEN 'range' ELSE 'base' END AS "Kind",
               CASE WHEN t.typtype::text = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS "Base_type"
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        LEFT JOIN pg_class c ON c.oid = t.typrelid
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
          AND (n.nspname !~ '^pg_temp_' OR n.oid = pg_my_temp_schema())
          AND (t.typtype::text IN ('d', 'e', 'r')
               OR (t.typtype::text = 'c' AND c.relkind::text = 'c')
               OR (t.typtype::text = 'b' AND t.typcategory::text <> 'A'))
          AND ${notOwnedByExtension("pg_type", "t")}
        ORDER BY n.nspname, t.typname`,

    relationGeneral: `
        SELECT n.nspname::text AS "Schema", c.relname::text AS "Name",
               pg_get_userbyid(c.relowner)::text AS "Owner", $2::text AS "Type",
               obj_description(c.oid, 'pg_class') AS "Comment"
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = $1::oid`,

    columns: `
        SELECT a.attname::text AS "Column_name",
               format_type(a.atttypid, a.atttypmod) AS "Type",
               CASE WHEN a.attgenerated::text <> '' THEN 'yes' ELSE 'no' END AS "Computed",
               CASE WHEN a.attnotnull THEN 'no' ELSE 'yes' END AS "Nullable",
               pg_get_expr(d.adbin, d.adrelid) AS "Default",
               (SELECT k.collname::text FROM pg_collation k WHERE k.oid = a.attcollation AND a.attcollation <> 0) AS "Collation",
               col_description(a.attrelid, a.attnum) AS "Comment"
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,

    identity: `
        SELECT a.attname::text AS "Identity",
               CASE a.attidentity::text WHEN 'a' THEN 'ALWAYS' WHEN 'd' THEN 'BY DEFAULT' ELSE 'serial' END AS "Generation",
               s.seqstart AS "Seed", s.seqincrement AS "Increment", dep.objid::regclass::text AS "Sequence"
        FROM pg_attribute a
        JOIN LATERAL (
            SELECT d.objid FROM pg_depend d
            WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
              AND d.refobjid = a.attrelid AND d.refobjsubid = a.attnum AND d.deptype IN ('i', 'a')
            LIMIT 1
        ) dep ON true
        JOIN pg_sequence s ON s.seqrelid = dep.objid
        WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
          AND (a.attidentity::text <> '' OR EXISTS (
              SELECT 1 FROM pg_attrdef ad
              WHERE ad.adrelid = a.attrelid AND ad.adnum = a.attnum
                AND pg_get_expr(ad.adbin, ad.adrelid) LIKE 'nextval(%'))
        ORDER BY a.attnum`,

    noIdentity: `
        SELECT 'No identity column defined.'::text AS "Identity", NULL::text AS "Generation",
               NULL::bigint AS "Seed", NULL::bigint AS "Increment", NULL::text AS "Sequence"`,

    /** $1: oid of the table, or of the index when `indexes(true)` is used. */
    indexes: (onlyOneIndex: boolean) => `
        SELECT ic.relname::text AS index_name,
               concat_ws(', ', am.amname::text,
                   CASE WHEN i.indisunique THEN
                        CASE WHEN EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype::text = 'u')
                             THEN 'unique key' ELSE 'unique' END END,
                   CASE WHEN i.indisprimary THEN 'primary key' END,
                   CASE WHEN i.indpred IS NOT NULL THEN 'partial' END,
                   CASE WHEN NOT i.indisvalid THEN 'invalid' END) AS index_description,
               (SELECT string_agg(pg_get_indexdef(i.indexrelid, k, true)
                                  || CASE WHEN (i.indoption[k - 1] & 1) = 1 THEN '(-)' ELSE '' END, ', ' ORDER BY k)
                FROM generate_series(1, i.indnkeyatts::int) k) AS index_keys
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_am am ON am.oid = ic.relam
        WHERE ${onlyOneIndex ? "i.indexrelid" : "i.indrelid"} = $1::oid
        ORDER BY ic.relname`,

    constraints: `
        SELECT type AS constraint_type, name AS constraint_name, delete_action, update_action,
               status_validated, keys AS constraint_keys
        FROM (
            SELECT c.oid, 0 AS sub, c.conname::text AS sort_name, c.contype::text AS kind,
                   CASE c.contype::text WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE' WHEN 'f' THEN 'FOREIGN KEY'
                        WHEN 'x' THEN 'EXCLUDE' WHEN 't' THEN 'TRIGGER'
                        WHEN 'c' THEN CASE WHEN cardinality(c.conkey) = 1
                             THEN 'CHECK on column ' || (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1])
                             ELSE 'CHECK Table Level' END END AS type,
                   c.conname::text AS name,
                   CASE WHEN c.contype::text = 'f' THEN CASE c.confdeltype::text WHEN 'a' THEN 'No Action' WHEN 'r' THEN 'Restrict'
                        WHEN 'c' THEN 'Cascade' WHEN 'n' THEN 'Set Null' WHEN 'd' THEN 'Set Default' END ELSE '(n/a)' END AS delete_action,
                   CASE WHEN c.contype::text = 'f' THEN CASE c.confupdtype::text WHEN 'a' THEN 'No Action' WHEN 'r' THEN 'Restrict'
                        WHEN 'c' THEN 'Cascade' WHEN 'n' THEN 'Set Null' WHEN 'd' THEN 'Set Default' END ELSE '(n/a)' END AS update_action,
                   CASE WHEN c.convalidated THEN 'Validated' ELSE 'Not validated' END AS status_validated,
                   CASE WHEN c.contype::text = 'c' THEN pg_get_expr(c.conbin, c.conrelid)
                        WHEN c.contype::text = 'x' THEN pg_get_constraintdef(c.oid)
                        ELSE (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                              FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) END AS keys
            FROM pg_constraint c WHERE c.conrelid = $1::oid
            UNION ALL
            SELECT c.oid, 1, c.conname::text, 'f', '', '', '', '', '',
                   'REFERENCES ' || rn.nspname || '.' || rc.relname || ' ('
                   || (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                       FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                       JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) || ')'
            FROM pg_constraint c
            JOIN pg_class rc ON rc.oid = c.confrelid
            JOIN pg_namespace rn ON rn.oid = rc.relnamespace
            WHERE c.conrelid = $1::oid AND c.contype::text = 'f'
        ) q
        ORDER BY strpos('pufcxt', kind), sort_name, oid, sub`,

    referencedByForeignKeys: `
        SELECT n.nspname || '.' || t.relname || ': ' || c.conname AS "Table is referenced by foreign key"
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype::text = 'f' AND c.confrelid = $1::oid
        ORDER BY 1`,

    referencedByViews: `
        SELECT DISTINCT n.nspname || '.' || v.relname AS "Table is referenced by views"
        FROM pg_depend d
        JOIN pg_rewrite r ON r.oid = d.objid
        JOIN pg_class v ON v.oid = r.ev_class
        JOIN pg_namespace n ON n.oid = v.relnamespace
        WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
          AND d.refobjid = $1::oid AND v.oid <> $1::oid AND v.relkind::text IN ('v', 'm')
        ORDER BY 1`,

    sequence: `
        SELECT format_type(s.seqtypid, NULL) AS "Data_type", s.seqstart AS "Start_value",
               s.seqmin AS "Minimum_value", s.seqmax AS "Maximum_value", s.seqincrement AS "Increment",
               CASE WHEN s.seqcycle THEN 'yes' ELSE 'no' END AS "Cycle", s.seqcache AS "Cache_size",
               pg_sequence_last_value(s.seqrelid) AS "Last_value",
               (SELECT n.nspname || '.' || t.relname || '.' || a.attname
                FROM pg_depend d
                JOIN pg_class t ON t.oid = d.refobjid
                JOIN pg_namespace n ON n.oid = t.relnamespace
                JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
                  AND d.objid = s.seqrelid AND d.deptype IN ('a', 'i') AND d.refobjsubid > 0
                LIMIT 1) AS "Owned_by"
        FROM pg_sequence s WHERE s.seqrelid = $1::oid`,

    typeGeneral: `
        SELECT n.nspname::text AS "Schema", t.typname::text AS "Name",
               pg_get_userbyid(t.typowner)::text AS "Owner", $2::text AS "Type",
               obj_description(t.oid, 'pg_type') AS "Comment"
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.oid = $1::oid`,

    domain: `
        SELECT format_type(t.typbasetype, t.typtypmod) AS "Base_type",
               CASE WHEN t.typnotnull THEN 'no' ELSE 'yes' END AS "Nullable",
               t.typdefault AS "Default",
               (SELECT k.collname::text FROM pg_collation k WHERE k.oid = t.typcollation AND t.typcollation <> 0) AS "Collation"
        FROM pg_type t WHERE t.oid = $1::oid`,

    domainConstraints: `
        SELECT c.conname::text AS constraint_name, pg_get_constraintdef(c.oid) AS constraint_definition
        FROM pg_constraint c WHERE c.contypid = $1::oid ORDER BY c.conname`,

    enumLabels: `
        SELECT e.enumsortorder::float8 AS "Label_order", e.enumlabel::text AS "Label"
        FROM pg_enum e WHERE e.enumtypid = $1::oid ORDER BY e.enumsortorder`,

    /** Attributes of a composite type: the columns query, on the type's pg_class entry. */
    compositeClass: `SELECT t.typrelid::text AS oid FROM pg_type t WHERE t.oid = $1::oid`,

    range: `
        SELECT format_type(r.rngsubtype, NULL) AS "Subtype",
               (SELECT k.collname::text FROM pg_collation k WHERE k.oid = r.rngcollation AND r.rngcollation <> 0) AS "Collation"
        FROM pg_range r WHERE r.rngtypid = $1::oid`,

    routineGeneral: `
        SELECT n.nspname::text AS "Schema", p.proname::text AS "Name",
               pg_get_userbyid(p.proowner)::text AS "Owner",
               CASE p.prokind::text WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate function'
                    WHEN 'w' THEN 'window function' ELSE 'function' END AS "Type",
               pg_get_function_identity_arguments(p.oid) AS "Arguments",
               CASE WHEN p.prokind::text = 'p' THEN NULL ELSE pg_get_function_result(p.oid) END AS "Returns",
               l.lanname::text AS "Language", obj_description(p.oid, 'pg_proc') AS "Comment"
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
        WHERE p.oid = ANY ($1::oid[])
        ORDER BY n.nspname, pg_get_function_identity_arguments(p.oid)`,

    routineParameters: `
        SELECT "Arguments", "Parameter_name", "Type", "Mode", "Param_order" FROM (
            SELECT p.oid, pg_get_function_identity_arguments(p.oid) AS "Arguments",
                   coalesce(p.proargnames[a.ord], '') AS "Parameter_name",
                   format_type(a.type, NULL) AS "Type",
                   CASE coalesce(p.proargmodes[a.ord]::text, 'i') WHEN 'i' THEN 'IN' WHEN 'o' THEN 'OUT'
                        WHEN 'b' THEN 'INOUT' WHEN 'v' THEN 'VARIADIC' WHEN 't' THEN 'TABLE' END AS "Mode",
                   a.ord::int AS "Param_order"
            FROM pg_proc p
            CROSS JOIN LATERAL unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS a(type, ord)
            WHERE p.oid = ANY ($1::oid[])
            UNION ALL
            SELECT p.oid, pg_get_function_identity_arguments(p.oid), '',
                   pg_get_function_result(p.oid), 'RETURN', 0
            FROM pg_proc p WHERE p.oid = ANY ($1::oid[]) AND p.prokind::text <> 'p'
        ) q
        ORDER BY "Arguments", oid, "Param_order"`,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Reports the information about `objectName` (or, without a name, the objects of the current
 * database) as result sets and messages, like `execute` does.
 */
export async function describePgObject(
    session: ExecutionSession,
    database: string,
    objectName: string | undefined,
    onEvent: Emit,
    signal: AbortSignal,
): Promise<void> {
    let canceled = false;
    const onAbort = () => {
        canceled = true;
        session.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort);

    const info = new Describer(session, database, onEvent, signal);
    try {
        if (signal.aborted) {
            onEvent(canceledMessage());
            return;
        }
        if (objectName === undefined) {
            await info.listDatabaseObjects();
        } else {
            await info.describe(objectName);
        }
        if (signal.aborted) onEvent(canceledMessage());
    } catch (error) {
        if (!isServerError(error)) throw error;
        if (error.code === QUERY_CANCELED && canceled) {
            onEvent(canceledMessage());
        } else {
            onEvent({ type: "message", text: formatServerText("ERROR", error), isError: true });
        }
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

class Describer {
    constructor(
        private readonly session: ExecutionSession,
        private readonly database: string,
        private readonly emit: Emit,
        private readonly signal: AbortSignal,
    ) {}

    async listDatabaseObjects(): Promise<void> {
        await this.grid(sql.databaseObjects);
        await this.grid(sql.databaseTypes);
    }

    async describe(objectName: string): Promise<void> {
        const parts = parseObjectName(objectName);
        // database.schema.name is accepted when the database is the current one.
        const qualified =
            parts && parts.length === 3 && parts[0].name === this.database ? parts.slice(1) : parts;
        if (!qualified || qualified.length > 2) return this.unknown(objectName);
        const text = qualified.map((part) => part.text).join(".");

        const relation = (await this.query(sql.resolveRelation, [text])).rows[0];
        if (relation) return this.describeRelation(relation[0]!, relation[1]!, objectName);

        const routines = await this.query(sql.resolveRoutines, [
            qualified.length === 2 ? qualified[0].name : null,
            qualified[qualified.length - 1].name,
        ]);
        if (routines.rows.length > 0) {
            return this.describeRoutines(routines.rows.map((row) => row[0]!));
        }

        const type = (await this.query(sql.resolveType, [text])).rows[0];
        if (type) return this.describeType(type[0]!, type[1]!);

        return this.unknown(objectName);
    }

    // -- relations ------------------------------------------------------------

    private async describeRelation(oid: string, relkind: string, name: string): Promise<void> {
        await this.grid(sql.relationGeneral, [oid, RELKIND_TYPES[relkind] ?? "relation"]);
        switch (relkind) {
            case "r":
            case "p":
            case "f":
            case "m":
                await this.grid(sql.columns, [oid]);
                await this.grid(sql.identity, [oid], sql.noIdentity);
                await this.grid(
                    sql.indexes(false),
                    [oid],
                    undefined,
                    `The object '${name}' does not have any indexes, or you do not have permissions.`,
                );
                await this.grid(
                    sql.constraints,
                    [oid],
                    undefined,
                    `No constraints are defined on object '${name}', or you do not have permissions.`,
                );
                await this.grid(
                    sql.referencedByForeignKeys,
                    [oid],
                    undefined,
                    `No foreign keys reference table '${name}', or you do not have permissions on referencing tables.`,
                );
                await this.grid(
                    sql.referencedByViews,
                    [oid],
                    undefined,
                    `No views reference table '${name}'.`,
                );
                return;
            case "v":
            case "c":
                await this.grid(sql.columns, [oid]);
                return;
            case "S":
                await this.grid(sql.sequence, [oid]);
                return;
            case "i":
            case "I":
                await this.grid(sql.indexes(true), [oid]);
                return;
        }
    }

    // -- routines -------------------------------------------------------------

    private async describeRoutines(oids: string[]): Promise<void> {
        const literal = `{${oids.join(",")}}`;
        await this.grid(sql.routineGeneral, [literal]);
        await this.grid(sql.routineParameters, [literal]);
    }

    // -- types ----------------------------------------------------------------

    private async describeType(oid: string, typtype: string): Promise<void> {
        await this.grid(sql.typeGeneral, [oid, TYPTYPE_TYPES[typtype] ?? "type"]);
        switch (typtype) {
            case "d":
                await this.grid(sql.domain, [oid]);
                await this.grid(sql.domainConstraints, [oid]);
                return;
            case "e":
                await this.grid(sql.enumLabels, [oid]);
                return;
            case "c": {
                const relation = (await this.query(sql.compositeClass, [oid])).rows[0];
                if (relation) await this.grid(sql.columns, [relation[0]]);
                return;
            }
            case "r":
                await this.grid(sql.range, [oid]);
                return;
        }
    }

    // -- output ---------------------------------------------------------------

    private unknown(name: string): void {
        this.emit({
            type: "message",
            text: `ERROR:  The object '${name}' does not exist in database '${this.database}' or is invalid for this operation.`,
            isError: true,
        });
    }

    private query(text: string, values: unknown[] = []): Promise<Rows> {
        return this.session.client.query({
            text,
            values,
            rowMode: "array",
            types: rawTextTypes,
        }) as unknown as Promise<Rows>;
    }

    /**
     * Runs a query and sends it as one result set. When it returns no row: sends `whenEmpty` instead
     * if given (a one-row result set), else `message` if given, else an empty result set.
     */
    private async grid(
        text: string,
        values: unknown[] = [],
        whenEmpty?: string,
        message?: string,
    ): Promise<void> {
        if (this.signal.aborted) return;
        let result = await this.query(text, values);
        if (result.rows.length === 0 && whenEmpty) result = await this.query(whenEmpty);
        else if (result.rows.length === 0 && message) {
            this.emit({ type: "message", text: message, isError: false });
            return;
        }
        this.emit({
            type: "resultSetStart",
            columns: result.fields.map((field) => columnInfo(field, this.session.typeNames)),
        });
        for (let i = 0; i < result.rows.length; i += ROWS_PER_CHUNK) {
            this.emit({
                type: "rows",
                rows: result.rows.slice(i, i + ROWS_PER_CHUNK).map(toCells),
            });
        }
        this.emit({ type: "resultSetEnd", rowCount: result.rows.length });
    }
}
