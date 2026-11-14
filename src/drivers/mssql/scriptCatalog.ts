/**
 * Catalog queries behind the SQL Server scripts: they read one object, or every user object of a
 * database, into the row shapes of scriptText.ts. Like the Object Explorer queries they use
 * three-part names ([db].sys.x), so they run on any connection without changing its database.
 */

import type { MetadataQueryRunner, Row } from "./objectExplorer";
import type {
    CheckRow,
    ColumnRow,
    ForeignKeyRow,
    IndexColumnRow,
    IndexRow,
    ModuleRow,
    ParameterRow,
    PrincipalRow,
    SequenceRow,
    SynonymRow,
    TableModel,
    TableRow,
    TableTypeModel,
    TypeRow,
    ViewModel,
} from "./scriptText";
import { quoteIdentifier } from "./sqlText";

/** Which objects a query reads: one (by object id) or all the user objects of the database. */
export type Scope = { objectId: number } | "all";

export class ScriptCatalog {
    private readonly db: string;

    constructor(
        private readonly database: string,
        private readonly runQuery: MetadataQueryRunner,
        /** Major version of the server: OPTIMIZE_FOR_SEQUENTIAL_KEY exists from SQL Server 2019 (15). */
        private readonly serverMajorVersion: number,
    ) {
        this.db = quoteIdentifier(database);
    }

    private query(text: string, scope: Scope = "all", extra: Record<string, string> = {}) {
        const parameters = scope === "all" ? extra : { ...extra, objectId: String(scope.objectId) };
        return this.runQuery(this.database, text, parameters);
    }

    /** `column = @objectId`, or the given condition for the whole database. */
    private static filter(column: string, scope: Scope, all: string): string {
        return scope === "all" ? all : `${column} = CAST(@objectId AS int)`;
    }

    /** object_id of a schema-scoped object, or undefined when it does not exist. */
    async findObject(schema: string, name: string): Promise<number | undefined> {
        const rows = await this.runQuery(
            this.database,
            `SELECT o.object_id AS objectId FROM ${this.db}.sys.objects o
             JOIN ${this.db}.sys.schemas s ON s.schema_id = o.schema_id
             WHERE s.name = @schema AND o.name = @name`,
            { schema, name },
        );
        return rows[0]?.objectId;
    }

    // -----------------------------------------------------------------------
    // Tables
    // -----------------------------------------------------------------------

    async tables(scope: Scope): Promise<TableModel[]> {
        const db = this.db;
        const filter = ScriptCatalog.filter("t.object_id", scope, "t.is_ms_shipped = 0");
        const tables = (await this.query(
            `SELECT t.object_id AS objectId, s.name AS schemaName, t.name,
                CAST(t.uses_ansi_nulls AS bit) AS usesAnsiNulls, t.temporal_type AS temporalType,
                hs.name AS historySchema, ht.name AS historyName,
                (SELECT c.name FROM ${db}.sys.periods p JOIN ${db}.sys.columns c
                    ON c.object_id = p.object_id AND c.column_id = p.start_column_id
                 WHERE p.object_id = t.object_id) AS periodStart,
                (SELECT c.name FROM ${db}.sys.periods p JOIN ${db}.sys.columns c
                    ON c.object_id = p.object_id AND c.column_id = p.end_column_id
                 WHERE p.object_id = t.object_id) AS periodEnd,
                ds.name AS dataSpace, ds.type AS dataSpaceType,
                (SELECT c.name FROM ${db}.sys.index_columns ic JOIN ${db}.sys.columns c
                    ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                 WHERE ic.object_id = t.object_id AND ic.index_id = i.index_id
                   AND ic.partition_ordinal = 1) AS partitionColumn,
                lds.name AS lobDataSpace
             FROM ${db}.sys.tables t
             JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
             JOIN ${db}.sys.indexes i ON i.object_id = t.object_id AND i.index_id IN (0, 1)
             LEFT JOIN ${db}.sys.data_spaces ds ON ds.data_space_id = i.data_space_id
             LEFT JOIN ${db}.sys.data_spaces lds ON lds.data_space_id = NULLIF(t.lob_data_space_id, 0)
             LEFT JOIN ${db}.sys.tables ht ON ht.object_id = t.history_table_id
             LEFT JOIN ${db}.sys.schemas hs ON hs.schema_id = ht.schema_id
             WHERE t.is_external = 0 AND ${filter}`,
            scope,
        )) as TableRow[];
        if (tables.length === 0) return [];

        const ofTables =
            scope === "all"
                ? `IN (SELECT object_id FROM ${db}.sys.tables WHERE is_ms_shipped = 0)`
                : "= CAST(@objectId AS int)";
        const columns = await this.columns(ofTables, scope);
        const indexes = await this.indexes(ofTables, scope);
        const foreignKeys = await this.foreignKeys(ofTables, scope);
        const checks = await this.checks(ofTables, scope);
        const triggers = await this.modules(
            scope === "all"
                ? `o.type = 'TR' AND po.type = 'U'`
                : `o.type = 'TR' AND o.parent_object_id = CAST(@objectId AS int)`,
            scope,
        );
        return tables.map((table) => ({
            table,
            columns: columns.filter((c) => c.objectId === table.objectId),
            indexes: indexes.filter((i) => i.objectId === table.objectId),
            foreignKeys: foreignKeys.filter((f) => f.objectId === table.objectId),
            checks: checks.filter((c) => c.objectId === table.objectId),
            triggers: triggers.filter(
                (t) => t.parentName === table.name && t.parentSchema === table.schemaName,
            ),
        }));
    }

