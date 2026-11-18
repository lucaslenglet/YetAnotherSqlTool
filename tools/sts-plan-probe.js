// Dev tool: the oracle for the SQL Server execution plan converter (src/drivers/mssql/executionPlan).
// It runs queries through Microsoft's sqltoolsservice with an estimated or actual plan asked for,
// as vscode-mssql does, takes the showplan XML of each plan result set (the grid cell text, which
// is what vscode-mssql hands back), sends it to `queryExecutionPlan/getExecutionPlan` and records
// input XML and output graphs in docs/reference/mssql-execution-plans.json. It also records the
// output for Microsoft's own fixtures (sqltoolsservice's test/.../ShowPlan/*.xml).
// test/drivers/mssql/executionPlanReference.test.ts replays every XML through the converter.
//
// Usage: start a SQL Server of your own on a random port, e.g.
//   docker run -d --name plan-probe -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='<password>' \
//       -p 127.0.0.1::1433 mcr.microsoft.com/mssql/server:2022-latest
//   docker port plan-probe     # 1433/tcp -> 127.0.0.1:<port>
// then run
//   MSSQL_SERVER='127.0.0.1,<port>' MSSQL_SA_PASSWORD='<password>' \
//       node tools/sts-plan-probe.js docs/reference <sqltoolsservice>/test/Microsoft.SqlTools.ServiceLayer.UnitTests/ShowPlan
// and remove the container. The probe works in a database of its own, dropped at the end.
// To capture more, add cases to CASES. The output is stable only per run: plans carry times and
// compile statistics, so a new capture changes many values; review it with the converter tests.
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const rpc = require(path.join(__dirname, "../node_modules/vscode-jsonrpc/lib/node/main.js"));

const STS_VERSION = "6.0.20260918.1";
const STS = path.join(
    process.env.HOME,
    `.vscode/extensions/ms-mssql.mssql-1.46.0/sqltoolsservice/${STS_VERSION}/Portable/MicrosoftSqlToolsServiceLayer.dll`,
);
const [outDir, fixturesDir] = process.argv.slice(2);
if (!outDir || !process.env.MSSQL_SERVER || !process.env.MSSQL_SA_PASSWORD) {
    console.error("see the usage at the top of tools/sts-plan-probe.js");
    process.exit(1);
}
const SHOWPLAN_COLUMN = "Microsoft SQL Server 2005 XML Showplan";
const DATABASE = "yast_plan_probe";
const FIXTURE_TABLES = path.join(__dirname, "../test/fixtures/mssql/01-schema.sql");

