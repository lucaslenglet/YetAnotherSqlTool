// Dev tool: records what Microsoft's sqltoolsservice suggests (IntelliSense) at typical cursor
// positions. This is the reference for the SQL Server autocompletion items: what is offered where,
// kinds, labels, details, insert text, bracket quoting and order.
// Usage: start the databases with `npm run dev:db` in another terminal, then run
//   MSSQL_SA_PASSWORD='<DEV_PASSWORD of scripts/dev-db.mjs>' node tools/sts-completion-probe.js docs/reference
// It creates (or recreates) the database `yast_oe_completion` from SETUP below and reads the
// suggestions in it; test/languageFeatures/completion.integration.test.ts builds the same database
// from the `setup` field of the output.
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

// yast_oe_*: the Object Explorer integration test leaves such names out of the tree it compares.
const DATABASE = "yast_oe_completion";

/** Batches run in `DATABASE` once it exists. Names cover quoting needs, a second schema and every object kind. */
const SETUP = [
    `CREATE TABLE dbo.customers (id INT PRIMARY KEY, name NVARCHAR(100) NULL, email NVARCHAR(255) NOT NULL, created_at DATETIME2 NOT NULL)`,
    `CREATE TABLE dbo.orders (id INT PRIMARY KEY, customer_id INT NOT NULL, amount DECIMAL(10,2) NOT NULL, status NVARCHAR(20) NOT NULL)`,
    `CREATE SCHEMA sales`,
    `CREATE TABLE sales.[Order Lines] (line_id INT NOT NULL, [Unit Price] MONEY NULL, qty INT)`,
    `CREATE TABLE dbo.[select] (id INT)`,
    `CREATE VIEW dbo.customer_orders AS SELECT c.id, c.name, o.amount FROM dbo.customers c JOIN dbo.orders o ON o.customer_id = c.id`,
    `CREATE FUNCTION dbo.order_total(@customer_id INT) RETURNS DECIMAL(10,2) AS BEGIN RETURN 0 END`,
    `CREATE FUNCTION sales.top_lines(@n INT) RETURNS TABLE AS RETURN SELECT TOP (@n) * FROM sales.[Order Lines]`,
    `CREATE PROCEDURE dbo.archive_orders @before DATETIME2 AS SELECT 1`,
    `CREATE SYNONYM dbo.clients FOR dbo.customers`,
    `CREATE SEQUENCE dbo.order_numbers`,
    `CREATE TYPE dbo.phone FROM NVARCHAR(20)`,
];

/** name -> script; "|" marks the cursor. */
const CASES = {
    emptyScript: "|",
    partialKeyword: "SEL|",
    selectList: "SELECT | FROM dbo.customers",
    selectListPartial: "SELECT em| FROM dbo.customers",
    selectNoFrom: "SELECT |",
    selectTop: "SELECT TOP 10 | FROM dbo.customers",
    from: "SELECT * FROM |",
    fromPartial: "SELECT * FROM cust|",
    afterTable: "SELECT * FROM dbo.customers |",
    schemaDot: "SELECT * FROM dbo.|",
    schemaDotPartial: "SELECT * FROM dbo.ord|",
    otherSchemaDot: "SELECT * FROM sales.|",
    sysDot: "SELECT * FROM sys.|",
    informationSchemaDot: "SELECT * FROM INFORMATION_SCHEMA.|",
    databaseSchemaDot: `SELECT * FROM ${DATABASE}.dbo.|`,
    databaseDot: `SELECT * FROM ${DATABASE}.|`,
    aliasDot: "SELECT c.| FROM dbo.customers c",
    aliasDotPartial: "SELECT c.em| FROM dbo.customers c",
    tableDot: "SELECT customers.| FROM dbo.customers",
    schemaTableDot: "SELECT dbo.customers.| FROM dbo.customers",
    aliasDotOn: "SELECT * FROM dbo.customers c JOIN dbo.orders o ON o.|",
    join: "SELECT * FROM dbo.customers c JOIN |",
    where: "SELECT * FROM dbo.customers WHERE |",
    whereTwoTables:
        "SELECT * FROM dbo.customers c JOIN dbo.orders o ON o.customer_id = c.id WHERE |",
    orderBy: "SELECT * FROM dbo.customers ORDER BY |",
    groupBy: "SELECT status, COUNT(*) FROM dbo.orders GROUP BY |",
    exec: "EXEC |",
    execSchemaDot: "EXEC dbo.|",
    use: "USE |",
    insertInto: "INSERT INTO |",
    insertColumns: "INSERT INTO dbo.customers (|",
    updateSet: "UPDATE dbo.customers SET |",
    deleteFrom: "DELETE FROM |",
    inString: "SELECT 'abc|' FROM dbo.customers",
    inComment: "-- a comment |\nSELECT 1",
    inBlockComment: "/* a comment | */ SELECT 1",
    bracketPartial: "SELECT * FROM sales.[Ord|",
    bracketColumns: "SELECT l.| FROM sales.[Order Lines] l",
    reservedName: "SELECT * FROM dbo.[sel|",
    declareType: "DECLARE @x |",
    castType: "SELECT CAST(1 AS |",
    variables: "DECLARE @total INT; SELECT @|",
    functionCall: "SELECT dbo.order_total(|",
    secondStatement: "SELECT 1\nSELECT * FROM dbo.orders WHERE |",
    subquery: "SELECT * FROM dbo.customers WHERE id IN (SELECT | FROM dbo.orders)",
    commaJoin: "SELECT * FROM dbo.orders o, |",
    truncate: "TRUNCATE TABLE |",
    insertValues: "INSERT INTO dbo.customers (name) VALUES (|",
    selectBracket: "SELECT [|",
    cte: "WITH recent AS (SELECT id, amount FROM dbo.orders) SELECT r.| FROM recent r",
};

