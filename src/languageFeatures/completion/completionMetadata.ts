/**
 * Catalog metadata for autocompletion, per editor connection and database: sqltoolsservice's
 * IntelliSense cache (its "binding queue") rebuilt on the drivers.
 *
 * Objects (names of schemas, tables, views, routines, types...) are loaded in the background as soon
 * as the editor connects, in one query. Columns are loaded on demand, per relation, the first time a
 * position needs them, and kept: a database with hundreds of thousands of columns never loads them
 * all. A completion request never waits long: past a short budget it answers with what is known and
 * asks VS Code to ask again.
 */

import type { CompletionColumn, CompletionObject, DriverConnection } from "../../drivers/types";

type MetadataConnection = Pick<
    DriverConnection,
    "listCompletionObjects" | "listCompletionColumns" | "listDefaultSchemas"
>;

/** Relations whose columns are read in one query. */
const COLUMN_BATCH = 50;

/** Objects of a database, indexed for the lookups of autocompletion. Names compare case-insensitively. */
export class ObjectIndex {
    readonly schemas: CompletionObject[] = [];
    readonly databases: CompletionObject[] = [];
    /** Every object that has a schema. */
    readonly objects: CompletionObject[] = [];
    private readonly bySchema = new Map<string, CompletionObject[]>();
    private readonly byName = new Map<string, CompletionObject[]>();

    constructor(
        all: readonly CompletionObject[],
        /** Schemas searched for a name without schema, in order. */
        readonly defaultSchemas: readonly string[],
    ) {
        for (const object of all) {
            if (object.kind === "schema") this.schemas.push(object);
            else if (object.kind === "database") this.databases.push(object);
            else if (object.schema !== undefined) {
                this.objects.push(object);
                push(this.bySchema, object.schema.toLowerCase(), object);
                push(this.byName, object.name.toLowerCase(), object);
            }
        }
    }

    /** The schema with this name: same case first, then any case. */
    schemaNamed(name: string): string | undefined {
        return pickName(this.schemas, name)?.name;
    }

    databaseNamed(name: string): string | undefined {
        return pickName(this.databases, name)?.name;
    }

    objectsOf(schema: string): CompletionObject[] {
        return this.bySchema.get(schema.toLowerCase()) ?? [];
    }

    /** Objects with this name, in any schema. */
    named(name: string): CompletionObject[] {
        return this.byName.get(name.toLowerCase()) ?? [];
    }

    /** Position of a schema in the search path; -1 when it is not searched. */
    defaultSchemaRank(schema: string | undefined): number {
        if (schema === undefined) return -1;
        return this.defaultSchemas.findIndex((s) => s.toLowerCase() === schema.toLowerCase());
    }

    /**
     * The object a name written in a script refers to: [schema, name] or [name], searched in the
     * default schemas, then anywhere when only one schema has it.
     */
    resolve(
        parts: readonly string[],
        accept: (object: CompletionObject) => boolean,
    ): CompletionObject | undefined {
        const name = parts[parts.length - 1];
        const candidates = this.named(name).filter(accept);
        if (parts.length >= 2) {
            const schema = parts[parts.length - 2].toLowerCase();
            return pickName(
                candidates.filter((o) => o.schema!.toLowerCase() === schema),
                name,
            );
        }
        for (const schema of this.defaultSchemas) {
            const found = pickName(
                candidates.filter((o) => o.schema!.toLowerCase() === schema.toLowerCase()),
                name,
            );
            if (found) return found;
        }
        const schemas = new Set(candidates.map((o) => o.schema));
        return schemas.size === 1 ? pickName(candidates, name) : undefined;
    }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
}

function pickName<T extends { name: string }>(list: readonly T[], name: string): T | undefined {
    return (
        list.find((o) => o.name === name) ??
        list.find((o) => o.name.toLowerCase() === name.toLowerCase())
    );
}

export const relationKey = (r: { schema: string; name: string }) => `${r.schema}\u0000${r.name}`;

/** Resolves when `promise` does, or with undefined after `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** Metadata of one database seen from one connection. */
export class CompletionMetadata {
    private readonly abort = new AbortController();
    private readonly objectsPromise: Promise<ObjectIndex>;
    private readonly columns = new Map<string, CompletionColumn[]>();
    private readonly pendingColumns = new Map<string, Promise<void>>();
    private loadedObjects: ObjectIndex | undefined;
    /** Time the objects took to load, in milliseconds (for diagnostics). */
    objectsLoadTime: number | undefined;
    /** Why the objects could not be read, when they could not. */
    error: unknown;