// Objects the cases need besides the tables of test/fixtures/mssql: enough rows for hash joins,
// parallelism, spills and missing indexes, a heap, a partitioned table, a columnstore table, a
// procedure, a function and a scratch table for the data changes.
const SETUP = [
    `CREATE TABLE dbo.categories (id INT PRIMARY KEY, label NVARCHAR(50) NOT NULL);
INSERT INTO dbo.categories (id, label)
SELECT TOP (100) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)), CONCAT(N'category ', ROW_NUMBER() OVER (ORDER BY (SELECT NULL)))
FROM sys.all_objects;`,
    `CREATE TABLE dbo.items (
    id INT IDENTITY(1,1) PRIMARY KEY,
    category_id INT NOT NULL,
    code VARCHAR(20) NOT NULL,
    name NVARCHAR(100) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    filler CHAR(200) NOT NULL DEFAULT ''
);
INSERT INTO dbo.items (category_id, code, name, price)
SELECT TOP (200000) n % 100 + 1, CONCAT('C', n), CONCAT(N'item ', n), (n % 997) / 10.0
FROM (SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b) AS numbers;
CREATE INDEX ix_items_category ON dbo.items (category_id);
CREATE INDEX ix_items_code ON dbo.items (code);`,
    `CREATE TABLE dbo.heap_items (id INT NOT NULL, label NVARCHAR(50) NOT NULL, amount INT NOT NULL);
INSERT INTO dbo.heap_items (id, label, amount) SELECT id, name, id % 50 FROM dbo.items WHERE id <= 50000;
CREATE INDEX ix_heap_items_id ON dbo.heap_items (id);`,
    `CREATE PARTITION FUNCTION pf_probe (INT) AS RANGE LEFT FOR VALUES (50000, 100000, 150000);
CREATE PARTITION SCHEME ps_probe AS PARTITION pf_probe ALL TO ([PRIMARY]);
CREATE TABLE dbo.partitioned_items (id INT NOT NULL PRIMARY KEY, price DECIMAL(10,2) NOT NULL) ON ps_probe (id);
INSERT INTO dbo.partitioned_items (id, price) SELECT id, price FROM dbo.items;`,
    `CREATE TABLE dbo.cs_items (id INT NOT NULL, category_id INT NOT NULL, price DECIMAL(10,2) NOT NULL);
INSERT INTO dbo.cs_items (id, category_id, price) SELECT id, category_id, price FROM dbo.items;
CREATE CLUSTERED COLUMNSTORE INDEX cci_cs_items ON dbo.cs_items;`,
    `CREATE TABLE dbo.scratch (id INT IDENTITY(1,1) PRIMARY KEY, customer_id INT NOT NULL REFERENCES dbo.customers(id), note NVARCHAR(50) NULL);
INSERT INTO dbo.scratch (customer_id, note) VALUES (1, N'a'), (2, N'b'), (3, N'c');`,
    `CREATE PROCEDURE dbo.items_of_category @category INT AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, name FROM dbo.items WHERE category_id = @category;
    SELECT COUNT(*) FROM dbo.categories WHERE id = @category;
END`,
    `CREATE FUNCTION dbo.category_label (@id INT) RETURNS NVARCHAR(50) WITH INLINE = OFF AS
BEGIN
    RETURN (SELECT label FROM dbo.categories WHERE id = @id);
END`,
    `CREATE FUNCTION dbo.items_above (@price DECIMAL(10,2)) RETURNS TABLE AS
RETURN SELECT id, price FROM dbo.items WHERE price > @price;`,
    `UPDATE STATISTICS dbo.items WITH FULLSCAN;`,
    `ALTER DATABASE [${DATABASE}] ADD FILEGROUP probe_mo CONTAINS MEMORY_OPTIMIZED_DATA;`,
    `ALTER DATABASE [${DATABASE}] ADD FILE (NAME = 'probe_mo', FILENAME = '/var/opt/mssql/data/${DATABASE}_mo') TO FILEGROUP probe_mo;`,
    `CREATE TABLE dbo.mo_items (id INT NOT NULL PRIMARY KEY NONCLUSTERED, category_id INT NOT NULL, price DECIMAL(10,2) NOT NULL)
WITH (MEMORY_OPTIMIZED = ON, DURABILITY = SCHEMA_ONLY);
INSERT INTO dbo.mo_items (id, category_id, price) SELECT id, category_id, price FROM dbo.items WHERE id <= 20000;`,
    `CREATE TABLE dbo.no_stats (id INT NOT NULL, v INT NOT NULL);
INSERT INTO dbo.no_stats (id, v) SELECT id, id % 10 FROM dbo.items WHERE id <= 5000;`,
];