const proc = cp.spawn("dotnet", [STS], { stdio: ["pipe", "pipe", "ignore"] });
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(proc.stdout),
    new rpc.StreamMessageWriter(proc.stdin),
);
const waiters = {};
const waitFor = (name, key) =>
    new Promise((resolve, reject) => {
        waiters[name + key] = resolve;
        setTimeout(() => reject(new Error("timeout waiting for " + name + " " + key)), 120000);
    });
for (const name of ["connection/complete", "query/complete", "textDocument/intelliSenseReady"]) {
    conn.onNotification(name, (p) => waiters[name + p.ownerUri]?.(p));
}
conn.onNotification(() => {});
conn.onRequest(() => null);
conn.listen();

const options = (database) => ({
    server: "localhost,11433",
    database,
    user: "sa",
    password: process.env.MSSQL_SA_PASSWORD,
    authenticationType: "SqlLogin",
    trustServerCertificate: true,
    encrypt: "Mandatory",
    applicationName: "probe",
});

async function connect(uri, database) {
    const connected = waitFor("connection/complete", uri);
    await conn.sendRequest("connection/connect", {
        ownerUri: uri,
        connection: { options: options(database) },
    });
    const c = await connected;
    if (c.errorMessage) throw new Error(c.errorMessage);
}

async function run(uri, query) {
    const done = waitFor("query/complete", uri);
    await conn.sendRequest("query/executeString", { ownerUri: uri, query });
    const complete = await done;
    const errors = complete.batchSummaries.filter((b) => b.hasError);
    if (errors.length) throw new Error("query failed: " + query);
}

function cursor(script) {
    const offset = script.indexOf("|");
    const text = script.slice(0, offset) + script.slice(offset + 1);
    const before = text.slice(0, offset).split("\n");
    return { text, line: before.length - 1, character: before[before.length - 1].length };
}

/** LSP CompletionItemKind numbers (vscode.CompletionItemKind is the same minus one). */
const KINDS = ["", "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference"]; // prettier-ignore

/** Built-in functions and @@ variables: the same long list everywhere, kept as names only. */
const isBuiltIn = (item) =>
    item.kind === 12 && (item.label.startsWith("@@") || item.label === item.label.toUpperCase());

/** An item with the fields that differ from its label; undefined ones are dropped by JSON.stringify. */
const shape = (item, resolved) => ({
    label: item.label,
    kind: KINDS[item.kind],
    insertText: item.insertText !== item.label ? item.insertText : undefined,
    snippet: item.insertTextFormat === 2 || undefined,
    detail: item.detail !== item.label ? item.detail : undefined,
    filterText: item.filterText ?? undefined,
    sortText: item.sortText ?? undefined,
    documentation: resolved?.documentation ?? undefined,
});

