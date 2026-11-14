// Dev tool: asks Microsoft's sqltoolsservice to script objects ("Script as Select / Create / Alter /
// Drop / Execute"), the way vscode-mssql's ScriptingService does, and records the exact text.
// This is the oracle for the SQL Server driver's scripts. Output: object -> operation -> script.
// Usage: start the databases with `npm run dev:db` in another terminal, then run
//   MSSQL_SA_PASSWORD='<password printed by dev:db>' node tools/sts-script-probe.js docs/reference
// To capture more, add objects to OBJECTS or operations to OPERATIONS.
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const rpc = require(path.join(__dirname, "../node_modules/vscode-jsonrpc/lib/node/main.js"));

const STS = path.join(
    process.env.HOME,
    ".vscode/extensions/ms-mssql.mssql-1.46.0/sqltoolsservice/6.0.20260918.1/Portable/MicrosoftSqlToolsServiceLayer.dll",
);
const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });

// Created in a database of its own (dropped at the end): the tables of test/fixtures/mssql, then
// the objects of test/fixtures/scripting/mssql-objects.sql. The integration tests build the same.
const DATABASE = "yast_probe";
const FIXTURE_TABLES = path.join(__dirname, "../test/fixtures/mssql/01-schema.sql");
const OBJECTS_SQL = path.join(__dirname, "../test/fixtures/scripting/mssql-objects.sql");

// Same fields as the objects' ObjectMetadata in the Object Explorer: type is metadataTypeName,
// then schema, name, parentName, parentTypeName. The key names the object in the output.
const OBJECTS = [
    ["dbo.customers", "Table", "dbo", "customers"],
    ["dbo.orders", "Table", "dbo", "orders"],
    ["probe.odd ] table", "Table", "probe", "odd ] table"],
    ["probe.special", "Table", "probe", "special"],
    ["probe.temporal", "Table", "probe", "temporal"],
    ["probe.temporal_visible", "Table", "probe", "temporal_visible"],
    ["probe.v_customers", "View", "probe", "v_customers"],
    ["probe.odd ] view", "View", "probe", "odd ] view"],
    ["probe.p_hello", "StoredProcedure", "probe", "p_hello"],
    ["probe.f_scalar", "UserDefinedFunction", "probe", "f_scalar"],
    ["probe.f_table", "UserDefinedFunction", "probe", "f_table"],
    ["probe.all_types", "Table", "probe", "all_types"],
    ["probe.parent", "Table", "probe", "parent"],
    ["probe.child", "Table", "probe", "child"],
    ["probe.temporal_history", "Table", "probe", "temporal_history"],
    ["probe.v_child", "View", "probe", "v_child"],
    ["probe.p_params", "StoredProcedure", "probe", "p_params"],
    ["probe.p_noparams", "StoredProcedure", "probe", "p_noparams"],
    ["probe.p_quoted_off", "StoredProcedure", "probe", "p_quoted_off"],
    ["probe.f_multi", "UserDefinedFunction", "probe", "f_multi"],
    ["probe.phone", "UserDefinedDataType", "probe", "phone"],
    ["probe.amount", "UserDefinedDataType", "probe", "amount"],
    ["probe.line_items", "UserDefinedTableType", "probe", "line_items"],
    ["probe.seq_full", "Sequence", "probe", "seq_full"],
    ["probe.seq_default", "Sequence", "probe", "seq_default"],
    ["probe.seq_small", "Sequence", "probe", "seq_small"],
    ["probe.syn_child", "Synonym", "probe", "syn_child"],
    ["probe", "Schema", null, "probe"],
    ["odd ] schema", "Schema", null, "odd ] schema"],
    ["probe_user", "User", null, "probe_user"],
    ["probe_role", "Role", null, "probe_role"],
    ["probe_app", "ApplicationRole", null, "probe_app"],
    ["trg_ddl_probe", "Trigger", null, "trg_ddl_probe"],
    ["probe.child/trg_child_ins", "Trigger", "probe", "trg_child_ins", "child", "Table"],
    ["probe.child/trg_child_disabled", "Trigger", "probe", "trg_child_disabled", "child", "Table"],
    ["probe.v_child/trg_v_child", "Trigger", "probe", "trg_v_child", "v_child", "View"],
    ["probe.parent/PK_parent", "Index", "probe", "PK_parent", "parent", "Table"],
    ["probe.parent/UQ_parent_code", "Index", "probe", "UQ_parent_code", "parent", "Table"],
    ["probe.parent/CIX_parent_created", "Index", "probe", "CIX_parent_created", "parent", "Table"],
    ["probe.child/PK_child", "Index", "probe", "PK_child", "child", "Table"],
    ["probe.child/IX_child_note", "Index", "probe", "IX_child_note", "child", "Table"],
    ["probe.child/IX_child_status", "Index", "probe", "IX_child_status", "child", "Table"],
    ["probe.child/FK_child_parent", "ForeignKey", "probe", "FK_child_parent", "child", "Table"],
    [
        "probe.child/FK_child_parent_nocheck",
        "ForeignKey",
        "probe",
        "FK_child_parent_nocheck",
        "child",
        "Table",
    ],
    ["probe.idx_more", "Table", "probe", "idx_more"],
    ["probe.idx_more/PK_idx_more", "Index", "probe", "PK_idx_more", "idx_more", "Table"],
    ["probe.idx_more/IX_inc", "Index", "probe", "IX_inc", "idx_more", "Table"],
    ["probe.idx_more/IX_filter", "Index", "probe", "IX_filter", "idx_more", "Table"],
    ["probe.idx_more/UX_b", "Index", "probe", "UX_b", "idx_more", "Table"],
    ["probe.idx_more/IX_comp", "Index", "probe", "IX_comp", "idx_more", "Table"],
    ["probe.v_indexed", "View", "probe", "v_indexed"],
    ["probe.v_indexed/UCX_v_indexed", "Index", "probe", "UCX_v_indexed", "v_indexed", "View"],
    ["probe.p_create_or_alter", "StoredProcedure", "probe", "p_create_or_alter"],
    ["probe.p_lower", "StoredProcedure", "probe", "p_lower"],
    ["probe.v_trailing", "View", "probe", "v_trailing"],
    ["probe_owned", "Schema", null, "probe_owned"],
    ["probe_role_owned", "Role", null, "probe_role_owned"],
    ["probe_login_user", "User", null, "probe_login_user"],
    // The Object Explorer gives database triggers the type "Trigger" (above), which SMO fails on.
    ["trg_ddl_probe/DdlTrigger", "DdlTrigger", null, "trg_ddl_probe"],
    ["trg_ddl_probe/DatabaseDdlTrigger", "DatabaseDdlTrigger", null, "trg_ddl_probe"],
];
// Server-level login used by a user of OBJECTS_SQL; created before it and dropped at the end.
const LOGIN = "yast_oe_probe_login";
// vscode-mssql's ScriptOperation values; the name is the key in the output.
const OPERATIONS = { select: 0, create: 1, delete: 4, execute: 5, alter: 6 };
// scriptCreateDrop of createScriptingRequestParams: Select -> ScriptSelect, Delete -> ScriptDrop, others ScriptCreate.
const CREATE_DROP = { select: "ScriptSelect", delete: "ScriptDrop" };

