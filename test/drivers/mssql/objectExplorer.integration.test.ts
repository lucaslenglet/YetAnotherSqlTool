import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriverConnection, ObjectNode } from "../../../src/drivers/types";
import { mssqlServer } from "../../support/databases";
import { connectToDocker } from "./helpers";

/** A node of docs/reference/mssql-object-explorer-tree.json (sqltoolsservice NodeInfo plus `children`). */
interface ReferenceNode {
    nodePath: string;
    parentNodePath: string;
    nodeType: string;
    nodeSubType: string | null;
    label: string;
    isLeaf: boolean;
    metadata: Record<string, unknown> | null;
    children?: ReferenceNode[];
}

/**
 * The capture comes from one particular SQL Server. The container started for this run has another
 * machine name (in URNs), other random suffixes in the names SQL Server gives to unnamed keys
 * and constraints (PK__customer__3213E83F430F8142), and the build the `2022-latest` image is at
 * that day (in the server node's label): both sides are compared without them.
 */
const VERSION_PLACEHOLDER = "<version>";
function normalize(json: string): string {
    return json
        .replace(/Server\[@Name='[^']*'\]/g, "Server[@Name='<server>']")
        .replace(/\b((?:PK|UQ|FK|DF|CK)__\w+?__)[0-9A-F]{8,16}\b/g, "$1<generated>")
        .replace(/\(SQL Server \d+(?:\.\d+){3} - /g, `(SQL Server ${VERSION_PLACEHOLDER} - `);
}

/** Root of the paths, "localhost,<port>": the port changes on every run. */
const server = mssqlServer();
const captured = readFileSync(
    resolve(__dirname, "../../../docs/reference/mssql-object-explorer-tree.json"),
    "utf8",
);
const capturedServer: string = JSON.parse(captured).nodePath;
const reference: ReferenceNode = JSON.parse(normalize(captured.replaceAll(capturedServer, server)));

/** Folders sqltoolsservice shows that the driver deliberately does not implement. */
const NOT_IMPLEMENTED_FOLDERS = new Set([
    "Dropped Ledger Tables",
    "External Tables",
    "Dropped Ledger Views",
    "Assemblies",
    "User-Defined Types (CLR)",
    "XML Schema Collections",
    "External Resources",
    "Service Broker",
    "Storage",
    "Asymmetric Keys",
    "Certificates",
    "Symmetric Keys",
    "Database Scoped Credentials",
    "Database Encryption Keys",
    "Master Keys",
    "Database Audit Specifications",
    "Security Policies",
    "Always Encrypted Keys",
    "Server Objects",
    "Credentials",
    "Cryptographic Providers",
    "Audits",
    "Server Audit Specifications",
]);

function isNotImplemented(path: string): boolean {
    return path.split("/").some((segment) => NOT_IMPLEMENTED_FOLDERS.has(segment));
}

async function walkTree(connection: DriverConnection): Promise<Map<string, ObjectNode>> {
    const nodes = new Map<string, ObjectNode>();
    const visit = async (node: ObjectNode) => {
        // objectExplorerObjects.test.ts creates temporary objects (in parallel) named yast_oe_* (and test/drivers/objectInfo.integration.test.ts yast_oi_*); leave them out.
        if (/yast_o[ei]_/.test(node.label)) return;
        const normalized: ObjectNode = JSON.parse(normalize(JSON.stringify(node)));
        nodes.set(normalized.nodePath, normalized);
        if (node.isLeaf) return;
        // Like the reference capture, do not go inside the system databases.
        if (node.nodeType === "Database" && node.parentNodePath.endsWith("/System Databases"))
            return;
        for (const child of await connection.expandNode(node)) await visit(child);
    };
    await visit(connection.getRootNode());
    return nodes;
}

function flattenReference(
    node: ReferenceNode,
    into = new Map<string, ReferenceNode>(),
): Map<string, ReferenceNode> {
    into.set(node.nodePath, node);
    node.children?.forEach((child) => flattenReference(child, into));
    return into;
}

/** The fields the Object Explorer uses, with null / "" / "None" folded together. */
function comparableFields(node: ObjectNode | ReferenceNode) {
    const subType = node.nodeSubType;
    return {
        nodePath: node.nodePath,
        parentNodePath: node.parentNodePath,
        nodeType: node.nodeType,
        nodeSubType: !subType || subType === "None" ? "" : subType,
        label: node.label,
        isLeaf: node.isLeaf,
        metadata: node.metadata ?? null,
    };
}

describe("Object Explorer", () => {
    let connection: DriverConnection;
    let actual: Map<string, ObjectNode>;
    beforeAll(async () => {
        connection = await connectToDocker();
        actual = await walkTree(connection);
    });
    afterAll(() => connection.close());

    it("fills ServerInfo", () => {
        expect(connection.serverInfo).toMatchObject({
            productName: "SQL Server",
            isCloud: false,
            userName: "sa",
        });
        expect(connection.serverInfo.serverVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    });

    it("has every implemented reference node, identical", () => {
        const referenceNodes = flattenReference(reference);
        const problems: string[] = [];
        for (const [path, expectedNode] of referenceNodes) {
            // The reference holds one placeholder node without a path (under Database Encryption Keys).
            if (path === "" || isNotImplemented(path)) continue;
            const actualNode = actual.get(path);
            if (!actualNode) {
                problems.push(`missing: ${path}`);
                continue;
            }
            const expected = comparableFields(expectedNode);
            const received = comparableFields(actualNode);
            if (JSON.stringify(expected) !== JSON.stringify(received)) {
                problems.push(
                    `different: ${path}\n  expected ${JSON.stringify(expected)}\n  received ${JSON.stringify(received)}`,
                );
            }
        }
        expect(problems).toEqual([]);
    });

    it("has no node the reference does not have", () => {
        const referenceNodes = flattenReference(reference);
        const extra = [...actual.keys()].filter((path) => !referenceNodes.has(path));
        expect(extra).toEqual([]);
    });

    it("labels the server node like sqltoolsservice", () => {
        // The capture holds the version of the image it was taken on; 2022-latest moves on.
        const expected = reference.label.replace(
            VERSION_PLACEHOLDER,
            connection.serverInfo.serverVersion,
        );
        expect(connection.getRootNode().label).toBe(expected);
    });

    it("sets the database of database-level nodes", () => {
        const column = actual.get(`${server}/Databases/yast/Tables/dbo.customers/Columns/id`);
        expect(column?.database).toBe("yast");
        expect(actual.get(`${server}/Databases/yast/Tables`)?.database).toBe("yast");
        expect(actual.get(`${server}/Databases`)?.database).toBeUndefined();
        expect(actual.get(`${server}/Security/Logins`)?.database).toBeUndefined();
    });

    it("does not change the session database", async () => {
        const root = connection.getRootNode();
        await connection.expandNode(root);
        expect(await connection.getCurrentDatabase()).toBe("yast");
    });
});
