/**
 * Every catalog query used by the Object Explorer, in one place.
 * They read pg_catalog directly (information_schema is much slower).
 * Each function runs one query on a client connected to the right database.
 */

/** The only thing the catalog needs from a pg Client. */
export interface Queryable {
    query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface RoleRow {
    name: string;
    canLogin: boolean;
}

export interface FunctionRow {
    name: string;
    /** Argument list as pg prints it, e.g. "a integer, b integer". */
    args: string;
    kind: "function" | "aggregate";
    returnsTable: boolean;
}

export interface TypeRow {
    name: string;
    /** "domain" -> UserDefinedDataType icon, others -> UserDefinedType icon. */
    kind: "domain" | "enum" | "composite" | "range";
}

export interface ColumnRow {
    name: string;
    type: string;
    notNull: boolean;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
}

export interface KeyRow {
    name: string;
    kind: "PrimaryKey" | "UniqueKey" | "ForeignKey";
}

export interface IndexRow {
    name: string;
    isUnique: boolean;
    isPrimary: boolean;
}

// ---------------------------------------------------------------------------
// Fragments shared by several queries
// ---------------------------------------------------------------------------

/** Objects installed by CREATE EXTENSION are noise in a user schema. */
export const notOwnedByExtension = (catalog: string, alias: string) => `
    NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = '${catalog}'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'e'
    )`;

// ---------------------------------------------------------------------------
// Server level
// ---------------------------------------------------------------------------

export async function listDatabases(db: Queryable): Promise<string[]> {
    const result = await db.query(
        `SELECT datname FROM pg_database
         WHERE NOT datistemplate AND datallowconn
         ORDER BY datname`,
    );
    return result.rows.map((row) => row.datname);
}

export async function listRoles(db: Queryable): Promise<RoleRow[]> {
    const result = await db.query(`SELECT rolname, rolcanlogin FROM pg_roles ORDER BY rolname`);
    return result.rows.map((row) => ({ name: row.rolname, canLogin: row.rolcanlogin }));
}

// ---------------------------------------------------------------------------
// Database level
// ---------------------------------------------------------------------------

/** pg_toast and temporary schemas are hidden; system schemas are returned only when asked. */
export async function listSchemas(db: Queryable, system: boolean): Promise<string[]> {
    const result = await db.query(
        `SELECT nspname FROM pg_namespace
         WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%'
           AND (nspname IN ('pg_catalog', 'information_schema')) = $1
           AND ($1 OR nspname NOT LIKE 'pg\\_%')
         ORDER BY nspname`,
        [system],
    );
    return result.rows.map((row) => row.nspname);
}

// ---------------------------------------------------------------------------
// Schema level
// ---------------------------------------------------------------------------

/** relkind letters: r table, p partitioned table, v view, m materialized view, S sequence. */
async function listRelations(db: Queryable, schema: string, relkinds: string[]): Promise<string[]> {
    const result = await db.query(
        `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind::text = ANY($2)
         ORDER BY c.relname`,
        [schema, relkinds],
    );
    return result.rows.map((row) => row.relname);
}

export const listTables = (db: Queryable, schema: string) => listRelations(db, schema, ["r", "p"]);
export const listViews = (db: Queryable, schema: string) => listRelations(db, schema, ["v"]);
export const listMaterializedViews = (db: Queryable, schema: string) =>
    listRelations(db, schema, ["m"]);
export const listSequences = (db: Queryable, schema: string) => listRelations(db, schema, ["S"]);

/** prokind letters: f function, w window function, a aggregate, p procedure. */
export async function listFunctions(db: Queryable, schema: string): Promise<FunctionRow[]> {
    const result = await db.query(
        `SELECT p.proname AS name,
                pg_get_function_identity_arguments(p.oid) AS args,
                p.prokind::text AS kind,
                (p.proretset OR t.typtype = 'c' OR 't' = ANY(p.proargmodes)) AS returns_table
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_type t ON t.oid = p.prorettype
         WHERE n.nspname = $1 AND p.prokind::text IN ('f', 'w', 'a') AND ${notOwnedByExtension("pg_proc", "p")}
         ORDER BY p.proname, args`,
        [schema],
    );
    return result.rows.map((row) => ({
        name: row.name,
        args: row.args,
        kind: row.kind === "a" ? "aggregate" : "function",
        returnsTable: row.returns_table,
    }));
}

export async function listProcedures(db: Queryable, schema: string): Promise<FunctionRow[]> {
    const result = await db.query(
        `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.prokind::text = 'p' AND ${notOwnedByExtension("pg_proc", "p")}
         ORDER BY p.proname, args`,
        [schema],
    );
    return result.rows.map((row) => ({
        name: row.name,
        args: row.args,
        kind: "function",
        returnsTable: false,
    }));
}

/** typtype letters: d domain, e enum, c composite, r range. Array types and table row types are skipped. */
export async function listTypes(db: Queryable, schema: string): Promise<TypeRow[]> {
    const result = await db.query(
        `SELECT t.typname AS name, t.typtype::text AS kind
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         LEFT JOIN pg_class c ON c.oid = t.typrelid
         WHERE n.nspname = $1
           AND (t.typtype::text IN ('d', 'e', 'r') OR (t.typtype = 'c' AND c.relkind = 'c'))
           AND ${notOwnedByExtension("pg_type", "t")}
         ORDER BY t.typname`,
        [schema],
    );
    const kinds: Record<string, TypeRow["kind"]> = {
        d: "domain",
        e: "enum",
        c: "composite",
        r: "range",
    };
    return result.rows.map((row) => ({ name: row.name, kind: kinds[row.kind] }));
}

// ---------------------------------------------------------------------------
// Table level (schema = $1, relation = $2)
// ---------------------------------------------------------------------------

export async function listColumns(
    db: Queryable,
    schema: string,
    relation: string,
): Promise<ColumnRow[]> {
    const hasConstraint = (contype: string) => `EXISTS (
        SELECT 1 FROM pg_constraint k
        WHERE k.conrelid = c.oid AND k.contype = '${contype}' AND a.attnum = ANY(k.conkey))`;
    const result = await db.query(
        `SELECT a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS not_null,
                ${hasConstraint("p")} AS is_pk,
                ${hasConstraint("f")} AS is_fk
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [schema, relation],
    );
    return result.rows.map((row) => ({
        name: row.name,
        type: row.type,
        notNull: row.not_null,
        isPrimaryKey: row.is_pk,
        isForeignKey: row.is_fk,
    }));
}

/** Primary, unique and foreign key constraints, primary key first. */
export async function listKeys(db: Queryable, schema: string, relation: string): Promise<KeyRow[]> {
    const result = await db.query(
        `SELECT k.conname AS name, k.contype::text AS kind
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND k.contype::text IN ('p', 'u', 'f')
         ORDER BY CASE k.contype::text WHEN 'p' THEN 0 WHEN 'u' THEN 1 ELSE 2 END, k.conname`,
        [schema, relation],
    );
    const kinds: Record<string, KeyRow["kind"]> = {
        p: "PrimaryKey",
        u: "UniqueKey",
        f: "ForeignKey",
    };
    return result.rows.map((row) => ({ name: row.name, kind: kinds[row.kind] }));
}

/** Names of the CHECK constraints. */
export async function listCheckConstraints(
    db: Queryable,
    schema: string,
    relation: string,
): Promise<string[]> {
    const result = await db.query(
        `SELECT k.conname AS name
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND k.contype::text = 'c'
         ORDER BY k.conname`,
        [schema, relation],
    );
    return result.rows.map((row) => row.name);
}

export async function listIndexes(
    db: Queryable,
    schema: string,
    relation: string,
): Promise<IndexRow[]> {
    const result = await db.query(
        `SELECT i.relname AS name, x.indisunique AS is_unique, x.indisprimary AS is_primary
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class c ON c.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2
         ORDER BY x.indisprimary DESC, i.relname`,
        [schema, relation],
    );
    return result.rows.map((row) => ({
        name: row.name,
        isUnique: row.is_unique,
        isPrimary: row.is_primary,
    }));
}

export async function listTriggers(
    db: Queryable,
    schema: string,
    relation: string,
): Promise<string[]> {
    const result = await db.query(
        `SELECT t.tgname AS name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal
         ORDER BY t.tgname`,
        [schema, relation],
    );
    return result.rows.map((row) => row.name);
}

// ---------------------------------------------------------------------------
// Result column types
// ---------------------------------------------------------------------------

/** oid -> type name as pg prints it ("integer", "timestamp with time zone", "integer[]"...). */
export async function loadTypeNames(db: Queryable): Promise<Map<number, string>> {
    const result = await db.query(
        `SELECT oid::text AS oid, format_type(oid, NULL) AS name FROM pg_type`,
    );
    return new Map(result.rows.map((row) => [Number(row.oid), row.name as string]));
}