const proc = cp.spawn("dotnet", [STS], { stdio: ["pipe", "pipe", "ignore"] });
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(proc.stdout),
    new rpc.StreamMessageWriter(proc.stdin),
);
const waiters = {};
const waitFor = (name) =>
    new Promise((resolve, reject) => {
        waiters[name] = resolve;
        setTimeout(() => reject(new Error("timeout waiting for " + name)), 60000);
    });
for (const name of ["connection/complete", "query/complete"]) {
    conn.onNotification(name, (p) => waiters[name]?.(p));
}
// Scripting notifications carry the operation id. Several can come for one operation (a progress
// error then the completion): the first one ends it, the others must not end the next operation.
// They can also arrive before the response that gives the id: the first one is kept until asked.
const scriptResults = new Map();
const scriptWaiters = new Map();
for (const name of ["scripting/scriptComplete", "scripting/scriptProgressNotification"]) {
    conn.onNotification(name, (p) => {
        if (name === "scripting/scriptProgressNotification" && !p.errorMessage) return;
        if (scriptResults.has(p.operationId)) return;
        scriptResults.set(p.operationId, p);
        scriptWaiters.get(p.operationId)?.(p);
    });
}
const waitForScript = (operationId) =>
    new Promise((resolve, reject) => {
        if (scriptResults.has(operationId)) return resolve(scriptResults.get(operationId));
        scriptWaiters.set(operationId, resolve);
        setTimeout(() => reject(new Error("timeout scripting " + operationId)), 60000);
    });
