/**
 * Every SQL query used by the Object Explorer, in one place.
 *
 * Database-level queries take `db`, the QUOTED database name (e.g. "[yast]"), and read its catalog
 * through three-part names ([yast].sys.tables), so the session's current database is never changed.
 * Queries that target one table/view take the parameters @schema and @name.
 *
 * Sorting is done in JavaScript (see objectExplorer.ts) so the order does not depend on a collation,
 * except for columns, which keep their position in the table.
 */

// -- Server level -----------------------------------------------------------

export const serverQueries = {
    /** One row: serverName, version, edition, engineEdition, loginName. */
    serverInfo: `
        SELECT
            @@SERVERNAME AS serverName,
            CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
            CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
            CAST(SERVERPROPERTY('EngineEdition') AS int) AS engineEdition,
            SUSER_SNAME() AS loginName`,

    databases: `SELECT name, database_id AS databaseId FROM sys.databases`,

    logins: `
        SELECT name
        FROM sys.server_principals
        WHERE type IN ('S', 'U', 'G', 'E', 'X')`, // certificate / asymmetric-key logins are internal and not listed

    serverRoles: `SELECT name FROM sys.server_principals WHERE type = 'R'`,
};

// -- Database level: top-level folders --------------------------------------

export const databaseQueries = {
    /** schemaName, name, temporalType (0 = regular, 2 = system-versioned). */
    tables: (db: string) => `
        SELECT s.name AS schemaName, t.name, t.temporal_type AS temporalType
        FROM ${db}.sys.tables t
        JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
        WHERE t.is_ms_shipped = 0 AND t.is_external = 0`,

    views: (db: string) => `
        SELECT s.name AS schemaName, v.name
        FROM ${db}.sys.views v
        JOIN ${db}.sys.schemas s ON s.schema_id = v.schema_id
        WHERE v.is_ms_shipped = 0`,

    synonyms: (db: string) => `
        SELECT s.name AS schemaName, y.name
        FROM ${db}.sys.synonyms y
        JOIN ${db}.sys.schemas s ON s.schema_id = y.schema_id`,

    // -- Programmability

    storedProcedures: (db: string) => `
        SELECT s.name AS schemaName, p.name
        FROM ${db}.sys.procedures p
        JOIN ${db}.sys.schemas s ON s.schema_id = p.schema_id
        WHERE p.is_ms_shipped = 0`,

    /** objectType is the sys.objects type code: TF/IF/FT table-valued, FN/FS scalar, AF aggregate. */
    functions: (db: string) => `
        SELECT s.name AS schemaName, o.name, RTRIM(o.type) AS objectType
        FROM ${db}.sys.objects o
        JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.is_ms_shipped = 0 AND o.type IN ('TF', 'IF', 'FT', 'FN', 'FS', 'AF')`,

    databaseTriggers: (db: string) => `
        SELECT name, is_disabled AS isDisabled
        FROM ${db}.sys.triggers
        WHERE parent_class = 0`,

    userDefinedDataTypes: (db: string) => `
        SELECT s.name AS schemaName, t.name
        FROM ${db}.sys.types t
        JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
        WHERE t.is_user_defined = 1 AND t.is_table_type = 0 AND t.is_assembly_type = 0`,

    userDefinedTableTypes: (db: string) => `
        SELECT s.name AS schemaName, t.name
        FROM ${db}.sys.table_types t
        JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id`,

    sequences: (db: string) => `
        SELECT s.name AS schemaName, q.name
        FROM ${db}.sys.sequences q
        JOIN ${db}.sys.schemas s ON s.schema_id = q.schema_id`,

    // -- Security

    users: (db: string) => `
        SELECT name FROM ${db}.sys.database_principals
        WHERE type IN ('S', 'U', 'G', 'E', 'X', 'C', 'K')`,

    databaseRoles: (db: string) =>
        `SELECT name FROM ${db}.sys.database_principals WHERE type = 'R'`,

    applicationRoles: (db: string) =>
        `SELECT name FROM ${db}.sys.database_principals WHERE type = 'A'`,

    schemas: (db: string) => `SELECT name FROM ${db}.sys.schemas`,
};

