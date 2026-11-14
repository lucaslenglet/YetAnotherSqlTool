// Dev tool: runs queries through Microsoft's sqltoolsservice and records the exact text it displays
// for each cell type. This is the oracle for the SQL Server driver's cell formatting.
// Usage: start the databases with `npm run dev:db` in another terminal, then run
//   MSSQL_SA_PASSWORD='<password printed by dev:db>' node tools/sts-query-probe.js docs/reference
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

// [column name, SQL type, "typical" value expression, "edge" value expression]
const COLUMNS = [
    ["c_int", "int", "42", "-2147483648"],
    ["c_bigint", "bigint", "1234567890123", "-9223372036854775808"],
    ["c_smallint", "smallint", "-123", "32767"],
    ["c_tinyint", "tinyint", "200", "0"],
    ["c_decimal", "decimal(10,2)", "1234.50", "-0.01"],
    ["c_numeric", "numeric(38,10)", "12345.6789012345", "0.0000000001"],
    ["c_float", "float", "3.14159265358979", "1e300"],
    ["c_float2", "float", "100", "0.0000123"],
    ["c_real", "real", "2.5", "1e-10"],
    ["c_money", "money", "1234.5678", "-1234567.8901"],
    ["c_smallmoney", "smallmoney", "12.34", "-214748.3648"],
    ["c_float3", "float", "1e0/3", "1e15"],
    ["c_float4", "float", "123456789012345", "0.0001"],
    ["c_float5", "float", "0.00001", "-0.0"],
    ["c_float6", "float", "123456789012345678", "1e14"],
    ["c_real2", "real", "1e0/3", "1e15"],
    ["c_real3", "real", "123456.7", "0.00001"],
    ["c_money2", "money", "100", "0.5"],
    ["c_smallmoney2", "smallmoney", "0.5", "100"],
    ["c_decimal2", "decimal(10,2)", "5", "0"],
    ["c_bit", "bit", "1", "0"],
    ["c_date", "date", "'2024-03-15'", "'0001-01-01'"],
    ["c_time", "time(7)", "'13:45:30.1234567'", "'00:00:00'"],
    ["c_time3", "time(3)", "'13:45:30.123'", "'23:59:59.999'"],
    ["c_datetime", "datetime", "'2024-03-15 13:45:30.123'", "'1753-01-01'"],
    ["c_datetime2", "datetime2(7)", "'2024-03-15 13:45:30.1234567'", "'0001-01-01'"],
    ["c_datetime2_3", "datetime2(3)", "'2024-03-15 13:45:30.120'", "'9999-12-31 23:59:59.999'"],
    [
        "c_datetimeoffset",
        "datetimeoffset",
        "'2024-03-15 13:45:30.1234567 +02:00'",
        "'2024-03-15 00:00:00 -05:30'",
    ],
    ["c_smalldatetime", "smalldatetime", "'2024-03-15 13:45'", "'1900-01-01'"],
    [
        "c_uniqueidentifier",
        "uniqueidentifier",
        "'6F9619FF-8B86-D011-B42D-00C04FC964FF'",
        "'00000000-0000-0000-0000-000000000000'",
    ],
    ["c_char", "char(8)", "'abc'", "''"],
    ["c_varchar", "varchar(50)", "'héllo'", "'it''s'"],
    ["c_nchar", "nchar(5)", "N'日本'", "N''"],
    [
        "c_nvarchar_max",
        "nvarchar(max)",
        "N'ünï ''x'' 日本語'",
        "N'line1' + CHAR(13) + CHAR(10) + N'line2'",
    ],
    ["c_binary", "binary(4)", "0x01020304", "0x00000000"],
    ["c_varbinary_max", "varbinary(max)", "0xDEADBEEF", "0x"],
    ["c_xml", "xml", "'<a x=\"1\"><b>t</b></a>'", "'<r/>'"],
    ["c_variant_int", "sql_variant", "CAST(42 AS int)", "CAST('txt' AS varchar(10))"],
    ["c_variant_date", "sql_variant", "CAST('2024-03-15' AS date)", "CAST(1.5 AS decimal(5,2))"],
    ["c_hierarchyid", "hierarchyid", "'/1/2/'", "'/'"],
];

const castList = (pick) => COLUMNS.map((c) => `CAST(${pick(c)} AS ${c[1]}) AS ${c[0]}`).join(", ");
const QUERIES = {
    typical: `SELECT ${castList((c) => c[2])};`,
    edge: `SELECT ${castList((c) => c[3])};`,
    nulls: `SELECT ${castList(() => "NULL")};`,
};

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
    conn.onNotification(name, (p) => {
        waiters[name]?.(p);
    });
}
conn.onNotification(() => {});
conn.listen();

(async () => {
    try {
        const uri = "untitled:probe";
        const options = {
            server: "localhost,11433",
            database: "yast",
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

        const result = { columns: [], queries: QUERIES, sets: {} };
        for (const [name, query] of Object.entries(QUERIES)) {
            const done = waitFor("query/complete");
            await conn.sendRequest("query/executeString", { ownerUri: uri, query });
            const complete = await done;
            const summary = complete.batchSummaries[0].resultSetSummaries[0];
            if (name === "typical") result.columns = summary.columnInfo;
            const subset = await conn.sendRequest("query/subset", {
                ownerUri: uri,
                batchIndex: 0,
                resultSetIndex: 0,
                rowsStartIndex: 0,
                rowsCount: summary.rowCount,
            });
            result.sets[name] = subset.resultSubset.rows[0].map((cell) => ({
                displayValue: cell.displayValue,
                isNull: cell.isNull,
            }));
        }
        fs.writeFileSync(
            path.join(outDir, "mssql-cell-formats.json"),
            JSON.stringify(result, null, 2),
        );
        console.log("captured", result.columns.length, "columns");
    } catch (e) {
        console.error("ERROR", e.message);
        process.exitCode = 1;
    } finally {
        proc.kill();
        process.exit();
    }
})();