    private async columns(ofObjects: string, scope: Scope): Promise<ColumnRow[]> {
        const db = this.db;
        return (await this.query(
            `SELECT c.object_id AS objectId, c.column_id AS columnId, c.name,
                ty.name AS typeName, tys.name AS typeSchema, ty.is_user_defined AS isUserDefined,
                c.max_length AS maxLength, c.precision, c.scale, c.is_nullable AS isNullable,
                c.is_identity AS isIdentity,
                CONVERT(nvarchar(40), ic.seed_value) AS seedValue,
                CONVERT(nvarchar(40), ic.increment_value) AS incrementValue,
                CAST(ISNULL(ic.is_not_for_replication, 0) AS bit) AS notForReplication,
                cc.definition AS computedDefinition,
                CAST(ISNULL(cc.is_persisted, 0) AS bit) AS isPersisted,
                c.is_sparse AS isSparse, c.is_rowguidcol AS isRowGuidCol,
                c.generated_always_type AS generatedAlwaysType, c.is_hidden AS isHidden,
                dc.name AS defaultName, dc.definition AS defaultDefinition,
                CAST(ISNULL(dc.is_system_named, 0) AS bit) AS defaultSystemNamed
             FROM ${db}.sys.columns c
             JOIN ${db}.sys.types ty ON ty.user_type_id = c.user_type_id
             JOIN ${db}.sys.schemas tys ON tys.schema_id = ty.schema_id
             LEFT JOIN ${db}.sys.identity_columns ic
                ON ic.object_id = c.object_id AND ic.column_id = c.column_id
             LEFT JOIN ${db}.sys.computed_columns cc
                ON cc.object_id = c.object_id AND cc.column_id = c.column_id
             LEFT JOIN ${db}.sys.default_constraints dc ON dc.object_id = c.default_object_id
             WHERE c.object_id ${ofObjects}
             ORDER BY c.object_id, c.column_id`,
            scope,
        )) as ColumnRow[];
    }