/** Shared lists (keywords, built-ins) are stored once and referenced by name. */
const lists = {};
function listRef(prefix, labels) {
    if (labels.length === 0) return undefined;
    const key = JSON.stringify(labels);
    let name = Object.keys(lists).find((n) => JSON.stringify(lists[n]) === key);
    if (!name) {
        name = `${prefix}${Object.keys(lists).filter((n) => n.startsWith(prefix)).length + 1}`;
        lists[name] = labels;
    }
    return name;
}

(async () => {
    try {
        const init = await conn.sendRequest("initialize", {
            processId: process.pid,
            rootUri: null,
            capabilities: {},
        });
        conn.sendNotification("initialized", {});

        const setupUri = "untitled:setup";
        await connect(setupUri, "master");
        await run(
            setupUri,
            `IF DB_ID('${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE ${DATABASE} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DATABASE}; END; CREATE DATABASE ${DATABASE};`,
        );
        await connect(setupUri, DATABASE);
        for (const batch of SETUP) await run(setupUri, batch);

        const uri = "file:///tmp/yast-completion-probe.sql";
        conn.sendNotification("textDocument/didOpen", {
            textDocument: { uri, languageId: "sql", version: 1, text: "" },
        });
        const ready = waitFor("textDocument/intelliSenseReady", uri);
        await connect(uri, DATABASE);
        await ready;

        const result = {
            sqltoolsservice: path.basename(path.dirname(path.dirname(STS))),
            database: DATABASE,
            setup: SETUP,
            completionProvider: init.capabilities?.completionProvider,
            textDocumentSync: init.capabilities?.textDocumentSync,
            cases: {},
        };
        let version = 1;
        let previous = "";
        for (const [name, script] of Object.entries(CASES)) {
            const { text, line, character } = cursor(script);
            // sqltoolsservice syncs incrementally: replace the whole previous text by range.
            const lines = previous.split("\n");
            const end = { line: lines.length - 1, character: lines[lines.length - 1].length };
            conn.sendNotification("textDocument/didChange", {
                textDocument: { uri, version: ++version },
                contentChanges: [{ range: { start: { line: 0, character: 0 }, end }, text }],
            });
            previous = text;
            const items = await conn.sendRequest("textDocument/completion", {
                textDocument: { uri },
                position: { line, character },
            });
            const list = Array.isArray(items) ? items : (items?.items ?? []);
            const keywords = list.filter((i) => i.kind === 14);
            const builtIns = list.filter(isBuiltIn);
            const objects = list.filter((i) => i.kind !== 14 && !isBuiltIn(i));
            // Resolving adds the documentation ("column id(int, not null)"); the first ones suffice.
            const shaped = [];
            for (const [index, item] of objects.entries()) {
                const resolved =
                    index < 40 ? await conn.sendRequest("completionItem/resolve", item) : undefined;
                shaped.push(shape(item, resolved));
            }
            const range = list[0]?.textEdit?.range;
            result.cases[name] = {
                script,
                isIncomplete: Array.isArray(items) ? undefined : items?.isIncomplete,
                count: list.length,
                replacedRange: range && [range.start.character, range.end.character],
                keywords: listRef(
                    "keywords",
                    keywords.map((i) => i.label),
                ),
                keywordSample: keywords[0] && shape(keywords[0]),
                builtIns: listRef(
                    "builtIns",
                    builtIns.map((i) => i.label),
                ),
                builtInSample: builtIns[0] && shape(builtIns[0]),
                items: shaped,
            };
            console.log(name.padEnd(24), list.length, "items");
        }
        result.lists = lists;
        // One item per line keeps the file readable and diffable.
        const text = JSON.stringify(result, null, 2).replace(
            /\{\n\s+"label": [^]*?\n\s+\}/g,
            (item) => JSON.stringify(JSON.parse(item)),
        );
        fs.writeFileSync(path.join(outDir, "mssql-completions.json"), text + "\n");
    } catch (e) {
        console.error("ERROR", e.message);
        process.exitCode = 1;
    } finally {
        proc.kill();
        process.exit();
    }
})();