// -- Inside one table or view (parameters: @schema, @name) -------------------

/** Restricts a query to the object @schema.@name. `parentIdColumn` is the column pointing to the table/view. */
function ofObject(db: string, parentIdColumn: string): string {
    return `
        JOIN ${db}.sys.objects o ON o.object_id = ${parentIdColumn}
        JOIN ${db}.sys.schemas os ON os.schema_id = o.schema_id
        WHERE os.name = @schema AND o.name = @name`;
}

export const objectQueries = {
    /**
     * Columns in table order. typeName / baseTypeName differ for alias types (CREATE TYPE ... FROM),
     * isAliasType tells them apart from system types.
     */
    columns: (db: string) => `
        SELECT
            c.name,
            t.name AS typeName,
            bt.name AS baseTypeName,
            CASE WHEN t.is_user_defined = 1 AND t.is_assembly_type = 0 THEN 1 ELSE 0 END AS isAliasType,
            c.max_length AS maxLength,
            c.precision,
            c.scale,
            c.is_nullable AS isNullable,
            CASE WHEN EXISTS (
                SELECT 1 FROM ${db}.sys.index_columns ic
                JOIN ${db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
            ) THEN 1 ELSE 0 END AS isPrimaryKey,
            CASE WHEN EXISTS (
                SELECT 1 FROM ${db}.sys.foreign_key_columns fkc
                WHERE fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
            ) THEN 1 ELSE 0 END AS isForeignKey
        FROM ${db}.sys.columns c
        JOIN ${db}.sys.types t ON t.user_type_id = c.user_type_id
        LEFT JOIN ${db}.sys.types bt ON bt.user_type_id = t.system_type_id AND bt.system_type_id = bt.user_type_id
        ${ofObject(db, "c.object_id")}
        ORDER BY c.column_id`,

    /** Primary keys and unique constraints (they are indexes). */
    keys: (db: string) => `
        SELECT x.name, x.is_primary_key AS isPrimaryKey
        FROM ${db}.sys.indexes x
        ${ofObject(db, "x.object_id")}
        AND (x.is_primary_key = 1 OR x.is_unique_constraint = 1)`,

    foreignKeys: (db: string) => `
        SELECT f.name
        FROM ${db}.sys.foreign_keys f
        ${ofObject(db, "f.parent_object_id")}`,

    checkConstraints: (db: string) => `
        SELECT k.name
        FROM ${db}.sys.check_constraints k
        ${ofObject(db, "k.parent_object_id")}`,

    /** columnName is needed for the URN of the default constraint. */
    defaultConstraints: (db: string) => `
        SELECT k.name, c.name AS columnName
        FROM ${db}.sys.default_constraints k
        JOIN ${db}.sys.columns c ON c.object_id = k.parent_object_id AND c.column_id = k.parent_column_id
        ${ofObject(db, "k.parent_object_id")}`,

    triggers: (db: string) => `
        SELECT g.name, g.is_disabled AS isDisabled
        FROM ${db}.sys.triggers g
        ${ofObject(db, "g.parent_id")}`,

    /** type: 1 clustered, 2 nonclustered, 3 XML, 4 spatial, 5 clustered columnstore, 6 nonclustered columnstore, 7 hash. */
    indexes: (db: string) => `
        SELECT x.name, x.type, x.is_unique AS isUnique, x.is_primary_key AS isPrimaryKey, x.is_unique_constraint AS isUniqueConstraint
        FROM ${db}.sys.indexes x
        ${ofObject(db, "x.object_id")}
        AND x.type > 0 AND x.is_hypothetical = 0`,

    statistics: (db: string) => `
        SELECT st.name
        FROM ${db}.sys.stats st
        ${ofObject(db, "st.object_id")}`,
};