    private async indexes(ofObjects: string, scope: Scope): Promise<IndexRow[]> {
        const db = this.db;
        const sequentialKey =
            this.serverMajorVersion >= 15 ? "i.optimize_for_sequential_key" : "CAST(NULL AS bit)";
        const indexes = (await this.query(
            `SELECT i.object_id AS objectId, i.index_id AS indexId, i.name, i.type,
                i.is_unique AS isUnique, i.is_primary_key AS isPrimaryKey,
                i.is_unique_constraint AS isUniqueConstraint,
                CAST(ISNULL(kc.is_system_named, 0) AS bit) AS isSystemNamed,
                i.ignore_dup_key AS ignoreDupKey, i.fill_factor AS [fillFactor],
                i.is_padded AS isPadded, i.allow_row_locks AS allowRowLocks,
                i.allow_page_locks AS allowPageLocks,
                CASE WHEN i.has_filter = 1 THEN i.filter_definition END AS filterDefinition,
                CAST(ISNULL(st.no_recompute, 0) AS bit) AS noRecompute,
                ${sequentialKey} AS optimizeForSequentialKey,
                ds.name AS dataSpace, ds.type AS dataSpaceType,
                (SELECT c.name FROM ${db}.sys.index_columns pc JOIN ${db}.sys.columns c
                    ON c.object_id = pc.object_id AND c.column_id = pc.column_id
                 WHERE pc.object_id = i.object_id AND pc.index_id = i.index_id
                   AND pc.partition_ordinal = 1) AS partitionColumn
             FROM ${db}.sys.indexes i
             LEFT JOIN ${db}.sys.key_constraints kc
                ON kc.parent_object_id = i.object_id AND kc.unique_index_id = i.index_id
                AND kc.type IN ('PK', 'UQ')
             LEFT JOIN ${db}.sys.stats st ON st.object_id = i.object_id AND st.stats_id = i.index_id
             LEFT JOIN ${db}.sys.data_spaces ds ON ds.data_space_id = i.data_space_id
             WHERE i.index_id > 0 AND i.is_hypothetical = 0 AND i.object_id ${ofObjects}`,
            scope,
        )) as Omit<IndexRow, "columns">[];
        const columns = (await this.query(
            `SELECT ic.object_id AS objectId, ic.index_id AS indexId, ic.key_ordinal AS keyOrdinal,
                ic.is_descending_key AS isDescending, ic.is_included_column AS isIncluded,
                c.name AS columnName, bt.name AS typeName
             FROM ${db}.sys.index_columns ic
             JOIN ${db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             JOIN ${db}.sys.types bt ON bt.user_type_id = c.system_type_id
             WHERE ic.object_id ${ofObjects} AND (ic.key_ordinal > 0 OR ic.is_included_column = 1)
             ORDER BY ic.object_id, ic.index_id, ic.key_ordinal, ic.index_column_id`,
            scope,
        )) as (IndexColumnRow & { objectId: number; indexId: number })[];
        return indexes.map((index) => ({
            ...index,
            columns: columns
                .filter((c) => c.objectId === index.objectId && c.indexId === index.indexId)
                .map(({ keyOrdinal, isDescending, isIncluded, columnName, typeName }) => ({
                    keyOrdinal,
                    isDescending,
                    isIncluded,
                    columnName,
                    typeName,
                })),
        }));
    }

    private async foreignKeys(ofObjects: string, scope: Scope): Promise<ForeignKeyRow[]> {
        const db = this.db;
        const keys = await this.query(
            `SELECT fk.object_id AS fkId, fk.parent_object_id AS objectId, fk.name,
                fk.is_system_named AS isSystemNamed, fk.is_not_trusted AS isNotTrusted,
                fk.is_disabled AS isDisabled,
                fk.delete_referential_action_desc AS deleteAction,
                fk.update_referential_action_desc AS updateAction,
                rs.name AS refSchema, ro.name AS refTable
             FROM ${db}.sys.foreign_keys fk
             JOIN ${db}.sys.objects ro ON ro.object_id = fk.referenced_object_id
             JOIN ${db}.sys.schemas rs ON rs.schema_id = ro.schema_id
             WHERE fk.parent_object_id ${ofObjects}`,
            scope,
        );
        const columns = await this.query(
            `SELECT fkc.constraint_object_id AS fkId, pc.name AS columnName, rc.name AS refColumnName
             FROM ${db}.sys.foreign_key_columns fkc
             JOIN ${db}.sys.columns pc
                ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
             JOIN ${db}.sys.columns rc
                ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
             WHERE fkc.parent_object_id ${ofObjects}
             ORDER BY fkc.constraint_object_id, fkc.constraint_column_id`,
            scope,
        );
        return keys.map(({ fkId, ...key }: Row) => {
            const own = columns.filter((c) => c.fkId === fkId);
            return {
                ...key,
                columns: own.map((c) => c.columnName),
                refColumns: own.map((c) => c.refColumnName),
            } as ForeignKeyRow;
        });
    }