    constructor(
        private readonly connection: MetadataConnection,
        readonly database: string,
    ) {
        const started = Date.now();
        const signal = this.abort.signal;
        this.objectsPromise = Promise.all([
            connection.listCompletionObjects(database, signal),
            connection.listDefaultSchemas(database, signal),
        ]).then(
            ([objects, schemas]) => {
                this.objectsLoadTime = Date.now() - started;
                return (this.loadedObjects = new ObjectIndex(objects, schemas));
            },
            (error) => {
                // No permission, dropped connection...: completion goes on with keywords.
                this.error = error;
                return (this.loadedObjects = new ObjectIndex([], []));
            },
        );
    }

    get isDisposed(): boolean {
        return this.abort.signal.aborted;
    }

    /** The objects, waiting at most `budgetMs` for them; undefined while they are loading. */
    async objects(budgetMs: number): Promise<ObjectIndex | undefined> {
        return this.loadedObjects ?? within(this.objectsPromise, budgetMs);
    }

    /** Resolves when the objects are loaded (or failed to). */
    whenLoaded(): Promise<ObjectIndex> {
        return this.objectsPromise;
    }

    /**
     * Columns of relations, loading the missing ones (in batches) and waiting at most `budgetMs`.
     * `complete` is false when some are still loading: they will be there on the next request.
     */
    async columnsOf(
        relations: readonly { schema: string; name: string }[],
        budgetMs: number,
    ): Promise<{ columns: Map<string, CompletionColumn[]>; complete: boolean }> {
        const missing = new Map<string, { schema: string; name: string }>();
        for (const relation of relations) {
            const key = relationKey(relation);
            if (!this.columns.has(key) && !this.pendingColumns.has(key)) missing.set(key, relation);
        }
        const list = [...missing.values()];
        for (let i = 0; i < list.length; i += COLUMN_BATCH)
            this.loadColumns(list.slice(i, i + COLUMN_BATCH));

        const pending = relations
            .map((r) => this.pendingColumns.get(relationKey(r)))
            .filter((p): p is Promise<void> => p !== undefined);
        if (pending.length) await within(Promise.all(pending), budgetMs);

        const columns = new Map<string, CompletionColumn[]>();
        let complete = true;
        for (const relation of relations) {
            const key = relationKey(relation);
            const known = this.columns.get(key);
            if (known) columns.set(key, known);
            else complete = false;
        }
        return { columns, complete };
    }

    private loadColumns(relations: { schema: string; name: string }[]): void {
        const promise = this.connection
            .listCompletionColumns(this.database, relations, this.abort.signal)
            .then(
                (lists) =>
                    relations.forEach((r, i) => this.columns.set(relationKey(r), lists[i] ?? [])),
                // Unknown for now; asked again next time.
                () => undefined,
            )
            .finally(() => relations.forEach((r) => this.pendingColumns.delete(relationKey(r))));
        relations.forEach((r) => this.pendingColumns.set(relationKey(r), promise));
    }

    dispose(): void {
        this.abort.abort();
    }
}

/** What the cache needs to know about an editor's connection. */
export interface EditorConnectionInfo {
    connection: MetadataConnection;
    database: string;
    /** Identifies the server: editors connected to the same server and database share invalidations. */
    serverKey: string;
}

/**
 * Metadata of every connected editor, keyed by document URI. An entry is dropped as soon as the
 * editor's connection or database is no longer the one it was loaded from.
 */
export class CompletionMetadataCache {
    private readonly entries = new Map<
        string,
        { info: EditorConnectionInfo; metadata: CompletionMetadata }
    >();

    constructor(private readonly lookup: (uri: string) => EditorConnectionInfo | undefined) {}

    /** The editor's metadata, created (and loading) when needed; undefined when it is not connected. */
    get(uri: string): CompletionMetadata | undefined {
        const info = this.lookup(uri);
        const entry = this.entries.get(uri);
        if (
            entry &&
            info &&
            entry.info.connection === info.connection &&
            entry.info.database === info.database
        ) {
            return entry.metadata;
        }
        this.drop(uri);
        if (!info) return undefined;
        const metadata = new CompletionMetadata(info.connection, info.database);
        this.entries.set(uri, { info, metadata });
        return metadata;
    }

    /** The editor's connection or database changed: reload (in the background) when it is connected. */
    connectionChanged(uri: string): void {
        this.get(uri);
    }

    /** Forgets the editor's metadata and starts loading it again ("Refresh IntelliSense Cache"). */
    refresh(uri: string): CompletionMetadata | undefined {
        this.drop(uri);
        return this.get(uri);
    }

    /** Objects changed in a database (DDL): every editor using it reloads. */
    invalidateDatabase(serverKey: string, database: string): void {
        for (const [uri, entry] of [...this.entries]) {
            if (entry.info.serverKey === serverKey && entry.info.database === database) {
                this.refresh(uri);
            }
        }
    }

    forget(uri: string): void {
        this.drop(uri);
    }

    dispose(): void {
        for (const uri of [...this.entries.keys()]) this.drop(uri);
    }

    private drop(uri: string): void {
        this.entries.get(uri)?.metadata.dispose();
        this.entries.delete(uri);
    }
}
