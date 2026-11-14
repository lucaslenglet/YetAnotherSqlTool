/**
 * Object Explorer tree for PostgreSQL.
 *
 * The tree mirrors what sqltoolsservice returns for SQL Server (see
 * docs/reference/mssql-object-explorer-tree.json): same nodeType icons, label
 * formats and metadata fields. Nodes are built lazily, one level per expandNode.
 *
 * Every node carries a private `context` ({ kind, ... }) telling expandNode what
 * the node is. PostgreSQL needs one connection per database, so the explorer asks
 * `getClient(database)` for a client connected to the right one.
 */

import type { ObjectMetadata } from "vscode-mssql";
import type { ObjectNode } from "../types";
import * as catalog from "./catalog";
import type { Queryable } from "./catalog";

export interface TreeServer {
    /** "host:port", also the nodePath of the server node. */
    address: string;
    label: string;
}

export type ClientProvider = (database: string) => Promise<Queryable>;

/** Numeric metadataType values of vscode-mssql's MetadataType enum. */
const MetadataType = { Table: 0, View: 1, SProc: 2, Function: 3 };

type RelationType = "Table" | "View";

/** Everything needed to build the children of a node; stored as the node's `context`. */
interface Context {
    kind: string;
    database?: string;
    schema?: string;
    relation?: string;
    relationType?: RelationType;
    /** True for materialized views (they can have indexes). */
    materialized?: string;
    /** sqltoolsservice-style path of this node, e.g. Server[@Name='x']/Database[@Name='y']. */
    urn: string;
}