    private async checks(ofObjects: string, scope: Scope): Promise<CheckRow[]> {
        return (await this.query(
            `SELECT cc.parent_object_id AS objectId, cc.name, cc.is_system_named AS isSystemNamed,
                cc.definition, cc.is_not_trusted AS isNotTrusted, cc.is_disabled AS isDisabled
             FROM ${this.db}.sys.check_constraints cc
             WHERE cc.parent_object_id ${ofObjects}`,
            scope,
        )) as CheckRow[];
    }

    // -----------------------------------------------------------------------
    // Modules
    // -----------------------------------------------------------------------

    /** Views, procedures, functions and DML triggers matching `condition` (on o = sys.objects). */
    async modules(condition: string, scope: Scope = "all"): Promise<ModuleRow[]> {
        const db = this.db;
        return (await this.query(
            `SELECT o.object_id AS objectId, s.name AS schemaName, o.name, RTRIM(o.type) AS type,
                m.definition, CAST(m.uses_ansi_nulls AS bit) AS usesAnsiNulls,
                CAST(m.uses_quoted_identifier AS bit) AS usesQuotedIdentifier,
                ps.name AS parentSchema, po.name AS parentName, RTRIM(po.type) AS parentType,
                CAST(ISNULL(tr.is_disabled, 0) AS bit) AS isDisabled
             FROM ${db}.sys.objects o
             JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
             JOIN ${db}.sys.sql_modules m ON m.object_id = o.object_id
             LEFT JOIN ${db}.sys.objects po ON po.object_id = o.parent_object_id
             LEFT JOIN ${db}.sys.schemas ps ON ps.schema_id = po.schema_id
             LEFT JOIN ${db}.sys.triggers tr ON tr.object_id = o.object_id
             WHERE o.is_ms_shipped = 0 AND ${condition}`,
            scope,
        )) as ModuleRow[];
    }

    async module(objectId: number): Promise<ModuleRow | undefined> {
        return (await this.modules("o.object_id = CAST(@objectId AS int)", { objectId }))[0];
    }

    async view(objectId: number): Promise<ViewModel | undefined> {
        const view = await this.module(objectId);
        if (!view) return undefined;
        const scope = { objectId };
        const indexes = await this.indexes("= CAST(@objectId AS int)", scope);
        const triggers = await this.modules(
            "o.type = 'TR' AND o.parent_object_id = CAST(@objectId AS int)",
            scope,
        );
        return { view, indexes, triggers };
    }

    /** Database (DDL) triggers, by name or all. */
    async databaseTriggers(name?: string): Promise<ModuleRow[]> {
        const rows = await this.runQuery(
            this.database,
            `SELECT tr.object_id AS objectId, CAST(NULL AS sysname) AS schemaName, tr.name,
                'DDL' AS type, m.definition, CAST(m.uses_ansi_nulls AS bit) AS usesAnsiNulls,
                CAST(m.uses_quoted_identifier AS bit) AS usesQuotedIdentifier,
                CAST(NULL AS sysname) AS parentSchema, CAST(NULL AS sysname) AS parentName,
                CAST(NULL AS varchar(2)) AS parentType, tr.is_disabled AS isDisabled
             FROM ${this.db}.sys.triggers tr
             JOIN ${this.db}.sys.sql_modules m ON m.object_id = tr.object_id
             WHERE tr.parent_class = 0 AND tr.is_ms_shipped = 0
               ${name === undefined ? "" : "AND tr.name = @name"}`,
            name === undefined ? {} : { name },
        );
        return rows as ModuleRow[];
    }

