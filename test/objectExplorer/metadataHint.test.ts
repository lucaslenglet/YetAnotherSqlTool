import { describe, expect, it, vi } from "vitest";
import type { DriverConnection, ObjectNode } from "../../src/drivers/types";
import type { IConnector } from "../../src/objectExplorer/objectExplorerService";
import { createExplorer, labelOf } from "./serviceHarness";

// A connection node that connects tells its driver connection that catalog reads will follow, so
// the driver can open its metadata connection before the user expands anything.

const server: ObjectNode = {
    nodePath: "fake-server",
    parentNodePath: "",
    nodeType: "Server",
    label: "fake-server",
    isLeaf: false,
};

function fakeConnector(prepareMetadata?: () => void): IConnector {
    const connection = {
        getRootNode: () => server,
        expandNode: async () => [
            { ...server, nodePath: "fake-server/Databases", label: "Databases" },
        ],
        close: async () => undefined,
        ...(prepareMetadata ? { prepareMetadata } : {}),
    } as unknown as DriverConnection;
    return { connect: async () => connection };
}

const prepareMetadata = vi.fn();
const withHint = createExplorer({}, {}, { connector: fakeConnector(prepareMetadata) });
const withoutHint = createExplorer({}, {}, { connector: fakeConnector() });

describe("connecting a node", () => {
    it("asks the driver to prepare the server-level metadata, once", async () => {
        const node = await withHint.connectionNode("mssql-docker");

        expect(await withHint.service.connectNode(node)).toBe(true);

        expect(prepareMetadata).toHaveBeenCalledTimes(1);
        expect(prepareMetadata).toHaveBeenCalledWith();
    });

    it("works with a driver that has no hint", async () => {
        const node = await withoutHint.connectionNode("mssql-docker");

        const children = await withoutHint.children(node);

        expect(children.map(labelOf)).toEqual(["Databases"]);
    });
});