/** [name, kinds, query]. Queries use CRLF line breaks, as an editor on Windows would send. */
const CASES = [
    ["select-trivial", "both", "SELECT 1 AS one;"],
    ["select-entities", "estimated", "SELECT N'é <tag> & \"quoted\"' AS text, 'it''s' AS other;"],
    ["clustered-index-scan", "both", "SELECT * FROM dbo.customers;"],
    ["clustered-index-seek", "both", "SELECT name FROM dbo.customers WHERE id = 2;"],
    [
        "index-seek-key-lookup",
        "both",
        "SELECT id, name, price FROM dbo.items WITH (INDEX(ix_items_category)) WHERE category_id = 7;",
    ],
    ["rid-lookup-heap", "both", "SELECT id, label FROM dbo.heap_items WHERE id BETWEEN 10 AND 20;"],
    ["table-scan-heap", "estimated", "SELECT SUM(amount) FROM dbo.heap_items;"],
    [
        "nested-loops-join",
        "both",
        "SELECT c.name, o.amount FROM dbo.customers c INNER LOOP JOIN dbo.orders o ON o.customer_id = c.id;",
    ],
    [
        "hash-join",
        "both",
        "SELECT c.label, i.name FROM dbo.categories c INNER HASH JOIN dbo.items i ON i.category_id = c.id WHERE i.price > 90;",
    ],
    [
        "merge-join",
        "both",
        "SELECT c.name, o.amount FROM dbo.customers c INNER MERGE JOIN dbo.orders o ON o.customer_id = c.id;",
    ],
    [
        "left-outer-join",
        "estimated",
        "SELECT c.name, o.status FROM dbo.customers c LEFT JOIN dbo.orders o ON o.customer_id = c.id;",
    ],
    [
        "sort",
        "both",
        "SELECT name, price FROM dbo.items WHERE category_id = 3 ORDER BY price DESC, name;",
    ],
    [
        "stream-aggregate",
        "both",
        "SELECT category_id, COUNT(*) AS n FROM dbo.items GROUP BY category_id OPTION (ORDER GROUP);",
    ],
    [
        "hash-aggregate",
        "both",
        "SELECT category_id, MAX(price) AS top_price FROM dbo.items GROUP BY category_id OPTION (HASH GROUP, MAXDOP 1);",
    ],
    ["top-n-sort", "both", "SELECT TOP (10) id, price FROM dbo.items ORDER BY price DESC;"],
    [
        "top-with-ties-percent",
        "estimated",
        "SELECT TOP (1) PERCENT WITH TIES id, price FROM dbo.items ORDER BY price;",
    ],
    [
        "subquery-exists",
        "both",
        "SELECT c.name FROM dbo.customers c WHERE EXISTS (SELECT 1 FROM dbo.orders o WHERE o.customer_id = c.id AND o.status = N'paid');",
    ],
    [
        "subquery-scalar",
        "estimated",
        "SELECT c.name, (SELECT SUM(o.amount) FROM dbo.orders o WHERE o.customer_id = c.id) AS total FROM dbo.customers c;",
    ],
    [
        "subquery-not-in",
        "estimated",
        "SELECT name FROM dbo.customers WHERE id NOT IN (SELECT customer_id FROM dbo.orders WHERE status = N'cancelled');",
    ],
    [
        "cte-recursive",
        "both",
        "WITH numbers AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM numbers WHERE n < 20)\r\nSELECT n FROM numbers OPTION (MAXRECURSION 50);",
    ],
    [
        "cte-simple",
        "estimated",
        "WITH paid AS (SELECT customer_id, amount FROM dbo.orders WHERE status = N'paid')\r\nSELECT c.name, p.amount FROM paid p JOIN dbo.customers c ON c.id = p.customer_id;",
    ],
    [
        "union",
        "both",
        "SELECT name FROM dbo.customers UNION SELECT label FROM dbo.categories WHERE id < 5;",
    ],
    [
        "union-all",
        "estimated",
        "SELECT id FROM dbo.customers UNION ALL SELECT id FROM dbo.orders UNION ALL SELECT 42;",
    ],
    [
        "window-functions",
        "both",
        "SELECT id, category_id, ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY price) AS rn,\r\n    SUM(price) OVER (PARTITION BY category_id ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS running\r\nFROM dbo.items WHERE category_id <= 2;",
    ],
    [
        "window-aggregate-batch",
        "both",
        "SELECT category_id, price, AVG(price) OVER (PARTITION BY category_id) AS average FROM dbo.cs_items WHERE id < 1000;",
    ],
    [
        "parallelism",
        "both",
        "SELECT i.category_id, COUNT(*) AS n, SUM(i.price) AS total FROM dbo.items i JOIN dbo.categories c ON c.id = i.category_id\r\nGROUP BY i.category_id OPTION (USE HINT('ENABLE_PARALLEL_PLAN_PREFERENCE'));",
    ],
    [
        "parallel-hash-join-bitmap",
        "estimated",
        "SELECT i.name, h.label FROM dbo.items i JOIN dbo.heap_items h ON h.id = i.id WHERE i.price > 50\r\nOPTION (HASH JOIN, USE HINT('ENABLE_PARALLEL_PLAN_PREFERENCE'));",
    ],
    ["missing-index", "both", "SELECT id, name FROM dbo.items WHERE price = 42.5;"],
    [
        "missing-index-include",
        "estimated",
        "SELECT name, code FROM dbo.items WHERE price BETWEEN 10 AND 11 AND category_id > 50 AND filler = '';",
    ],
    ["implicit-conversion", "both", "SELECT id FROM dbo.items WHERE code = N'C42';"],
    ["implicit-conversion-int", "estimated", "SELECT id FROM dbo.items WHERE code = 42;"],
    ["no-join-predicate", "both", "SELECT c.name, o.amount FROM dbo.customers c, dbo.orders o;"],
    [
        "sort-spill",
        "actual",
        "SELECT id, name, filler FROM dbo.items ORDER BY name OPTION (MAX_GRANT_PERCENT = 0, MAXDOP 1);",
    ],
    [
        "hash-spill",
        "actual",
        "SELECT i.name, j.name FROM dbo.items i INNER HASH JOIN dbo.items j ON j.code = i.code OPTION (MAX_GRANT_PERCENT = 0, MAXDOP 1);",
    ],
    [
        "excessive-grant",
        "actual",
        "SELECT TOP (5) id, name FROM dbo.items WHERE category_id = 3 ORDER BY name OPTION (MIN_GRANT_PERCENT = 20, MAXDOP 1);",
    ],
    ["insert", "both", "INSERT INTO dbo.scratch (customer_id, note) VALUES (1, N'inserted');"],
    [
        "insert-select",
        "estimated",
        "INSERT INTO dbo.scratch (customer_id, note) SELECT customer_id, status FROM dbo.orders;",
    ],
    ["update", "both", "UPDATE dbo.scratch SET note = N'updated' WHERE customer_id = 2;"],
    ["delete", "both", "DELETE FROM dbo.scratch WHERE note = N'inserted';"],
    [
        "merge",
        "both",
        "MERGE dbo.scratch AS t USING (SELECT id, name FROM dbo.customers) AS s ON t.customer_id = s.id AND t.note = s.name\r\nWHEN MATCHED THEN UPDATE SET note = s.name\r\nWHEN NOT MATCHED THEN INSERT (customer_id, note) VALUES (s.id, s.name);",
    ],
    [
        "columnstore-aggregate",
        "both",
        "SELECT category_id, SUM(price) AS total, COUNT(*) AS n FROM dbo.cs_items GROUP BY category_id;",
    ],
    [
        "adaptive-join",
        "estimated",
        "SELECT c.label, SUM(s.price) FROM dbo.cs_items s JOIN dbo.categories c ON c.id = s.category_id WHERE s.price > 99 GROUP BY c.label;",
    ],
    [
        "partitioned",
        "both",
        "SELECT COUNT(*) FROM dbo.partitioned_items WHERE id BETWEEN 40000 AND 120000;",
    ],
    [
        "several-statements",
        "both",
        "SELECT COUNT(*) FROM dbo.customers;\r\nSELECT TOP (2) * FROM dbo.orders ORDER BY amount DESC;\r\nUPDATE dbo.scratch SET note = note WHERE id = 1;",
    ],
    ["procedure-call", "both", "EXEC dbo.items_of_category @category = 4;"],
    [
        "scalar-udf",
        "both",
        "SELECT TOP (3) id, dbo.category_label(category_id) AS label FROM dbo.items ORDER BY id;",
    ],
    [
        "table-valued-function",
        "estimated",
        "SELECT TOP (5) * FROM dbo.items_above(99) ORDER BY id;",
    ],
    [
        "if-else",
        "both",
        "IF EXISTS (SELECT 1 FROM dbo.orders WHERE status = N'paid')\r\n    SELECT COUNT(*) FROM dbo.orders WHERE status = N'paid';\r\nELSE\r\n    SELECT 0;",
    ],
    [
        "while",
        "both",
        "DECLARE @i INT = 0;\r\nWHILE @i < 2\r\nBEGIN\r\n    SET @i += 1;\r\n    SELECT @i AS i, COUNT(*) FROM dbo.customers WHERE id > @i;\r\nEND",
    ],
    [
        "variables-recompile",
        "both",
        "DECLARE @category INT = 5;\r\nSELECT COUNT(*) FROM dbo.items WHERE category_id = @category OPTION (RECOMPILE);",
    ],
    [
        "parameterized",
        "both",
        "EXEC sp_executesql N'SELECT name FROM dbo.items WHERE id = @id', N'@id INT', @id = 12;",
    ],
    [
        "cursor",
        "estimated",
        "DECLARE c CURSOR FOR SELECT id, name FROM dbo.customers WHERE id > 1;\r\nOPEN c;\r\nFETCH NEXT FROM c;\r\nCLOSE c;\r\nDEALLOCATE c;",
    ],
    [
        "cursor-fast-forward",
        "estimated",
        "DECLARE f CURSOR FAST_FORWARD FOR SELECT id FROM dbo.orders;\r\nOPEN f;\r\nCLOSE f;\r\nDEALLOCATE f;",
    ],
    [
        "values-constant-scan",
        "both",
        "SELECT v.a, v.b FROM (VALUES (1, N'x'), (2, N'y'), (3, NULL)) AS v(a, b) WHERE v.a > 1;",
    ],
    [
        "compute-scalar-convert",
        "estimated",
        "SELECT id, CAST(price AS INT) * 2 AS doubled, UPPER(name) AS upper_name FROM dbo.items WHERE id < 10;",
    ],
    [
        "filter-startup",
        "estimated",
        "DECLARE @flag BIT = 1;\r\nSELECT id FROM dbo.customers WHERE @flag = 1 AND id > 0;",
    ],
    ["distinct", "estimated", "SELECT DISTINCT status FROM dbo.orders;"],
    [
        "intersect-except",
        "estimated",
        "SELECT customer_id FROM dbo.orders INTERSECT SELECT id FROM dbo.customers EXCEPT SELECT 3;",
    ],
    [
        "foreign-key-check",
        "estimated",
        "INSERT INTO dbo.orders (customer_id, amount) VALUES (2, 10);",
    ],
    ["ddl", "estimated", "CREATE TABLE #probe_temp (id INT);"],
    ["use-database", "estimated", `USE ${DATABASE};\r\nSELECT 1;`],
    ["statistics-off", "both", "SELECT id FROM dbo.no_stats WHERE v = 5 AND id > 10;"],
    [
        "memory-optimized-missing-index",
        "both",
        "SELECT m.id, c.label FROM dbo.mo_items m WITH (SNAPSHOT) JOIN dbo.categories c ON c.id = m.category_id WHERE m.price = 4.5 AND m.category_id > 3;",
    ],
    [
        "memory-optimized-aggregate",
        "estimated",
        "SELECT m.category_id, COUNT(*) AS n FROM dbo.mo_items m WITH (SNAPSHOT) WHERE m.price = 4.5 GROUP BY m.category_id ORDER BY n DESC;",
    ],
    [
        "cursor-actual",
        "actual",
        "DECLARE k CURSOR FOR SELECT id, name FROM dbo.customers;\r\nOPEN k;\r\nFETCH NEXT FROM k;\r\nCLOSE k;\r\nDEALLOCATE k;",
    ],
    [
        "rollup",
        "both",
        "SELECT category_id, COUNT(*) AS n FROM dbo.items WHERE category_id < 4 GROUP BY ROLLUP (category_id);",
    ],
    [
        "grouping-sets",
        "estimated",
        "SELECT category_id, price, COUNT(*) AS n FROM dbo.cs_items WHERE id < 100 GROUP BY GROUPING SETS ((category_id), (price), ());",
    ],
    [
        "columnstore-insert",
        "actual",
        "INSERT INTO dbo.cs_items (id, category_id, price) VALUES (999999, 1, 1);",
    ],
    ["halloween-spool", "both", "UPDATE dbo.heap_items SET id = id + 100000 WHERE id < 5;"],
    [
        "merge-interval",
        "estimated",
        "DECLARE @a INT = 1, @b INT = 5, @c INT = 3, @d INT = 9;\r\nSELECT id FROM dbo.items WHERE id BETWEEN @a AND @b OR id BETWEEN @c AND @d;",
    ],
    ["split-collapse", "both", "UPDATE dbo.customers SET email = email WHERE id < 3;"],
    [
        "string-split-tvf",
        "estimated",
        "SELECT value FROM STRING_SPLIT('a,b,c', ',') WHERE value <> 'b';",
    ],
    [
        "offset-fetch",
        "estimated",
        "SELECT id, name FROM dbo.items ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY;",
    ],
    ["error-in-batch", "estimated", "SELECT * FROM dbo.no_such_table;"],
];