    async parameters(objectId: number): Promise<ParameterRow[]> {
        const db = this.db;
        return (await this.query(
            `SELECT p.name, ty.name AS typeName, tys.name AS typeSchema,
                ty.is_user_defined AS isUserDefined, p.max_length AS maxLength, p.precision,
                p.scale, p.is_output AS isOutput
             FROM ${db}.sys.parameters p
             JOIN ${db}.sys.types ty ON ty.user_type_id = p.user_type_id
             JOIN ${db}.sys.schemas tys ON tys.schema_id = ty.schema_id
             WHERE p.object_id = CAST(@objectId AS int) AND p.parameter_id > 0
             ORDER BY p.parameter_id`,
            { objectId },
        )) as ParameterRow[];
    }

    // -----------------------------------------------------------------------
    // Types, sequences, synonyms
    // -----------------------------------------------------------------------

    async types(schema?: string, name?: string): Promise<TypeRow[]> {
        const db = this.db;
        return (await this.runQuery(
            this.database,
            `SELECT s.name AS schemaName, ty.name, bt.name AS baseTypeName,
                ty.max_length AS maxLength, ty.precision, ty.scale, ty.is_nullable AS isNullable
             FROM ${db}.sys.types ty
             JOIN ${db}.sys.schemas s ON s.schema_id = ty.schema_id
             JOIN ${db}.sys.types bt ON bt.user_type_id = ty.system_type_id
             WHERE ty.is_user_defined = 1 AND ty.is_table_type = 0 AND ty.is_assembly_type = 0
               ${byNameCondition(schema, name, "s.name", "ty.name")}`,
            byNameParameters(schema, name),
        )) as TypeRow[];
    }

    async tableTypes(schema?: string, name?: string): Promise<TableTypeModel[]> {
        const db = this.db;
        const types = await this.runQuery(
            this.database,
            `SELECT tt.type_table_object_id AS objectId, s.name AS schemaName, tt.name
             FROM ${db}.sys.table_types tt
             JOIN ${db}.sys.schemas s ON s.schema_id = tt.schema_id
             WHERE tt.is_user_defined = 1 ${byNameCondition(schema, name, "s.name", "tt.name")}`,
            byNameParameters(schema, name),
        );
        if (types.length === 0) return [];
        const ofTypes = `IN (SELECT type_table_object_id FROM ${db}.sys.table_types WHERE is_user_defined = 1)`;
        const columns = await this.columns(ofTypes, "all");
        const indexes = await this.indexes(ofTypes, "all");
        const checks = await this.checks(ofTypes, "all");
        return types.map((type) => ({
            schemaName: type.schemaName,
            name: type.name,
            columns: columns.filter((c) => c.objectId === type.objectId),
            indexes: indexes.filter((i) => i.objectId === type.objectId),
            checks: checks.filter((c) => c.objectId === type.objectId),
        }));
    }

    async sequences(schema?: string, name?: string): Promise<SequenceRow[]> {
        const db = this.db;
        return (await this.runQuery(
            this.database,
            `SELECT s.name AS schemaName, sq.name, ty.name AS typeName, tys.name AS typeSchema,
                ty.is_user_defined AS isUserDefined, sq.precision, sq.scale,
                CONVERT(nvarchar(50), sq.start_value) AS startValue,
                CONVERT(nvarchar(50), sq.increment) AS increment,
                CONVERT(nvarchar(50), sq.minimum_value) AS minimumValue,
                CONVERT(nvarchar(50), sq.maximum_value) AS maximumValue,
                sq.is_cycling AS isCycling, sq.is_cached AS isCached, sq.cache_size AS cacheSize
             FROM ${db}.sys.sequences sq
             JOIN ${db}.sys.schemas s ON s.schema_id = sq.schema_id
             JOIN ${db}.sys.types ty ON ty.user_type_id = sq.user_type_id
             JOIN ${db}.sys.schemas tys ON tys.schema_id = ty.schema_id
             WHERE 1 = 1 ${byNameCondition(schema, name, "s.name", "sq.name")}`,
            byNameParameters(schema, name),
        )) as SequenceRow[];
    }

