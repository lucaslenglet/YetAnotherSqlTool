/**
 * Object Explorer tree of a SQL Server connection. It reproduces what Microsoft's sqltoolsservice
 * returns (docs/reference/mssql-object-explorer-tree.json): same node types, labels, paths and metadata.
 *
 * Folders that are not implemented (Service Broker, Storage, External Resources, Always Encrypted,
 * Server Objects, Assemblies, ...) are simply not listed.
 *
 * Each node carries a `context` (JSON strings) telling `expandNode` what to query:
 *   kind      what the node is (see EXPANDERS below)
 *   database  database to query (database-level nodes)
 *   schema, name, parentType   the table or view a sub-folder belongs to
 *   urn       SMO-style URN of the node, used to build the children's URNs
 */

import type { ObjectMetadata } from "vscode-mssql";
import type { ObjectNode } from "../types";
import { quoteIdentifier } from "./sqlText";
import { databaseQueries, objectQueries, serverQueries } from "./objectExplorerQueries";

export type Row = Record<string, any>;

/** Runs a query. `database` selects the pool to use; query text must use three-part names for other databases. */
export type MetadataQueryRunner = (
    database: string | undefined,
    sqlText: string,
    parameters?: Record<string, string>,
) => Promise<Row[]>;

export interface ServerNodeInfo {
    /** Server as typed by the user, e.g. "localhost,11433". It is the root nodePath. */
    serverDisplayName: string;
    /** @@SERVERNAME, used in URNs. */
    serverName: string;
    version: string;
    userName: string;
}

type Context = Record<string, string>;
type ObjectKind = "Table" | "View";

const SYSTEM_DATABASE_IDS_MAX = 4; // master, model, msdb, tempdb

export class ObjectExplorer {
    private readonly serverUrn: string;

    constructor(
        private readonly info: ServerNodeInfo,
        private readonly runQuery: MetadataQueryRunner,
    ) {
        this.serverUrn = `Server[@Name='${escapeUrn(info.serverName)}']`;
    }

    getRootNode(): ObjectNode {
        return {
            nodePath: this.info.serverDisplayName,
            parentNodePath: "",
            nodeType: "Server",
            label: `${this.info.serverDisplayName} (SQL Server ${this.info.version} - ${this.info.userName})`,
            isLeaf: false,
            context: { kind: "server", urn: this.serverUrn },
        };
    }

    async expandNode(node: ObjectNode): Promise<ObjectNode[]> {
        const context = node.context ?? {};
        const expander = this.expanders[context.kind];
        if (!expander) return [];
        return expander(node, context);
    }

    // -----------------------------------------------------------------------
    // Expanders: one per node kind, each returns the node's children in display order.
    // -----------------------------------------------------------------------

