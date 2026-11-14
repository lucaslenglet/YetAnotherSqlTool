import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriverConnection, ObjectNode } from "../../../src/drivers/types";
import { mssqlServer } from "../../support/databases";
import { connectToDocker, runScript } from "./helpers";

// The test database only has two plain tables, so this test creates every other kind of object
// in a uniquely named schema of the yast database, and drops it all afterwards.
const S = `yast_oe_${randomBytes(4).toString("hex")}`;

const SETUP = `
CREATE SCHEMA [${S}];
GO
CREATE TABLE [${S}].parent (
    id int NOT NULL PRIMARY KEY,
    code nvarchar(max) NULL,
    amount decimal(10,2) NOT NULL CONSTRAINT [${S}_df] DEFAULT 0,
    ts datetime2(3) NULL,
    payload varbinary(max) NULL,
    CONSTRAINT [${S}_ck] CHECK (amount >= 0)
);
CREATE TABLE [${S}].child (
    id int NOT NULL,
    parent_id int NOT NULL,
    CONSTRAINT [${S}_child_pk] PRIMARY KEY (id, parent_id),
    CONSTRAINT [${S}_child_fk] FOREIGN KEY (parent_id) REFERENCES [${S}].parent(id)
);
CREATE NONCLUSTERED INDEX [${S}_ix] ON [${S}].parent (ts);
GO
CREATE VIEW [${S}].v AS SELECT id, code FROM [${S}].parent;
GO
CREATE PROCEDURE [${S}].p AS SELECT 1;
GO
CREATE FUNCTION [${S}].f_scalar() RETURNS int AS BEGIN RETURN 1 END;
GO
CREATE FUNCTION [${S}].f_table() RETURNS TABLE AS RETURN SELECT 1 AS x;
GO
CREATE TRIGGER [${S}].trg ON [${S}].parent AFTER INSERT AS BEGIN SET NOCOUNT ON; END;
GO
CREATE SYNONYM [${S}].syn FOR [${S}].parent;
CREATE SEQUENCE [${S}].seq;
CREATE TYPE [${S}].mytype FROM nvarchar(50) NOT NULL;
CREATE TYPE [${S}].mytable AS TABLE (a int);
GO
CREATE TABLE [${S}].aliased (a [${S}].mytype);
`;

const CLEANUP = `
DROP TABLE IF EXISTS [${S}].aliased;
DROP TYPE IF EXISTS [${S}].mytable;
DROP TYPE IF EXISTS [${S}].mytype;
DROP SEQUENCE IF EXISTS [${S}].seq;
DROP SYNONYM IF EXISTS [${S}].syn;
DROP TRIGGER IF EXISTS [${S}].trg;
DROP FUNCTION IF EXISTS [${S}].f_table;
DROP FUNCTION IF EXISTS [${S}].f_scalar;
DROP PROCEDURE IF EXISTS [${S}].p;
DROP VIEW IF EXISTS [${S}].v;
DROP TABLE IF EXISTS [${S}].child;
DROP TABLE IF EXISTS [${S}].parent;
DROP SCHEMA IF EXISTS [${S}];
`;