conn.onNotification(() => {});
conn.listen();

async function runSql(uri, query) {
    const done = waitFor("query/complete");
    await conn.sendRequest("query/executeString", { ownerUri: uri, query });
    const complete = await done;
    for (const batch of complete.batchSummaries) {
        for (const message of batch.messages ?? []) {
            if (message.isError) throw new Error(`${query}\n${message.message}`);
        }
    }
}

async function script(
    uri,
    serverInfo,
    [, type, schema, name, parentName, parentTypeName],
    operation,
) {
    const params = {
        filePath: undefined,
        scriptDestination: "ToEditor",
        connectionString: undefined,
        scriptingObjects: [{ type, schema: schema ?? undefined, name, parentName, parentTypeName }],
        scriptOptions: {
            scriptCreateDrop: CREATE_DROP[operation] ?? "ScriptCreate",
            typeOfDataToScript: "SchemaOnly",
            scriptStatistics: "ScriptStatsNone",
            targetDatabaseEngineEdition: "SqlServerEnterpriseEdition",
            targetDatabaseEngineType: "SingleInstance",
            scriptCompatibilityOption: `Script${serverInfo.serverMajorVersion}0Compat`,
        },
        ownerURI: uri,
        operation: OPERATIONS[operation],
        returnScriptAsynchronously: true,
    };
    // Either notification ends the operation (a progress error is fatal, as in vscode-mssql).
    const { operationId } = await conn.sendRequest("scripting/script", params);
    const result = await waitForScript(operationId);
    return result.errorMessage ? { error: result.errorMessage } : result.script;
}

/** Connects `uri` to a database of the dev server and returns sqltoolsservice's serverInfo. */
async function connect(uri, database) {
    const options = {
        server: "localhost,11433",
        database,
        user: "sa",
        password: process.env.MSSQL_SA_PASSWORD,
        authenticationType: "SqlLogin",
        trustServerCertificate: true,
        encrypt: "Mandatory",
        applicationName: "probe",
    };
    const connected = waitFor("connection/complete");
    await conn.sendRequest("connection/connect", { ownerUri: uri, connection: { options } });
    const c = await connected;
    if (c.errorMessage) throw new Error(c.errorMessage);
    return c.serverInfo;
}

const DROP_DATABASE = `IF DB_ID('${DATABASE}') IS NOT NULL BEGIN
    ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE [${DATABASE}];
END
IF SUSER_ID('${LOGIN}') IS NOT NULL DROP LOGIN [${LOGIN}]`;

(async () => {
    let master;
    try {
        master = "untitled:master";
        await connect(master, "master");
        await runSql(master, DROP_DATABASE);
        await runSql(master, `CREATE DATABASE [${DATABASE}]`);
        await runSql(
            master,
            `CREATE LOGIN [${LOGIN}] WITH PASSWORD = N'Pr0be-Login-Pass!', CHECK_POLICY = OFF`,
        );

        const uri = "untitled:probe";
        const serverInfo = await connect(uri, DATABASE);
        // The fixture creates and selects the yast database first: keep its tables only.
        const tables = fs
            .readFileSync(FIXTURE_TABLES, "utf8")
            .split(/^GO$/m)
            .filter((batch) => !/CREATE DATABASE|^\s*USE /m.test(batch))
            .join("GO");
        await runSql(uri, tables);
        await runSql(uri, fs.readFileSync(OBJECTS_SQL, "utf8"));

        const result = { serverVersion: serverInfo.serverVersion, scripts: {} };
        for (const object of OBJECTS) {
            result.scripts[object[0]] = { type: object[1] };
            for (const operation of Object.keys(OPERATIONS)) {
                result.scripts[object[0]][operation] = await script(
                    uri,
                    serverInfo,
                    object,
                    operation,
                );
            }
        }
        await conn.sendRequest("connection/disconnect", { ownerUri: uri });
        fs.writeFileSync(
            path.join(outDir, "mssql-scripts.json"),
            JSON.stringify(result, null, 2) + "\n",
        );
        console.log("captured", OBJECTS.length, "objects");
    } catch (e) {
        console.error("ERROR", e.message);
        process.exitCode = 1;
    } finally {
        if (master) await runSql(master, DROP_DATABASE).catch(() => undefined);
        proc.kill();
        process.exit();
    }
})();
