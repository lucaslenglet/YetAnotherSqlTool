import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { mssqlOptions, pgOptions } from "../support/databases";
import { createExplorer, labelOf } from "./serviceHarness";

// The database filter of a profile, on the real servers. It only uses the databases that exist
// anyway (yast and the system ones): other test files create databases on the same servers at
// the same time, so nothing here lists a server completely except to look for a name.

const unfiltered = createExplorer(mssqlOptions(), pgOptions());
const filtered = createExplorer(mssqlOptions(), pgOptions(), {
    databaseFilter: { mssql: "YAST;ms*", pg: "yast" },
});

const descriptionOf = (item: vscode.TreeItem) => item.description;

describe("SQL Server", () => {
    it("lists every database of an unfiltered connection", async () => {
        const { children, expandPath, connectionNode } = unfiltered;
        const databases = await expandPath(await connectionNode("mssql-docker"), "Databases");
        expect((await children(databases)).map(labelOf)).toContain("yast");
        expect(descriptionOf(databases)).toBeUndefined();

        const system = await expandPath(databases, "System Databases");
        expect((await children(system)).map(labelOf)).toEqual(
            expect.arrayContaining(["master", "model", "msdb", "tempdb"]),
        );
        expect(descriptionOf(system)).toBeUndefined();
    });

    it("lists only the matching databases, system ones included, and marks the folders", async () => {
        const { children, expandPath, connectionNode } = filtered;
        const databases = await expandPath(await connectionNode("mssql-docker"), "Databases");
        const labels = (await children(databases)).map(labelOf);
        expect(labels).toContain("System Databases");
        expect(labels.filter((l) => l !== "System Databases")).toEqual(["yast"]);
        expect(descriptionOf(databases)).toBe("(filtered)");

        const system = await expandPath(databases, "System Databases");
        expect((await children(system)).map(labelOf)).toEqual(["msdb"]);
        expect(descriptionOf(system)).toBe("(filtered)");
    });

    it("still expands a database that matches", async () => {
        const { children, expandPath, connectionNode } = filtered;
        const tables = await expandPath(
            await connectionNode("mssql-docker"),
            "Databases",
            "yast",
            "Tables",
        );
        expect((await children(tables)).map(labelOf)).toContain("dbo.customers");
    });
});

describe("PostgreSQL", () => {
    it("lists every database of an unfiltered connection", async () => {
        const { children, expandPath, connectionNode } = unfiltered;
        const databases = await expandPath(await connectionNode("pg-docker"), "Databases");
        expect((await children(databases)).map(labelOf)).toEqual(
            expect.arrayContaining(["postgres", "yast"]),
        );
        expect(descriptionOf(databases)).toBeUndefined();
    });

    it("lists only the matching databases and marks the folder", async () => {
        const { children, expandPath, connectionNode } = filtered;
        const databases = await expandPath(await connectionNode("pg-docker"), "Databases");
        expect((await children(databases)).map(labelOf)).toEqual(["yast"]);
        expect(descriptionOf(databases)).toBe("(filtered)");
    });
});
