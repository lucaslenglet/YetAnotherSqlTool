import { describe, expect, it } from "vitest";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import {
    CompletionMetadata,
    CompletionMetadataCache,
    ObjectIndex,
    type EditorConnectionInfo,
} from "../../src/languageFeatures/completion/completionMetadata";
import { changesSchema } from "../../src/languageFeatures/completion/schemaChanges";
import { MSSQL_OBJECTS, fakeConnection } from "./completionFakes";

describe("ObjectIndex", () => {
    const index = new ObjectIndex(MSSQL_OBJECTS, ["dbo"]);

    it("resolves names through the default schemas, then a unique schema", () => {
        const any = () => true;
        expect(index.resolve(["customers"], any)?.schema).toBe("dbo");
        expect(index.resolve(["CUSTOMERS"], any)?.name).toBe("customers");
        expect(index.resolve(["Order Lines"], any)?.schema).toBe("sales");
        expect(index.resolve(["sales", "customers"], any)).toBeUndefined();
        expect(index.resolve(["SYS", "objects"], any)?.schema).toBe("sys");
    });

    it("names schemas and ranks the default ones", () => {
        expect(index.schemaNamed("SALES")).toBe("sales");
        expect(index.defaultSchemaRank("DBO")).toBe(0);
        expect(index.defaultSchemaRank("sales")).toBe(-1);
    });
});

describe("CompletionMetadata", () => {
    it("loads the objects once, in the background", async () => {
        const connection = fakeConnection();
        const metadata = new CompletionMetadata(connection, "shop");
        const index = await metadata.whenLoaded();
        expect(index.objects.length).toBeGreaterThan(5);
        await metadata.objects(10);
        expect(connection.calls).toMatchObject({ objects: 1, defaultSchemas: 1 });
        expect(metadata.objectsLoadTime).toBeGreaterThanOrEqual(0);
    });

    it("falls back to no objects when the catalog cannot be read", async () => {
        const connection = fakeConnection();
        connection.listCompletionObjects = async () => {
            throw new Error("permission denied");
        };
        const metadata = new CompletionMetadata(connection, "shop");
        expect((await metadata.whenLoaded()).objects).toEqual([]);
        expect(String(metadata.error)).toContain("permission denied");
    });

    it("loads columns on demand, in one batch, and keeps them", async () => {
        const connection = fakeConnection();
        const metadata = new CompletionMetadata(connection, "shop");
        const relations = [
            { schema: "dbo", name: "customers" },
            { schema: "dbo", name: "orders" },
        ];
        const first = await metadata.columnsOf(relations, 100);
        expect(first.complete).toBe(true);
        expect(first.columns.get("dbo\u0000orders")?.map((c) => c.name)).toEqual([
            "id",
            "customer_id",
            "amount",
            "status",
        ]);
        await metadata.columnsOf([...relations, { schema: "sales", name: "Order Lines" }], 100);
        expect(connection.calls.columns).toEqual([
            relations,
            [{ schema: "sales", name: "Order Lines" }],
        ]);
    });

    it("stops its queries when disposed", async () => {
        let signal: AbortSignal | undefined;
        const connection = fakeConnection();
        connection.listCompletionObjects = (_db, s) => {
            signal = s;
            return new Promise(() => undefined);
        };
        const metadata = new CompletionMetadata(connection, "shop");
        metadata.dispose();
        expect(signal?.aborted).toBe(true);
        expect(metadata.isDisposed).toBe(true);
    });
});

describe("CompletionMetadataCache", () => {
    function setup() {
        const editors = new Map<string, EditorConnectionInfo>();
        const cache = new CompletionMetadataCache((uri) => editors.get(uri));
        return { editors, cache };
    }

    it("keeps an editor's metadata while its connection and database stay the same", () => {
        const { editors, cache } = setup();
        expect(cache.get("a")).toBeUndefined();
        const connection = fakeConnection();
        editors.set("a", { connection, database: "shop", serverKey: "s" });
        const first = cache.get("a");
        expect(cache.get("a")).toBe(first);
        // Database change (USE, change database): new metadata, the old one stops.
        editors.set("a", { connection, database: "master", serverKey: "s" });
        const second = cache.get("a");
        expect(second).not.toBe(first);
        expect(first?.isDisposed).toBe(true);
        // Reconnection: new connection object.
        editors.set("a", { connection: fakeConnection(), database: "master", serverKey: "s" });
        expect(cache.get("a")).not.toBe(second);
        // Disconnection.
        editors.delete("a");
        cache.connectionChanged("a");
        expect(cache.get("a")).toBeUndefined();
    });

    it("reloads on refresh and when DDL ran on the same database", async () => {
        const { editors, cache } = setup();
        const a = fakeConnection();
        const b = fakeConnection();
        const c = fakeConnection();
        editors.set("a", { connection: a, database: "shop", serverKey: "s" });
        editors.set("b", { connection: b, database: "shop", serverKey: "s" });
        editors.set("c", { connection: c, database: "other", serverKey: "s" });
        for (const uri of ["a", "b", "c"]) await cache.get(uri)!.whenLoaded();
        cache.refresh("a");
        expect(a.calls.objects).toBe(2);
        cache.invalidateDatabase("s", "shop");
        expect([a.calls.objects, b.calls.objects, c.calls.objects]).toEqual([3, 2, 1]);
    });
});

describe("changesSchema", () => {
    it.each([
        ["CREATE TABLE t (id int)", true],
        ["alter table t add c int", true],
        ["DROP VIEW v", true],
        ["EXEC sp_rename 'a', 'b'", true],
        ["SELECT * INTO new_table FROM t", true],
        ["SELECT * FROM t", false],
        ["INSERT INTO t VALUES (1)", false],
        ["MERGE INTO t USING s ON 1 = 1 WHEN MATCHED THEN DELETE;", false],
        ["SELECT 'CREATE TABLE x' -- DROP", false],
    ])("%j -> %s", (script, expected) => {
        expect(changesSchema(script, mssqlDriver.tokenize(script))).toBe(expected);
        expect(changesSchema(script, pgDriver.tokenize(script))).toBe(expected);
    });
});