    private readonly expanders: Record<
        string,
        (parent: ObjectNode, context: Context) => Promise<ObjectNode[]>
    > = {
        // Server level
        server: async (parent) => [
            folder(parent, "Databases", { kind: "databases" }),
            folder(parent, "Security", { kind: "serverSecurity" }),
        ],
        databases: async (parent) => {
            const rows = await this.runQuery(undefined, serverQueries.databases);
            const userDatabases = sortByName(
                rows.filter((r) => r.databaseId > SYSTEM_DATABASE_IDS_MAX),
                (r) => r.name,
            );
            return [
                folder(parent, "System Databases", { kind: "systemDatabases" }),
                ...userDatabases.map((r) => this.databaseNode(parent, r.name)),
            ];
        },
        systemDatabases: async (parent) => {
            const rows = await this.runQuery(undefined, serverQueries.databases);
            const systemDatabases = sortByName(
                rows.filter((r) => r.databaseId <= SYSTEM_DATABASE_IDS_MAX),
                (r) => r.name,
            );
            return systemDatabases.map((r) => this.databaseNode(parent, r.name));
        },
        serverSecurity: async (parent) => [
            folder(parent, "Logins", { kind: "logins" }),
            folder(parent, "Server Roles", { kind: "serverRoles" }),
        ],
        logins: async (parent) => {
            const rows = await this.runQuery(undefined, serverQueries.logins);
            return sortByName(rows, (r) => r.name).map((r) =>
                leaf(parent, r.name, r.name, "ServerLevelLogin", {
                    metadata: metadata(
                        "Login",
                        r.name,
                        {},
                        `${this.serverUrn}/Login[@Name='${escapeUrn(r.name)}']`,
                    ),
                }),
            );
        },
        serverRoles: async (parent) => {
            const rows = await this.runQuery(undefined, serverQueries.serverRoles);
            return sortByName(rows, (r) => r.name).map((r) =>
                leaf(parent, r.name, r.name, "ServerLevelServerRole", {
                    metadata: metadata(
                        "Role",
                        r.name,
                        {},
                        `${this.serverUrn}/Role[@Name='${escapeUrn(r.name)}']`,
                    ),
                }),
            );
        },

        // Database level
        database: async (parent, context) => {
            const inDatabase = (kind: string) => ({ ...context, kind });
            return [
                folder(parent, "Tables", inDatabase("tables")),
                folder(parent, "Views", inDatabase("views")),
                folder(parent, "Synonyms", inDatabase("synonyms")),
                folder(parent, "Programmability", inDatabase("programmability")),
                folder(parent, "Security", inDatabase("databaseSecurity")),
            ];
        },
        tables: (parent, context) => this.expandObjectList(parent, context, "Table"),
        views: (parent, context) => this.expandObjectList(parent, context, "View"),
        synonyms: async (parent, context) => {
            const rows = await this.runQuery(
                context.database,
                databaseQueries.synonyms(quoteIdentifier(context.database)),
            );
            return this.schemaObjectLeaves(parent, context, rows, "Synonym", "Synonym");
        },

        // Programmability
        programmability: async (parent, context) => {
            const inDatabase = (kind: string) => ({ ...context, kind });
            return [
                folder(parent, "Stored Procedures", inDatabase("storedProcedures")),
                folder(parent, "Functions", inDatabase("functions")),
                folder(parent, "Database Triggers", inDatabase("databaseTriggers")),
                folder(parent, "Types", inDatabase("types")),
                folder(parent, "Sequences", inDatabase("sequences")),
            ];
        },
        storedProcedures: async (parent, context) => {
            const rows = await this.runQuery(
                context.database,
                databaseQueries.storedProcedures(quoteIdentifier(context.database)),
            );
            return this.schemaObjectLeaves(
                parent,
                context,
                rows,
                "StoredProcedure",
                "StoredProcedure",
                2,
            );
        },
        functions: async (parent, context) => {
            const inDatabase = (kind: string) => ({ ...context, kind });
            return [
                folder(parent, "Table-valued Functions", inDatabase("tableValuedFunctions")),
                folder(parent, "Scalar-valued Functions", inDatabase("scalarValuedFunctions")),
                folder(parent, "Aggregate Functions", inDatabase("aggregateFunctions")),
            ];
        },
        tableValuedFunctions: (parent, context) =>
            this.expandFunctions(
                parent,
                context,
                ["TF", "IF", "FT"],
                "TableValuedFunction",
                "UserDefinedFunction",
            ),
        scalarValuedFunctions: (parent, context) =>
            this.expandFunctions(
                parent,
                context,
                ["FN", "FS"],
                "ScalarValuedFunction",
                "UserDefinedFunction",
            ),
        aggregateFunctions: (parent, context) =>
            this.expandFunctions(
                parent,
                context,
                ["AF"],
                "AggregateFunction",
                "UserDefinedAggregate",
            ),
        databaseTriggers: async (parent, context) => {
            const rows = await this.runQuery(
                context.database,
                databaseQueries.databaseTriggers(quoteIdentifier(context.database)),
            );
            return sortByName(rows, (r) => r.name).map((r) =>
                leaf(parent, r.name, r.name, "DatabaseTrigger", {
                    database: context.database,
                    metadata: metadata(
                        "Trigger",
                        r.name,
                        {},
                        `${context.urn}/Trigger[@Name='${escapeUrn(r.name)}']`,
                    ),
                }),
            );
        },
        types: async (parent, context) => {
            const inDatabase = (kind: string) => ({ ...context, kind });
            return [
                folder(parent, "User-Defined Data Types", inDatabase("userDefinedDataTypes")),
                folder(parent, "User-Defined Table Types", inDatabase("userDefinedTableTypes")),
            ];
        },
        userDefinedDataTypes: async (parent, context) => {
            const rows = await this.runQuery(
                context.database,
                databaseQueries.userDefinedDataTypes(quoteIdentifier(context.database)),
            );
            return this.schemaObjectLeaves(
                parent,
                context,
                rows,
                "UserDefinedDataType",
                "UserDefinedDataType",
            );
        },
        userDefinedTableTypes: async (parent, context) => {
            const rows = await this.runQuery(
                context.database,
                databaseQueries.userDefinedTableTypes(quoteIdentifier(context.database)),
            );
            return this.schemaObjectLeaves(
                parent,
                context,
                rows,
                "UserDefinedTableType",
                "UserDefinedTableType",
            );
        },
        sequences: async (parent, context) => {
            const rows = await this.runQuery(
                context.database,
                databaseQueries.sequences(quoteIdentifier(context.database)),
            );
            return this.schemaObjectLeaves(parent, context, rows, "Sequence", "Sequence");
        },

        // Security (database)
        databaseSecurity: async (parent, context) => {
            const inDatabase = (kind: string) => ({ ...context, kind });
            return [
                folder(parent, "Users", inDatabase("users")),
                folder(parent, "Roles", inDatabase("roles")),
                folder(parent, "Schemas", inDatabase("schemas")),
            ];
        },
        users: (parent, context) =>
            this.expandPrincipals(parent, context, databaseQueries.users, "User", "User"),
        roles: async (parent, context) => [
            folder(parent, "Database Roles", { ...context, kind: "databaseRoles" }),
            folder(parent, "Application Roles", { ...context, kind: "applicationRoles" }),
        ],
        databaseRoles: (parent, context) =>
            this.expandPrincipals(
                parent,
                context,
                databaseQueries.databaseRoles,
                "DatabaseRole",
                "Role",
            ),
        applicationRoles: (parent, context) =>
            this.expandPrincipals(
                parent,
                context,
                databaseQueries.applicationRoles,
                "ApplicationRole",
                "ApplicationRole",
            ),
        schemas: (parent, context) =>
            this.expandPrincipals(parent, context, databaseQueries.schemas, "Schema", "Schema"),

        // Inside a table or view
        table: (parent, context) =>
            this.expandObjectFolders(parent, context, [
                "Columns",
                "Keys",
                "Constraints",
                "Triggers",
                "Indexes",
                "Statistics",
            ]),
        view: (parent, context) =>
            this.expandObjectFolders(parent, context, [
                "Columns",
                "Triggers",
                "Indexes",
                "Statistics",
            ]),
        columns: (parent, context) => this.expandColumns(parent, context),
        keys: (parent, context) => this.expandKeys(parent, context),
        constraints: (parent, context) => this.expandConstraints(parent, context),
        objectTriggers: (parent, context) => this.expandObjectTriggers(parent, context),
        indexes: (parent, context) => this.expandIndexes(parent, context),
        statistics: (parent, context) => this.expandStatistics(parent, context),
    };