const quoteUrnValue = (value: string) => value.replace(/'/g, "''");

export function createServerNode(server: TreeServer): ObjectNode {
    return {
        nodePath: server.address,
        parentNodePath: "",
        nodeType: "Server",
        label: server.label,
        isLeaf: false,
        context: { kind: "server", urn: `Server[@Name='${quoteUrnValue(server.address)}']` },
    };
}

export class PgObjectExplorer {
    constructor(
        private readonly getClient: ClientProvider,
        /** Database used for server-level queries (database and role lists). */
        private readonly serverDatabase: string,
    ) {}

    async expand(node: ObjectNode): Promise<ObjectNode[]> {
        const ctx = node.context as unknown as Context | undefined;
        if (!ctx) return [];
        switch (ctx.kind) {
            case "server":
                return this.serverChildren(node, ctx);
            case "databases":
                return this.databaseNodes(node, ctx);
            case "roles":
                return this.roleNodes(node, ctx);
            case "database":
                return [folder(node, ctx, "Schemas", { kind: "schemas" })];
            case "schemas":
                return this.schemaNodes(node, ctx);
            case "systemSchemas":
                return this.schemaNodes(node, ctx);
            case "schema":
                return this.schemaFolders(node, ctx);
            default:
                return this.expandSchemaObjects(node, ctx);
        }
    }

    // -- server level -------------------------------------------------------

    private serverChildren(node: ObjectNode, ctx: Context): ObjectNode[] {
        return [
            folder(node, ctx, "Databases", { kind: "databases" }),
            folder(node, ctx, "Login/Group Roles", { kind: "roles" }),
        ];
    }

    private async databaseNodes(node: ObjectNode, ctx: Context): Promise<ObjectNode[]> {
        const client = await this.getClient(this.serverDatabase);
        const names = await catalog.listDatabases(client);
        return names.map((name) =>
            makeNode(node, name, {
                nodeType: "Database",
                label: name,
                isLeaf: false,
                database: name,
                metadata: metadata("Database", {
                    name,
                    urn: `${ctx.urn}/Database[@Name='${quoteUrnValue(name)}']`,
                }),
                context: {
                    kind: "database",
                    database: name,
                    urn: `${ctx.urn}/Database[@Name='${quoteUrnValue(name)}']`,
                },
            }),
        );
    }

    private async roleNodes(node: ObjectNode, ctx: Context): Promise<ObjectNode[]> {
        const client = await this.getClient(this.serverDatabase);
        const roles = await catalog.listRoles(client);
        return roles.map((role) => {
            const urn = `${ctx.urn}/Role[@Name='${quoteUrnValue(role.name)}']`;
            return makeNode(node, role.name, {
                nodeType: role.canLogin ? "ServerLevelLogin" : "ServerLevelServerRole",
                label: role.name,
                isLeaf: true,
                metadata: metadata(role.canLogin ? "Login" : "Role", { name: role.name, urn }),
            });
        });
    }

    // -- database level -----------------------------------------------------

    private async schemaNodes(node: ObjectNode, ctx: Context): Promise<ObjectNode[]> {
        const client = await this.getClient(ctx.database);
        const isSystemFolder = ctx.kind === "systemSchemas";
        const names = await catalog.listSchemas(client, isSystemFolder);
        const schemas = names.map((name) => {
            const urn = `${ctx.urn}/Schema[@Name='${quoteUrnValue(name)}']`;
            return makeNode(node, name, {
                nodeType: "Schema",
                label: name,
                isLeaf: false,
                database: ctx.database,
                metadata: metadata("Schema", { name, urn }),
                context: { kind: "schema", database: ctx.database, schema: name, urn },
            });
        });
        if (isSystemFolder) return schemas;
        return [...schemas, folder(node, ctx, "System Schemas", { kind: "systemSchemas" })];
    }

    // -- schema level -------------------------------------------------------

    private schemaFolders(node: ObjectNode, ctx: Context): ObjectNode[] {
        const own = { schema: ctx.schema };
        return [
            folder(node, ctx, "Tables", { kind: "tables", ...own }),
            folder(node, ctx, "Views", { kind: "views", ...own }),
            folder(node, ctx, "Materialized Views", { kind: "matviews", ...own }),
            folder(node, ctx, "Functions", { kind: "functions", ...own }),
            folder(node, ctx, "Procedures", { kind: "procedures", ...own }),
            folder(node, ctx, "Sequences", { kind: "sequences", ...own }),
            folder(node, ctx, "Types", { kind: "types", ...own }),
        ];
    }

    private async expandSchemaObjects(node: ObjectNode, ctx: Context): Promise<ObjectNode[]> {
        switch (ctx.kind) {
            case "tables":
                return this.relationNodes(
                    node,
                    ctx,
                    await this.query(ctx, catalog.listTables),
                    "Table",
                    false,
                );
            case "views":
                return this.relationNodes(
                    node,
                    ctx,
                    await this.query(ctx, catalog.listViews),
                    "View",
                    false,
                );
            case "matviews":
                return this.relationNodes(
                    node,
                    ctx,
                    await this.query(ctx, catalog.listMaterializedViews),
                    "View",
                    true,
                );
            case "functions":
                return this.functionNodes(node, ctx, await this.query(ctx, catalog.listFunctions));
            case "procedures":
                return this.procedureNodes(
                    node,
                    ctx,
                    await this.query(ctx, catalog.listProcedures),
                );
            case "sequences":
                return this.sequenceNodes(node, ctx, await this.query(ctx, catalog.listSequences));
            case "types":
                return this.typeNodes(node, ctx, await this.query(ctx, catalog.listTypes));
            case "table":
                return this.tableFolders(node, ctx);
            case "columns":
                return this.columnNodes(
                    node,
                    ctx,
                    await this.queryRelation(ctx, catalog.listColumns),
                );
            case "keys":
                return this.keyNodes(node, ctx, await this.queryRelation(ctx, catalog.listKeys));
            case "constraints":
                return this.constraintNodes(
                    node,
                    ctx,
                    await this.queryRelation(ctx, catalog.listCheckConstraints),
                );
            case "indexes":
                return this.indexNodes(
                    node,
                    ctx,
                    await this.queryRelation(ctx, catalog.listIndexes),
                );
            case "triggers":
                return this.triggerNodes(
                    node,
                    ctx,
                    await this.queryRelation(ctx, catalog.listTriggers),
                );
            default:
                return [];
        }
    }

    private async query<T>(
        ctx: Context,
        run: (db: Queryable, schema: string) => Promise<T>,
    ): Promise<T> {
        return run(await this.getClient(ctx.database), ctx.schema);
    }

    private async queryRelation<T>(
        ctx: Context,
        run: (db: Queryable, schema: string, relation: string) => Promise<T>,
    ): Promise<T> {
        return run(await this.getClient(ctx.database), ctx.schema, ctx.relation);
    }

    private relationNodes(
        parent: ObjectNode,
        ctx: Context,
        names: string[],
        relationType: RelationType,
        materialized: boolean,
    ): ObjectNode[] {
        return names.map((name) => {
            const urn = `${ctx.urn}/${relationType}[@Name='${quoteUrnValue(name)}' and @Schema='${quoteUrnValue(ctx.schema)}']`;
            return makeNode(parent, name, {
                nodeType: relationType,
                label: name,
                isLeaf: false,
                metadata: metadata(relationType, {
                    name,
                    schema: ctx.schema,
                    urn,
                    metadataType: relationType === "Table" ? MetadataType.Table : MetadataType.View,
                }),
                context: {
                    kind: "table",
                    database: ctx.database,
                    schema: ctx.schema,
                    relation: name,
                    relationType,
                    materialized: materialized ? "true" : "",
                    urn,
                },
            });
        });
    }

    private functionNodes(
        parent: ObjectNode,
        ctx: Context,
        rows: catalog.FunctionRow[],
    ): ObjectNode[] {
        return rows.map((row) => {
            const label = `${row.name}(${row.args})`;
            const nodeType =
                row.kind === "aggregate"
                    ? "AggregateFunction"
                    : row.returnsTable
                      ? "TableValuedFunction"
                      : "ScalarValuedFunction";
            return makeNode(parent, label, {
                nodeType,
                label,
                isLeaf: true,
                metadata: metadata("UserDefinedFunction", {
                    name: row.name,
                    schema: ctx.schema,
                    metadataType: MetadataType.Function,
                    urn: `${ctx.urn}/UserDefinedFunction[@Name='${quoteUrnValue(row.name)}' and @Schema='${quoteUrnValue(ctx.schema)}']`,
                }),
            });
        });
    }

    private procedureNodes(
        parent: ObjectNode,
        ctx: Context,
        rows: catalog.FunctionRow[],
    ): ObjectNode[] {
        return rows.map((row) => {
            const label = `${row.name}(${row.args})`;
            return makeNode(parent, label, {
                nodeType: "StoredProcedure",
                label,
                isLeaf: true,
                metadata: metadata("StoredProcedure", {
                    name: row.name,
                    schema: ctx.schema,
                    metadataType: MetadataType.SProc,
                    urn: `${ctx.urn}/StoredProcedure[@Name='${quoteUrnValue(row.name)}' and @Schema='${quoteUrnValue(ctx.schema)}']`,
                }),
            });
        });
    }

    private sequenceNodes(parent: ObjectNode, ctx: Context, names: string[]): ObjectNode[] {
        return names.map((name) =>
            makeNode(parent, name, {
                nodeType: "Sequence",
                label: name,
                isLeaf: true,
                metadata: metadata("Sequence", {
                    name,
                    schema: ctx.schema,
                    urn: `${ctx.urn}/Sequence[@Name='${quoteUrnValue(name)}' and @Schema='${quoteUrnValue(ctx.schema)}']`,
                }),
            }),
        );
    }

    private typeNodes(parent: ObjectNode, ctx: Context, rows: catalog.TypeRow[]): ObjectNode[] {
        return rows.map((row) =>
            makeNode(parent, row.name, {
                nodeType: row.kind === "domain" ? "UserDefinedDataType" : "UserDefinedType",
                label: row.name,
                isLeaf: true,
                metadata: metadata("UserDefinedType", {
                    name: row.name,
                    schema: ctx.schema,
                    urn: `${ctx.urn}/UserDefinedType[@Name='${quoteUrnValue(row.name)}' and @Schema='${quoteUrnValue(ctx.schema)}']`,
                }),
            }),
        );
    }

    // -- table / view level -------------------------------------------------

    private tableFolders(node: ObjectNode, ctx: Context): ObjectNode[] {
        const folders = [folder(node, ctx, "Columns", { kind: "columns" })];
        if (ctx.relationType === "Table") {
            folders.push(
                folder(node, ctx, "Keys", { kind: "keys" }),
                folder(node, ctx, "Constraints", { kind: "constraints" }),
                folder(node, ctx, "Indexes", { kind: "indexes" }),
                folder(node, ctx, "Triggers", { kind: "triggers" }),
            );
        } else if (ctx.materialized) {
            folders.push(folder(node, ctx, "Indexes", { kind: "indexes" }));
        }
        return folders;
    }

    /** Metadata of an object that lives under a table or view. */
    private childMetadata(
        ctx: Context,
        typeName: string,
        name: string,
        elementUrn: string,
    ): ObjectMetadata {
        return metadata(typeName, {
            name,
            schema: ctx.schema,
            parentName: ctx.relation,
            parentTypeName: ctx.relationType,
            urn: `${ctx.urn}/${elementUrn}`,
        });
    }

    private columnNodes(parent: ObjectNode, ctx: Context, rows: catalog.ColumnRow[]): ObjectNode[] {
        return rows.map((row) =>
            makeNode(parent, row.name, {
                nodeType: "Column",
                label: columnLabel(row),
                isLeaf: true,
                metadata: this.childMetadata(
                    ctx,
                    "Column",
                    row.name,
                    `Column[@Name='${quoteUrnValue(row.name)}']`,
                ),
            }),
        );
    }

    private keyNodes(parent: ObjectNode, ctx: Context, rows: catalog.KeyRow[]): ObjectNode[] {
        return rows.map((row) => {
            const isForeign = row.kind === "ForeignKey";
            const typeName = isForeign ? "ForeignKey" : "Index";
            return makeNode(parent, row.name, {
                nodeType: "Key",
                nodeSubType: row.kind,
                label: row.name,
                isLeaf: true,
                metadata: this.childMetadata(
                    ctx,
                    typeName,
                    row.name,
                    `${typeName}[@Name='${quoteUrnValue(row.name)}']`,
                ),
            });
        });
    }

    private constraintNodes(parent: ObjectNode, ctx: Context, names: string[]): ObjectNode[] {
        return names.map((name) =>
            makeNode(parent, name, {
                nodeType: "Constraint",
                label: name,
                isLeaf: true,
                metadata: this.childMetadata(
                    ctx,
                    "Check",
                    name,
                    `Check[@Name='${quoteUrnValue(name)}']`,
                ),
            }),
        );
    }

    private indexNodes(parent: ObjectNode, ctx: Context, rows: catalog.IndexRow[]): ObjectNode[] {
        return rows.map((row) =>
            makeNode(parent, row.name, {
                nodeType: "Index",
                nodeSubType: row.isPrimary ? "PrimaryKey" : row.isUnique ? "UniqueKey" : undefined,
                label: indexLabel(row),
                isLeaf: true,
                metadata: this.childMetadata(
                    ctx,
                    "Index",
                    row.name,
                    `Index[@Name='${quoteUrnValue(row.name)}']`,
                ),
            }),
        );
    }

    private triggerNodes(parent: ObjectNode, ctx: Context, names: string[]): ObjectNode[] {
        return names.map((name) =>
            makeNode(parent, name, {
                nodeType: "Trigger",
                label: name,
                isLeaf: true,
                metadata: this.childMetadata(
                    ctx,
                    "Trigger",
                    name,
                    `Trigger[@Name='${quoteUrnValue(name)}']`,
                ),
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** "id (PK, integer, not null)", "customer_id (FK, integer, not null)", "name (character varying(100), null)". */
export function columnLabel(column: catalog.ColumnRow): string {
    const parts: string[] = [];
    if (column.isPrimaryKey) parts.push("PK");
    if (column.isForeignKey) parts.push("FK");
    parts.push(column.type, column.notNull ? "not null" : "null");
    return `${column.name} (${parts.join(", ")})`;
}

/** "customers_pkey (Unique, Primary)", "customers_email_key (Unique)", "idx_name (Non-Unique)". */
export function indexLabel(index: catalog.IndexRow): string {
    const parts = [index.isUnique ? "Unique" : "Non-Unique"];
    if (index.isPrimary) parts.push("Primary");
    return `${index.name} (${parts.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

type NodeFields = Omit<ObjectNode, "nodePath" | "parentNodePath" | "context"> & {
    context?: Record<string, string> | Context;
};

/** Builds a child of `parent`; the path segment is appended to the parent's path. */
function makeNode(parent: ObjectNode, segment: string, fields: NodeFields): ObjectNode {
    return {
        ...fields,
        nodePath: `${parent.nodePath}/${segment}`,
        parentNodePath: parent.nodePath,
        database: fields.database ?? parent.database,
        // Only nodes that can be expanded get a context; leaves must not inherit one.
        context: fields.context as Record<string, string> | undefined,
    };
}

/** A folder node that inherits the parent's scope (database, schema, relation) and overrides `kind`. */
function folder(
    parent: ObjectNode,
    parentCtx: Context,
    label: string,
    override: Partial<Context>,
): ObjectNode {
    return makeNode(parent, label, {
        nodeType: "Folder",
        label,
        isLeaf: false,
        context: { ...parentCtx, ...override } as Context,
    });
}

function metadata(
    typeName: string,
    fields: {
        name: string;
        urn: string;
        schema?: string;
        parentName?: string;
        parentTypeName?: string;
        metadataType?: number;
    },
): ObjectMetadata {
    return {
        metadataType: (fields.metadataType ?? 0) as ObjectMetadata["metadataType"],
        metadataTypeName: typeName,
        schema: fields.schema ?? null,
        name: fields.name,
        parentName: fields.parentName ?? null,
        parentTypeName: fields.parentTypeName ?? null,
        urn: fields.urn,
    };
}