describe("Object Explorer: objects created for the test", () => {
    let connection: DriverConnection;
    const db = `${mssqlServer()}/Databases/yast`;

    /** Expands the node at `path`, walking down from the root. */
    async function childrenOf(path: string): Promise<ObjectNode[]> {
        let node = connection.getRootNode();
        for (const segment of path.split("/").slice(node.nodePath.split("/").length)) {
            const children = await connection.expandNode(node);
            const next = children.find((c) => c.nodePath === `${node.nodePath}/${segment}`);
            if (!next) throw new Error(`No node ${segment} under ${node.nodePath}`);
            node = next;
        }
        return connection.expandNode(node);
    }
    const labels = async (path: string) => (await childrenOf(path)).map((n) => n.label);

    beforeAll(async () => {
        connection = await connectToDocker();
        await runScript(connection, SETUP);
    });
    afterAll(async () => {
        await runScript(connection, CLEANUP);
        await connection.close();
    });

    it("lists tables and views of the schema", async () => {
        expect((await labels(`${db}/Tables`)).filter((l) => l.startsWith(`${S}.`))).toEqual([
            `${S}.aliased`,
            `${S}.child`,
            `${S}.parent`,
        ]);
        expect((await labels(`${db}/Views`)).filter((l) => l.startsWith(`${S}.`))).toEqual([
            `${S}.v`,
        ]);
    });

    it("labels columns with key flags, type sizes and nullability", async () => {
        expect(await labels(`${db}/Tables/${S}.parent/Columns`)).toEqual([
            "id (PK, int, not null)",
            "code (nvarchar(max), null)",
            "amount (decimal(10,2), not null)",
            "ts (datetime2(3), null)",
            "payload (varbinary(max), null)",
        ]);
        expect(await labels(`${db}/Tables/${S}.child/Columns`)).toEqual([
            "id (PK, int, not null)",
            "parent_id (PK, FK, int, not null)",
        ]);
        expect(await labels(`${db}/Tables/${S}.aliased/Columns`)).toEqual([
            "a (mytype(nvarchar(50)), not null)",
        ]);
        expect(await labels(`${db}/Views/${S}.v/Columns`)).toEqual([
            "id (int, not null)",
            "code (nvarchar(max), null)",
        ]);
    });

    it("lists keys, constraints, triggers, indexes and statistics of a table", async () => {
        const keys = await childrenOf(`${db}/Tables/${S}.child/Keys`);
        expect(keys.map((k) => [k.label, k.nodeSubType, k.metadata?.metadataTypeName])).toEqual([
            [`${S}_child_pk`, "PrimaryKey", "Index"],
            [`${S}_child_fk`, "ForeignKey", "ForeignKey"],
        ]);
        expect(await labels(`${db}/Tables/${S}.parent/Constraints`)).toEqual([
            `${S}_ck`,
            `${S}_df`,
        ]);
        const triggers = await childrenOf(`${db}/Tables/${S}.parent/Triggers`);
        expect(triggers.map((t) => [t.nodeType, t.label])).toEqual([["Trigger", "trg"]]);
        expect(await labels(`${db}/Tables/${S}.parent/Indexes`)).toEqual([
            expect.stringMatching(/^PK__parent__\w+ \(Unique, Clustered\)$/),
            `${S}_ix (Non-Unique, Non-Clustered)`,
        ]);
        expect((await labels(`${db}/Tables/${S}.parent/Statistics`)).sort()).toContain(`${S}_ix`);
    });

    it("lists programmability objects with their node types", async () => {
        const typed = async (path: string) =>
            (await childrenOf(path))
                .filter((n) => n.label.startsWith(`${S}.`))
                .map((n) => [n.nodeType, n.label]);
        expect(await typed(`${db}/Synonyms`)).toEqual([["Synonym", `${S}.syn`]]);
        expect(await typed(`${db}/Programmability/Stored Procedures`)).toEqual([
            ["StoredProcedure", `${S}.p`],
        ]);
        expect(await typed(`${db}/Programmability/Functions/Scalar-valued Functions`)).toEqual([
            ["ScalarValuedFunction", `${S}.f_scalar`],
        ]);
        expect(await typed(`${db}/Programmability/Functions/Table-valued Functions`)).toEqual([
            ["TableValuedFunction", `${S}.f_table`],
        ]);
        expect(await typed(`${db}/Programmability/Types/User-Defined Data Types`)).toEqual([
            ["UserDefinedDataType", `${S}.mytype`],
        ]);
        expect(await typed(`${db}/Programmability/Types/User-Defined Table Types`)).toEqual([
            ["UserDefinedTableType", `${S}.mytable`],
        ]);
        expect(await typed(`${db}/Programmability/Sequences`)).toEqual([["Sequence", `${S}.seq`]]);
    });

    it("lists the schema among the security objects", async () => {
        expect(await labels(`${db}/Security/Schemas`)).toContain(S);
        expect(await labels(`${db}/Security/Users`)).toContain("dbo");
    });

    it("gives procedures and views the metadata type sqltoolsservice uses", async () => {
        const [procedure] = (await childrenOf(`${db}/Programmability/Stored Procedures`)).filter(
            (n) => n.label === `${S}.p`,
        );
        expect(procedure.metadata).toMatchObject({
            metadataType: 2,
            metadataTypeName: "StoredProcedure",
            schema: S,
            name: "p",
        });
        const [view] = (await childrenOf(`${db}/Views`)).filter((n) => n.label === `${S}.v`);
        expect(view.metadata).toMatchObject({
            metadataType: 1,
            metadataTypeName: "View",
            schema: S,
            name: "v",
        });
    });
});