    async synonyms(schema?: string, name?: string): Promise<SynonymRow[]> {
        return (await this.runQuery(
            this.database,
            `SELECT s.name AS schemaName, sy.name, sy.base_object_name AS baseObjectName
             FROM ${this.db}.sys.synonyms sy
             JOIN ${this.db}.sys.schemas s ON s.schema_id = sy.schema_id
             WHERE 1 = 1 ${byNameCondition(schema, name, "s.name", "sy.name")}`,
            byNameParameters(schema, name),
        )) as SynonymRow[];
    }

    // -----------------------------------------------------------------------
    // Schemas and principals
    // -----------------------------------------------------------------------

    /** User schemas: not the built-in ones (dbo, guest, sys, INFORMATION_SCHEMA, fixed roles). */
    async schemas(name?: string): Promise<string[]> {
        const rows = await this.runQuery(
            this.database,
            `SELECT s.name FROM ${this.db}.sys.schemas s
             WHERE ${name === undefined ? "s.schema_id > 4 AND s.schema_id < 16384" : "s.name = @name"}`,
            name === undefined ? {} : { name },
        );
        return rows.map((row) => row.name);
    }

    /**
     * Users, database roles and application roles, by name or all of them. The built-in ones
     * (dbo, guest, sys, INFORMATION_SCHEMA, public, fixed roles) are left out of "all".
     */
    async principals(types: string[], name?: string): Promise<PrincipalRow[]> {
        const db = this.db;
        const rows = await this.runQuery(
            this.database,
            `SELECT p.principal_id AS principalId, p.name, RTRIM(p.type) AS type,
                p.authentication_type_desc AS authenticationType,
                p.default_schema_name AS defaultSchema, SUSER_SNAME(p.sid) AS loginName
             FROM ${db}.sys.database_principals p
             WHERE RTRIM(p.type) IN (${types.map((t) => `'${t}'`).join(", ")})
               ${name === undefined ? "AND p.principal_id > 4 AND p.is_fixed_role = 0 AND p.name <> 'public'" : "AND p.name = @name"}`,
            name === undefined ? {} : { name },
        );
        const memberships = await this.runQuery(
            this.database,
            `SELECT rm.member_principal_id AS memberId, r.name AS roleName
             FROM ${db}.sys.database_role_members rm
             JOIN ${db}.sys.database_principals r ON r.principal_id = rm.role_principal_id`,
        );
        return rows.map(({ principalId, ...row }) => ({
            ...(row as Omit<PrincipalRow, "memberOf">),
            memberOf: memberships.filter((m) => m.memberId === principalId).map((m) => m.roleName),
        }));
    }

    /**
     * Pairs (referencing, referenced) of object ids between user objects, from
     * sys.sql_expression_dependencies. A reference from a constraint or a column counts for its table.
     */
    async dependencies(): Promise<Array<{ from: number; to: number }>> {
        const db = this.db;
        const rows = await this.runQuery(
            this.database,
            `SELECT DISTINCT
                CASE WHEN o.parent_object_id <> 0 AND o.type IN ('C', 'D', 'F', 'PK', 'UQ')
                     THEN o.parent_object_id ELSE d.referencing_id END AS fromId,
                d.referenced_id AS toId
             FROM ${db}.sys.sql_expression_dependencies d
             JOIN ${db}.sys.objects o ON o.object_id = d.referencing_id
             WHERE d.referenced_id IS NOT NULL AND d.referencing_class = 1`,
        );
        return rows.map((row) => ({ from: row.fromId, to: row.toId }));
    }
}

function byNameCondition(
    schema: string | undefined,
    name: string | undefined,
    schemaColumn: string,
    nameColumn: string,
): string {
    return name === undefined ? "" : `AND ${schemaColumn} = @schema AND ${nameColumn} = @name`;
}

function byNameParameters(schema: string | undefined, name: string | undefined) {
    return name === undefined ? {} : { schema: schema ?? "", name };
}
