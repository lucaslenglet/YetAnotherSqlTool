import { describe, expect, it } from "vitest";
import { ConnectionGroupNode } from "../../src/objectExplorer/nodes/connectionGroupNode";
import { createExplorer, iconFile, labelOf } from "./serviceHarness";
import { ObjectExplorerService } from "../../src/objectExplorer/objectExplorerService";
import { Connector } from "../../src/connections/connector";
import {
    ConnectionConfig,
    type IConnectionConfig,
} from "../../src/connectionconfig/connectionconfig";

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

describe("empty view", () => {
    it("offers to add a connection and to import the ones of the SQL Server extension", async () => {
        const connectionConfig = {
            getGroups: async () => [{ id: ConnectionConfig.ROOT_GROUP_ID, name: "ROOT" }],
            getConnections: async () => [],
        } as unknown as IConnectionConfig;
        const service = new ObjectExplorerService(
            { connectionConfig, removeProfile: async () => true },
            new Connector(),
            () => undefined,
        );

        const items = await service.getChildren();

        expect(items.map(labelOf)).toEqual([
            "Add Connection",
            "Import Connections from SQL Server Extension",
        ]);
        expect((items[1].command as { command: string }).command).toBe(
            "yast.importMssqlConnections",
        );
        service.dispose();
    });
});