    // -----------------------------------------------------------------------
    // Server and database level helpers
    // -----------------------------------------------------------------------

    private databaseNode(parent: ObjectNode, name: string): ObjectNode {
        const urn = `${this.serverUrn}/Database[@Name='${escapeUrn(name)}']`;
        return {
            nodePath: `${parent.nodePath}/${name}`,
            parentNodePath: parent.nodePath,
            nodeType: "Database",
            label: name,
            isLeaf: false,
            metadata: metadata("Database", name, {}, urn),
            database: name,
            context: { kind: "database", database: name, urn },
        };
    }

    private async expandObjectList(
        parent: ObjectNode,
        context: Context,
        objectKind: ObjectKind,
    ): Promise<ObjectNode[]> {
        const db = quoteIdentifier(context.database);
        const rows = await this.runQuery(
            context.database,
            objectKind === "Table" ? databaseQueries.tables(db) : databaseQueries.views(db),
        );
        return sortByName(rows, (r) => `${r.schemaName}.${r.name}`).map((r) => {
            const label = `${r.schemaName}.${r.name}`;
            const urn = `${context.urn}/${objectKind}[@Name='${escapeUrn(r.name)}' and @Schema='${escapeUrn(r.schemaName)}']`;
            return {
                nodePath: `${parent.nodePath}/${label}`,
                parentNodePath: parent.nodePath,
                nodeType: objectKind,
                nodeSubType: r.temporalType === 2 ? "Temporal" : undefined,
                label,
                isLeaf: false,
                metadata: metadata(
                    objectKind,
                    r.name,
                    { schema: r.schemaName, metadataType: objectKind === "View" ? 1 : 0 },
                    urn,
                ),
                database: context.database,
                context: {
                    kind: objectKind.toLowerCase(),
                    database: context.database,
                    schema: r.schemaName,
                    name: r.name,
                    parentType: objectKind,
                    urn,
                },
            };
        });
    }

