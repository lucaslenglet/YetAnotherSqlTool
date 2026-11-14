import { describe, expect, it } from "vitest";
import { ConnectionGroupNode } from "../../src/objectExplorer/nodes/connectionGroupNode";
import { createExplorer, iconFile, labelOf } from "./serviceHarness";

// Nothing is expanded here, so these servers are never contacted.
const { children, connectionNode } = createExplorer(
    {
        server: "localhost,1433",
        database: "yast",
        authenticationType: "SqlLogin",
        user: "sa",
        password: "pw",
    },
    {
        server: "localhost",
        port: 5432,
        database: "yast",
        authenticationType: "SqlLogin",
        user: "yast",
        password: "pw",
    },
);

describe("root", () => {
    it("lists groups before connections, each sorted by label", async () => {
        const root = await children();
        expect(root.map(labelOf)).toEqual(["Dev", "Bad password", "PostgreSQL (Docker)"]);
        expect(root[0]).toBeInstanceOf(ConnectionGroupNode);
        expect((await children(root[0])).map(labelOf)).toEqual(["SQL Server (Docker)"]);
    });

    it("shows connections as disconnected servers until expanded", async () => {
        const node = await connectionNode("pg-docker");
        expect(node.context.type).toBe("disconnectedServer");
        expect(iconFile(node)).toBe("Database_red.svg");
    });
});
