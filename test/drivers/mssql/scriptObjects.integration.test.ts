import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptObject } from "../../../src/drivers/mssql/scripting";
import type { Row } from "../../../src/drivers/mssql/objectExplorer";
import type { DriverConnection, ScriptOperation } from "../../../src/drivers/types";
import { connectToDocker, runScript } from "./helpers";
import { capturedScripts, fixtureTablesSql, nodeFor, objectsSql } from "./scriptReference";

// "Script as Create / Drop / Alter / Execute" on a real SQL Server, against what sqltoolsservice
// returned for the same objects (docs/reference/mssql-scripts.json).
//
// With RECORD_SCRIPT_CATALOG=1 the test also writes the parameters and rows of the catalog queries
// the driver ran for each script, in order, to test/fixtures/scripting/mssql-catalog.json, which
// test/drivers/mssql/scripts.test.ts replays without a database. Record again when the catalog
// queries change.

// A fixed name (the recording contains it), with the "yast_oe_" prefix that keeps it out of the
// Object Explorer comparison. Containers are fresh on every run.
const DB = "yast_oe_scripts";
const LOGIN = "yast_oe_probe_login";

const SETUP = `
BEGIN TRY CREATE LOGIN [${LOGIN}] WITH PASSWORD = N'Pr0be-Login-Pass!', CHECK_POLICY = OFF END TRY
BEGIN CATCH END CATCH
GO
CREATE DATABASE [${DB}];
GO
USE [${DB}];
GO
${fixtureTablesSql}
GO
${objectsSql}`;

const CLEANUP = `
USE master;
ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
DROP DATABASE [${DB}];
`;

const RECORDING = resolve(__dirname, "../../fixtures/scripting/mssql-catalog.json");

describe("Script as Create / Drop / Alter / Execute (SQL Server)", () => {
    let connection: DriverConnection;
    /** "key|operation" -> [parameters, rows] of each catalog query run while scripting it. */
    const recording: Record<string, Array<[Record<string, string>, Row[]]>> = {};

    /** Scripts a captured object with the driver; records the catalog rows it read. */
    async function script(key: string, operation: ScriptOperation, record = true): Promise<string> {
        const node = nodeFor(key, DB)!;
        const calls: (typeof recording)[string] = [];
        if (record) recording[`${key}|${operation}`] = calls;
        const runQuery = async (
            _database: string | undefined,
            text: string,
            parameters: Record<string, string> = {},
        ) => {
            const rows = await queryRows(text, parameters);
            calls.push([parameters, rows]);
            return rows;
        };
        return scriptObject(node, operation, runQuery, 16);
    }

    /** The connection's own catalog runner (private: the driver passes it to scriptObject). */
    const queryRows = (text: string, parameters: Record<string, string>): Promise<Row[]> =>
        (connection as unknown as { runMetadataQuery: RunQuery }).runMetadataQuery(
            DB,
            text,
            parameters,
        );

    beforeAll(async () => {
        connection = await connectToDocker();
        const events = await runScript(connection, SETUP);
        const errors = events.filter((e) => e.type === "message" && e.isError);
        expect(errors).toEqual([]);
    }, 120000);

    afterAll(async () => {
        if (process.env.RECORD_SCRIPT_CATALOG) {
            // One script per line: the file stays readable in diffs.
            const lines = Object.entries(recording).map(
                ([key, calls]) => `${JSON.stringify(key)}: ${JSON.stringify(calls)}`,
            );
            writeFileSync(RECORDING, `{\n${lines.join(",\n")}\n}\n`);
        }
        await runScript(connection, CLEANUP);
        await connection.close();
    });

    for (const { key, operation, script: expected } of capturedScripts()) {
        it(`scripts ${key} as ${operation} like sqltoolsservice`, async () => {
            expect(await script(key, operation)).toBe(expected);
        });
    }

    /** Runs a script on the session, which is in the test database; fails on any error. */
    async function run(text: string) {
        const events = await runScript(connection, text);
        expect(events.filter((e) => e.type === "message" && e.isError)).toEqual([]);
    }

    // Objects that nothing else depends on (a schema-bound view, a foreign key or a column of an
    // alias type would prevent the drop): Drop, then Create, then the object scripts the same.
    // Not the temporal tables: SMO's own Create script of one fails ("System versioned temporal
    // table must have primary key defined": the key comes after CREATE TABLE ... SYSTEM_VERSIONING
    // = ON), and ours is the same text. The database script writes them another way.
    const ROUND_TRIPS = [
        "dbo.orders",
        "probe.special",
        "probe.all_types",
        "probe.odd ] table",
        "probe.v_customers",
        "probe.odd ] view",
        "probe.v_child",
        "probe.v_indexed",
        "probe.v_trailing",
        "probe.p_hello",
        "probe.p_params",
        "probe.p_noparams",
        "probe.p_quoted_off",
        "probe.p_create_or_alter",
        "probe.p_lower",
        "probe.f_scalar",
        "probe.f_table",
        "probe.f_multi",
        "probe.child/trg_child_ins",
        "probe.child/trg_child_disabled",
        "probe.v_child/trg_v_child",
        "trg_ddl_probe/DdlTrigger",
        "probe.parent/CIX_parent_created",
        "probe.child/PK_child",
        "probe.child/IX_child_note",
        "probe.child/IX_child_status",
        "probe.child/FK_child_parent",
        "probe.child/FK_child_parent_nocheck",
        "probe.idx_more/IX_inc",
        "probe.idx_more/IX_filter",
        "probe.idx_more/UX_b",
        "probe.idx_more/IX_comp",
        "probe.v_indexed/UCX_v_indexed",
        "probe.seq_full",
        "probe.seq_default",
        "probe.seq_small",
        "probe.syn_child",
        "odd ] schema",
        "probe_owned",
        "probe_login_user",
        "probe_role",
        "probe_app",
    ];
    for (const key of ROUND_TRIPS) {
        it(`drops and creates ${key} again with its scripts`, async () => {
            const create = await script(key, "create", false);
            await run(await script(key, "delete", false));
            await expect(script(key, "create", false)).rejects.toThrow(/does not exist/);
            await run(create);
            expect(await script(key, "create", false)).toBe(create);
        });
    }

    it("runs the Execute script of a procedure once its parameters are set", async () => {
        const execute = await script("probe.p_noparams", "execute", false);
        await run(execute);
    });
});

type RunQuery = (
    database: string,
    text: string,
    parameters: Record<string, string>,
) => Promise<Row[]>;