    /** Leaves labelled "schema.name" (synonyms, procedures, types, sequences...). */
    private schemaObjectLeaves(
        parent: ObjectNode,
        context: Context,
        rows: Row[],
        nodeType: string,
        metadataTypeName: string,
        metadataType = 0,
    ): ObjectNode[] {
        return sortByName(rows, (r) => `${r.schemaName}.${r.name}`).map((r) => {
            const label = `${r.schemaName}.${r.name}`;
            const urn = `${context.urn}/${metadataTypeName}[@Name='${escapeUrn(r.name)}' and @Schema='${escapeUrn(r.schemaName)}']`;
            return leaf(parent, label, label, nodeType, {
                database: context.database,
                metadata: metadata(
                    metadataTypeName,
                    r.name,
                    { schema: r.schemaName, metadataType },
                    urn,
                ),
            });
        });
    }

    private async expandFunctions(
        parent: ObjectNode,
        context: Context,
        typeCodes: string[],
        nodeType: string,
        metadataTypeName: string,
    ): Promise<ObjectNode[]> {
        const rows = await this.runQuery(
            context.database,
            databaseQueries.functions(quoteIdentifier(context.database)),
        );
        return this.schemaObjectLeaves(
            parent,
            context,
            rows.filter((r) => typeCodes.includes(r.objectType)),
            nodeType,
            metadataTypeName,
            3,
        );
    }

    /** Users, roles and schemas: leaves labelled with the bare name. */
    private async expandPrincipals(
        parent: ObjectNode,
        context: Context,
        query: (db: string) => string,
        nodeType: string,
        metadataTypeName: string,
    ): Promise<ObjectNode[]> {
        const rows = await this.runQuery(
            context.database,
            query(quoteIdentifier(context.database)),
        );
        return sortByName(rows, (r) => r.name).map((r) =>
            leaf(parent, r.name, r.name, nodeType, {
                database: context.database,
                metadata: metadata(
                    metadataTypeName,
                    r.name,
                    {},
                    `${context.urn}/${metadataTypeName}[@Name='${escapeUrn(r.name)}']`,
                ),
            }),
        );
    }

    // -----------------------------------------------------------------------
    // Inside a table or view
    // -----------------------------------------------------------------------

    private expandObjectFolders(
        parent: ObjectNode,
        context: Context,
        folderNames: string[],
    ): Promise<ObjectNode[]> {
        const kindOf: Record<string, string> = {
            Columns: "columns",
            Keys: "keys",
            Constraints: "constraints",
            Triggers: "objectTriggers",
            Indexes: "indexes",
            Statistics: "statistics",
        };
        return Promise.resolve(
            folderNames.map((name) => folder(parent, name, { ...context, kind: kindOf[name] })),
        );
    }

    private objectParameters(context: Context): Record<string, string> {
        return { schema: context.schema, name: context.name };
    }

    /** Metadata of a child of the current table/view (column, key, index...). */
    private childMetadata(
        context: Context,
        typeName: string,
        name: string,
        urnType: string = typeName,
    ): ObjectMetadata {
        const urn = `${context.urn}/${urnType}[@Name='${escapeUrn(name)}']`;
        return metadata(
            typeName,
            name,
            {
                schema: context.schema,
                parentName: context.name,
                parentTypeName: context.parentType,
            },
            urn,
        );
    }

    private async expandColumns(parent: ObjectNode, context: Context): Promise<ObjectNode[]> {
        const rows = await this.runQuery(
            context.database,
            objectQueries.columns(quoteIdentifier(context.database)),
            this.objectParameters(context),
        );
        return rows.map((r) =>
            leaf(parent, columnLabel(r), r.name, "Column", {
                database: context.database,
                metadata: this.childMetadata(context, "Column", r.name),
            }),
        );
    }