const proc = cp.spawn("dotnet", [STS], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
});
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(proc.stdout),
    new rpc.StreamMessageWriter(proc.stdin),
);
const waiters = {};
const waitFor = (name) =>
    new Promise((resolve, reject) => {
        waiters[name] = resolve;
        setTimeout(() => reject(new Error("timeout waiting for " + name)), 300000);
    });
for (const name of ["connection/complete", "query/complete"]) {
    conn.onNotification(name, (p) => waiters[name]?.(p));
}
const messages = [];
conn.onNotification("query/message", (p) => messages.push(p.message));
conn.onNotification(() => {});
conn.listen();

async function connect(uri, database) {
    const options = {
        server: process.env.MSSQL_SERVER,
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

/** Runs `query`; returns the completion and the messages. Throws on an error unless allowed. */
async function run(uri, query, executionPlanOptions, allowErrors = false) {
    messages.length = 0;
    const done = waitFor("query/complete");
    await conn.sendRequest("query/executeString", { ownerUri: uri, query, executionPlanOptions });
    const complete = await done;
    const errors = messages.filter((m) => m.isError);
    if (errors.length && !allowErrors)
        throw new Error(`${query}\n${errors.map((m) => m.message).join("\n")}`);
    return complete;
}

/** The text of every plan result set of the last query, in order. */
async function planXmls(uri, complete) {
    const xmls = [];
    for (const batch of complete.batchSummaries) {
        for (const resultSet of batch.resultSetSummaries ?? []) {
            if (resultSet.columnInfo?.[0]?.columnName !== SHOWPLAN_COLUMN) continue;
            const subset = await conn.sendRequest("query/subset", {
                ownerUri: uri,
                batchIndex: batch.id,
                resultSetIndex: resultSet.id,
                rowsStartIndex: 0,
                rowsCount: 1,
            });
            xmls.push(subset.resultSubset.rows[0][0].displayValue);
        }
    }
    return xmls;
}

/** sqltoolsservice's graphs for `xml`, as recorded: graphFileContent is "$xml" when it is the input. */
async function graphsOf(xml) {
    const result = await conn.sendRequest("queryExecutionPlan/getExecutionPlan", {
        graphInfo: { graphFileContent: xml, graphFileType: "sqlplan" },
    });
    if (result.errorMessage) return { error: result.errorMessage };
    for (const graph of result.graphs) {
        if (graph.graphFile.graphFileContent === xml) graph.graphFile.graphFileContent = "$xml";
        stripTopOperations(graph.root);
    }
    return { graphs: result.graphs };
}

/** topOperationsData: not used by the page, so not produced by YAST (see the note in the output). */
function stripTopOperations(node) {
    delete node.topOperationsData;
    node.children.forEach(stripTopOperations);
}

const NOTE =
    "Captured by tools/sts-plan-probe.js: sqltoolsservice's queryExecutionPlan/getExecutionPlan output for " +
    'each showplan XML. graphFileContent is "$xml" when it is the input XML. topOperationsData is removed ' +
    "from every node: the page does not use it and YAST does not produce it. " +
    "The XML of a case is the text of the plan cell as sqltoolsservice shows it, what vscode-mssql converts." +
    " sqltoolsservice ran on Linux: missing-index scripts use LF line breaks (CRLF on Windows) and times put a narrow no-break space before AM/PM (ICU).";

(async () => {
    try {
        const masterUri = "untitled:plan-probe-master";
        const serverInfo = await connect(masterUri, "master");
        await run(
            masterUri,
            `IF DB_ID('${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DATABASE}]; END`,
        );
        // The tables of test/fixtures/mssql, in the probe's database.
        const fixture = fs.readFileSync(FIXTURE_TABLES, "utf8").replace(/\byast\b/g, DATABASE);
        await run(masterUri, fixture);

        const uri = "untitled:plan-probe";
        await connect(uri, DATABASE);
        for (const statement of SETUP) await run(uri, statement);

        const cases = [];
        for (const [name, kinds, query] of CASES) {
            for (const kind of kinds === "both" ? ["estimated", "actual"] : [kinds]) {
                const options =
                    kind === "estimated"
                        ? { includeEstimatedExecutionPlanXml: true }
                        : { includeActualExecutionPlanXml: true };
                if (name === "statistics-off")
                    await run(uri, `ALTER DATABASE [${DATABASE}] SET AUTO_CREATE_STATISTICS OFF;`);
                const complete = await run(uri, query, options, true);
                const errors = messages.filter((m) => m.isError).map((m) => m.message);
                const xmls = await planXmls(uri, complete);
                if (name === "statistics-off")
                    await run(uri, `ALTER DATABASE [${DATABASE}] SET AUTO_CREATE_STATISTICS ON;`);
                const plans = [];
                for (const xml of xmls) plans.push({ xml, ...(await graphsOf(xml)) });
                cases.push({
                    name: `${name} (${kind})`,
                    kind,
                    query,
                    ...(errors.length ? { errors } : {}),
                    plans,
                });
                console.log(
                    `${name} (${kind}): ${plans.length} plan(s)${errors.length ? ` ${errors.join(" / ")}` : ""}`,
                );
            }
        }

        // Microsoft's fixtures.
        for (const file of fixturesDir
            ? ["TestShowPlan.xml", "TestShowPlanRecommendations.xml"]
            : []) {
            const xml = fs.readFileSync(path.join(fixturesDir, file), "utf8");
            cases.push({
                name: `sqltoolsservice fixture ${file}`,
                kind: "file",
                plans: [{ xml, ...(await graphsOf(xml)) }],
            });
            console.log(`fixture ${file}`);
        }

        await connect(masterUri, "master");
        await run(
            masterUri,
            `ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DATABASE}];`,
        );

        // One case per line: a new capture shows as a diff per case.
        const header = {
            note: NOTE,
            sqltoolsservice: STS_VERSION,
            server: serverInfo.serverVersion,
            culture: "en-US",
        };
        const text =
            JSON.stringify(header, null, 2).replace(/\n}$/, ',\n  "cases": [\n') +
            cases.map((c) => "    " + JSON.stringify(c)).join(",\n") +
            "\n  ]\n}\n";
        fs.writeFileSync(path.join(outDir, "mssql-execution-plans.json"), text);
        console.log(`captured ${cases.length} cases`);
    } catch (e) {
        console.error("ERROR", e.message);
        process.exitCode = 1;
    } finally {
        proc.kill();
        process.exit();
    }
})();
