import { describe, expect, it } from "vitest";
import type { DriverConnection, ObjectNode } from "../../src/drivers/types";
import type { IConnector } from "../../src/objectExplorer/objectExplorerService";
import { createExplorer, labelOf } from "./serviceHarness";

// The database filter of a profile, through a fake driver connection with the tree shapes of the
// two engines (SQL Server: system databases in a folder of "Databases"; PostgreSQL: a flat list).

const node = (parent: string, label: string, nodeType: string, isLeaf = false): ObjectNode => ({
    nodePath: `${parent}/${label}`,
    parentNodePath: parent,
    nodeType,
    label,
    isLeaf,
});

const server = node("", "fake-server", "Server");
const user = ["app-dev-1", "app-dev-2", "app-rec-1", "Other"];
const system = ["master", "msdb"];

function childrenOfPath(path: string, kind: "mssql" | "pg"): ObjectNode[] {
    const databases = (parent: string, names: string[]) =>
        names.map((n) => node(parent, n, "Database"));
    switch (path) {
        case server.nodePath:
            return [node(path, "Databases", "Folder")];
        case `${server.nodePath}/Databases`:
            return kind === "mssql"
                ? [node(path, "System Databases", "Folder"), ...databases(path, user)]
                : databases(path, [...user, "postgres"]);
        case `${server.nodePath}/Databases/System Databases`:
            return databases(path, system);
        default:
            // Below a database: one folder, which must never be filtered.
            return [node(path, "Tables", "Folder")];
    }
}

function fakeConnector(kind: "mssql" | "pg"): IConnector {
    const connection = {
        getRootNode: () => server,
        expandNode: async (n: ObjectNode) => childrenOfPath(n.nodePath, kind),
    } as unknown as DriverConnection;
    return { connect: async () => connection };
}

const descriptionOf = (item: unknown) => (item as { description?: string }).description;

function explorer(mssqlFilter?: string, pgFilter?: string) {
    return createExplorer(
        {},
        {},
        {
            connector: fakeConnector("mssql"),
            databaseFilter: { mssql: mssqlFilter, pg: pgFilter },
        },
    );
}

describe("SQL Server tree", () => {
    it("lists every database, without '(filtered)', when the profile has no filter", async () => {
        const { children, expandPath, connectionNode } = explorer();
        const databases = await expandPath(await connectionNode("mssql-docker"), "Databases");
        expect((await children(databases)).map(labelOf)).toEqual(["System Databases", ...user]);
        expect(descriptionOf(databases)).toBeUndefined();
    });

    it("lists only the matching user databases, and says the folder is filtered", async () => {
        const { children, expandPath, connectionNode } = explorer("*-dev-*");
        const databases = await expandPath(await connectionNode("mssql-docker"), "Databases");
        expect((await children(databases)).map(labelOf)).toEqual([
            "System Databases",
            "app-dev-1",
            "app-dev-2",
        ]);
        expect(descriptionOf(databases)).toBe("(filtered)");
    });

    it("filters the system databases too, down to 'No items'", async () => {
        const { children, expandPath, connectionNode } = explorer("*-dev-*");
        const systemFolder = await expandPath(
            await connectionNode("mssql-docker"),
            "Databases",
            "System Databases",
        );
        expect((await children(systemFolder)).map(labelOf)).toEqual(["No items"]);
        expect(descriptionOf(systemFolder)).toBe("(filtered)");
    });

    it("keeps the system databases that match", async () => {
        const { children, expandPath, connectionNode } = explorer("ms*");
        const systemFolder = await expandPath(
            await connectionNode("mssql-docker"),
            "Databases",
            "System Databases",
        );
        expect((await children(systemFolder)).map(labelOf)).toEqual(["msdb"]);
    });

    it("does not filter what is below a database, and does not mark it", async () => {
        const { children, expandPath, connectionNode } = explorer("*-dev-*");
        const database = await expandPath(
            await connectionNode("mssql-docker"),
            "Databases",
            "app-dev-1",
        );
        expect((await children(database)).map(labelOf)).toEqual(["Tables"]);
        expect(descriptionOf(database)).toBeUndefined();
    });

    it("applies '!' patterns, ';' and ',' separators and ignores case", async () => {
        const { children, expandPath, connectionNode } = explorer("APP-*; other, !*-dev-2");
        const databases = await expandPath(await connectionNode("mssql-docker"), "Databases");
        expect((await children(databases)).map(labelOf)).toEqual([
            "System Databases",
            "app-dev-1",
            "app-rec-1",
            "Other",
        ]);
    });

    it("still shows '(filtered)' and filters again after the folder is refreshed", async () => {
        const { service, children, expandPath, connectionNode } = explorer("*-rec-*");
        const databases = await expandPath(await connectionNode("mssql-docker"), "Databases");
        expect((await children(databases)).map(labelOf)).toEqual(["System Databases", "app-rec-1"]);

        service.refreshNode(databases);
        expect((await children(databases)).map(labelOf)).toEqual(["System Databases", "app-rec-1"]);
        expect(descriptionOf(databases)).toBe("(filtered)");
    });

    it("leaves two profiles of the same server with their own filter", async () => {
        const { children, expandPath, connectionNode } = explorer("*-dev-*");
        // The PostgreSQL profile of this harness has no filter: same fake tree, nothing hidden.
        const other = await expandPath(await connectionNode("pg-docker"), "Databases");
        expect((await children(other)).length).toBe(5);
        expect(descriptionOf(other)).toBeUndefined();
    });
});

describe("PostgreSQL tree", () => {
    it("lists only the matching databases of the flat list", async () => {
        const { service, children, expandPath, connectionNode } = createExplorer(
            {},
            {},
            {
                connector: fakeConnector("pg"),
                databaseFilter: { pg: "*-rec-*;postgres" },
            },
        );
        const databases = await expandPath(await connectionNode("pg-docker"), "Databases");
        expect((await children(databases)).map(labelOf)).toEqual(["app-rec-1", "postgres"]);
        expect(descriptionOf(databases)).toBe("(filtered)");

        service.refreshNode(databases);
        expect((await children(databases)).map(labelOf)).toEqual(["app-rec-1", "postgres"]);
    });

    it("shows 'No items' when nothing matches", async () => {
        const { children, expandPath, connectionNode } = createExplorer(
            {},
            {},
            {
                connector: fakeConnector("pg"),
                databaseFilter: { pg: "nothing-*" },
            },
        );
        const databases = await expandPath(await connectionNode("pg-docker"), "Databases");
        expect((await children(databases)).map(labelOf)).toEqual(["No items"]);
        expect(descriptionOf(databases)).toBe("(filtered)");
    });
});