    private async expandKeys(parent: ObjectNode, context: Context): Promise<ObjectNode[]> {
        const db = quoteIdentifier(context.database);
        const parameters = this.objectParameters(context);
        const indexKeys = sortByName(
            await this.runQuery(context.database, objectQueries.keys(db), parameters),
            (r) => r.name,
        );
        const foreignKeys = sortByName(
            await this.runQuery(context.database, objectQueries.foreignKeys(db), parameters),
            (r) => r.name,
        );
        return [
            ...indexKeys.map((r) =>
                leaf(parent, r.name, r.name, "Key", {
                    nodeSubType: r.isPrimaryKey ? "PrimaryKey" : "UniqueKey",
                    database: context.database,
                    metadata: this.childMetadata(context, "Index", r.name),
                }),
            ),
            ...foreignKeys.map((r) =>
                leaf(parent, r.name, r.name, "Key", {
                    nodeSubType: "ForeignKey",
                    database: context.database,
                    metadata: this.childMetadata(context, "ForeignKey", r.name),
                }),
            ),
        ];
    }

    private async expandConstraints(parent: ObjectNode, context: Context): Promise<ObjectNode[]> {
        const db = quoteIdentifier(context.database);
        const parameters = this.objectParameters(context);
        const checks = sortByName(
            await this.runQuery(context.database, objectQueries.checkConstraints(db), parameters),
            (r) => r.name,
        );
        const defaults = sortByName(
            await this.runQuery(context.database, objectQueries.defaultConstraints(db), parameters),
            (r) => r.name,
        );

        // sqltoolsservice gives constraints almost no metadata (no schema, no parent).
        const constraintNode = (name: string, typeName: string, urn: string) =>
            leaf(parent, name, name, "Constraint", {
                database: context.database,
                metadata: metadata(typeName, name, {}, urn),
            });
        return [
            ...checks.map((r) =>
                constraintNode(
                    r.name,
                    "Check",
                    `${context.urn}/Check[@Name='${escapeUrn(r.name)}']`,
                ),
            ),
            ...defaults.map((r) =>
                constraintNode(
                    r.name,
                    "Default",
                    `${context.urn}/Column[@Name='${escapeUrn(r.columnName)}']/Default[@Name='${escapeUrn(r.name)}']`,
                ),
            ),
        ];
    }

    private async expandObjectTriggers(
        parent: ObjectNode,
        context: Context,
    ): Promise<ObjectNode[]> {
        const rows = await this.runQuery(
            context.database,
            objectQueries.triggers(quoteIdentifier(context.database)),
            this.objectParameters(context),
        );
        return sortByName(rows, (r) => r.name).map((r) =>
            leaf(parent, r.name, r.name, "Trigger", {
                nodeSubType: r.isDisabled ? "Disabled" : undefined,
                database: context.database,
                metadata: this.childMetadata(context, "Trigger", r.name),
            }),
        );
    }

    private async expandIndexes(parent: ObjectNode, context: Context): Promise<ObjectNode[]> {
        const rows = await this.runQuery(
            context.database,
            objectQueries.indexes(quoteIdentifier(context.database)),
            this.objectParameters(context),
        );
        return sortByName(rows, (r) => r.name).map((r) =>
            leaf(parent, indexLabel(r), r.name, "Index", {
                nodeSubType: r.isPrimaryKey
                    ? "PrimaryKey"
                    : r.isUniqueConstraint
                      ? "UniqueKey"
                      : undefined,
                database: context.database,
                metadata: this.childMetadata(context, "Index", r.name),
            }),
        );
    }

    private async expandStatistics(parent: ObjectNode, context: Context): Promise<ObjectNode[]> {
        const rows = await this.runQuery(
            context.database,
            objectQueries.statistics(quoteIdentifier(context.database)),
            this.objectParameters(context),
        );
        return sortByName(rows, (r) => r.name).map((r) =>
            leaf(parent, r.name, r.name, "Statistic", {
                database: context.database,
                metadata: this.childMetadata(context, "Statistic", r.name),
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** "id (PK, int, not null)", "customer_id (FK, int, not null)", "name (nvarchar(100), null)". */
export function columnLabel(row: Row): string {
    const keyFlags = [row.isPrimaryKey ? "PK" : "", row.isForeignKey ? "FK" : ""].filter(Boolean);
    const typeText = columnTypeText(row);
    const parts = [...keyFlags, typeText, row.isNullable ? "null" : "not null"];
    return `${row.name} (${parts.join(", ")})`;
}

export function columnTypeText(row: Row): string {
    if (row.isAliasType) {
        // Alias types (CREATE TYPE x FROM nvarchar(50)) show their own name, then the type they stand for.
        return `${row.typeName}(${sizedTypeName(row.baseTypeName ?? row.typeName, row)})`;
    }
    return sizedTypeName(row.typeName, row);
}

/** Adds length / precision / scale to the type name: nvarchar(100), decimal(10,2), datetime2(7). */
function sizedTypeName(typeName: string, row: Row): string {
    switch (typeName) {
        case "char":
        case "varchar":
        case "binary":
        case "varbinary":
            return `${typeName}(${row.maxLength === -1 ? "max" : row.maxLength})`;
        case "nchar":
        case "nvarchar":
            return `${typeName}(${row.maxLength === -1 ? "max" : row.maxLength / 2})`;
        case "decimal":
        case "numeric":
            return `${typeName}(${row.precision},${row.scale})`;
        case "datetime2":
        case "datetimeoffset":
        case "time":
            return `${typeName}(${row.scale})`;
        default:
            return typeName;
    }
}

const INDEX_TYPE_NAMES: Record<number, string> = {
    1: "Clustered",
    2: "Non-Clustered",
    3: "XML",
    4: "Spatial",
    5: "Clustered Columnstore",
    6: "Non-Clustered Columnstore",
    7: "Non-Clustered Hash",
};

/** "PK__x (Unique, Clustered)", "ix_y (Non-Unique, Non-Clustered)". */
function indexLabel(row: Row): string {
    const uniqueness = row.isUnique ? "Unique" : "Non-Unique";
    return `${row.name} (${uniqueness}, ${INDEX_TYPE_NAMES[row.type] ?? "Non-Clustered"})`;
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

function folder(parent: ObjectNode, name: string, context: Context): ObjectNode {
    return {
        nodePath: `${parent.nodePath}/${name}`,
        parentNodePath: parent.nodePath,
        nodeType: "Folder",
        label: name,
        isLeaf: false,
        database: parent.database ?? context.database,
        context: { urn: parent.context?.urn ?? "", ...parent.context, ...context },
    };
}

function leaf(
    parent: ObjectNode,
    label: string,
    pathSegment: string,
    nodeType: string,
    extra: { nodeSubType?: string; metadata?: ObjectMetadata; database?: string },
): ObjectNode {
    return {
        nodePath: `${parent.nodePath}/${pathSegment}`,
        parentNodePath: parent.nodePath,
        nodeType,
        nodeSubType: extra.nodeSubType,
        label,
        isLeaf: true,
        metadata: extra.metadata,
        database: extra.database,
    };
}

interface MetadataParts {
    schema?: string;
    parentName?: string;
    parentTypeName?: string;
    /** sqltoolsservice's MetadataType: 0 table (and most things), 1 view, 2 stored procedure, 3 function. */
    metadataType?: number;
}

/** Same shape as sqltoolsservice; absent parts are null like in the reference capture. */
function metadata(
    typeName: string,
    name: string,
    parts: MetadataParts,
    urn: string,
): ObjectMetadata {
    return {
        metadataType: (parts.metadataType ?? 0) as ObjectMetadata["metadataType"],
        metadataTypeName: typeName,
        schema: parts.schema ?? null,
        name,
        parentName: parts.parentName ?? null,
        parentTypeName: parts.parentTypeName ?? null,
        urn,
    } as ObjectMetadata;
}

/** Case-insensitive ordering by code unit, which is how SQL Server's default collations order these names. */
function sortByName<T>(items: T[], key: (item: T) => string): T[] {
    return [...items].sort((a, b) => {
        const left = key(a).toLowerCase();
        const right = key(b).toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
    });
}

function escapeUrn(value: string): string {
    return value.replace(/'/g, "''");
}
