import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mssqlDriver } from "../../src/drivers/mssql";
import { pgDriver } from "../../src/drivers/pg";
import type { Driver, DriverConnection, ExecuteEvent } from "../../src/drivers/types";
import {
    computeCompletions,
    type CompletionResult,
} from "../../src/languageFeatures/completion/completionItems";
import { CompletionMetadata } from "../../src/languageFeatures/completion/completionMetadata";
import { mssqlOptions, pgOptions } from "../support/databases";

// Autocompletion against the real catalogs. Each engine gets its own database (yast_oe_*: the Object
// Explorer test leaves such names out of the tree it compares), built for SQL Server from the setup
// of docs/reference/mssql-completions.json, the capture of sqltoolsservice's suggestions.

interface ReferenceItem {
    label: string;
    kind: string;
    insertText?: string;
}
interface ReferenceCase {
    script: string;
    items: ReferenceItem[];
}
const reference: { database: string; setup: string[]; cases: Record<string, ReferenceCase> } =
    JSON.parse(
        readFileSync(
            new URL("../../docs/reference/mssql-completions.json", import.meta.url),
            "utf8",
        ),
    );
const DATABASE = reference.database;

async function run(connection: DriverConnection, text: string): Promise<ExecuteEvent[]> {
    const events: ExecuteEvent[] = [];
    await connection.execute(
        { text, startLine: 0 },
        (e) => events.push(e),
        new AbortController().signal,
    );
    const error = events.find((e) => e.type === "message" && e.isError);
    if (error && error.type === "message") throw new Error(`${error.text}\n${text}`);
    return events;
}

const signal = () => new AbortController().signal;

/** Suggestions for a script whose cursor is marked with "|". */
async function suggest(
    driver: Driver,
    metadata: CompletionMetadata,
    marked: string,
): Promise<CompletionResult> {
    const offset = marked.indexOf("|");
    return computeCompletions(
        marked.slice(0, offset) + marked.slice(offset + 1),
        offset,
        driver,
        metadata,
        {
            lowerCaseSuggestions: false,
            budgetMs: 10000,
            maxItems: 100000,
        },
    );
}

const labels = (result: CompletionResult) => result.items.map((i) => i.label);
const item = (result: CompletionResult, label: string) =>
    result.items.find((i) => i.label === label);

/** Resolves when `promise` does within `ms`, else rejects: proves something did not wait for the session. */
function quickly<T>(promise: Promise<T>, ms = 2500): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms),
        ),
    ]);
}

describe("SQL Server completion", () => {
    const login = `yast_oe_completion_${randomBytes(3).toString("hex")}`;
    const loginPassword = `Yast-${randomBytes(12).toString("hex")}-Aa1`;
    let admin: DriverConnection;
    let connection: DriverConnection;
    let metadata: CompletionMetadata;

    beforeAll(async () => {
        admin = await mssqlDriver.connect({ options: mssqlOptions({ database: "master" }) });
        await run(
            admin,
            `IF DB_ID('${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE ${DATABASE} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DATABASE}; END; CREATE DATABASE ${DATABASE};`,
        );
        await admin.changeDatabase(DATABASE);
        for (const batch of reference.setup) await run(admin, batch);
        await run(
            admin,
            `CREATE LOGIN ${login} WITH PASSWORD = '${loginPassword}', CHECK_POLICY = OFF`,
        );
        await run(
            admin,
            `CREATE USER ${login} FOR LOGIN ${login} WITH DEFAULT_SCHEMA = sales; GRANT SELECT, EXECUTE, VIEW DEFINITION TO ${login};`,
        );
        connection = await mssqlDriver.connect({ options: mssqlOptions({ database: DATABASE }) });
        metadata = new CompletionMetadata(connection, DATABASE);
    }, 60000);

    afterAll(async () => {
        metadata?.dispose();
        await connection?.close();
        if (admin) {
            await admin.changeDatabase("master");
            await run(
                admin,
                `ALTER DATABASE ${DATABASE} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DATABASE}; DROP LOGIN ${login};`,
            ).catch(() => undefined);
            await admin.close();
        }
    });

    it("lists the objects of the database", async () => {
        const started = Date.now();
        const objects = await connection.listCompletionObjects(DATABASE, signal());
        console.log(
            `SQL Server: ${objects.length} completion objects in ${Date.now() - started} ms`,
        );
        const find = (schema: string | undefined, name: string) =>
            objects.find((o) => o.schema === schema && o.name === name);
        expect(find("dbo", "customers")).toMatchObject({ kind: "table" });
        expect(find("sales", "Order Lines")).toMatchObject({ kind: "table" });
        expect(find("dbo", "customer_orders")).toMatchObject({ kind: "view" });
        expect(find("dbo", "clients")).toMatchObject({ kind: "synonym" });
        expect(find("dbo", "order_numbers")).toMatchObject({ kind: "sequence" });
        expect(find("dbo", "phone")).toMatchObject({ kind: "type" });
        expect(find("dbo", "order_total")).toMatchObject({
            kind: "function",
            detail: "(@customer_id int) RETURNS decimal(10,2)",
        });
        expect(find("sales", "top_lines")).toMatchObject({
            kind: "function",
            returnsTable: true,
            detail: "(@n int) RETURNS TABLE",
        });
        expect(find("dbo", "archive_orders")).toMatchObject({
            kind: "procedure",
            detail: "@before datetime2(7)",
        });
        expect(find(undefined, "sales")).toMatchObject({ kind: "schema" });
        expect(find(undefined, DATABASE)).toMatchObject({ kind: "database" });
        expect(find("sys", "objects")).toMatchObject({ kind: "view", system: true });
        expect(find("INFORMATION_SCHEMA", "TABLES")).toMatchObject({ kind: "view", system: true });
        expect(find("sys", "sp_help")).toMatchObject({ kind: "procedure", system: true });
        // Objects of the fixture database (yast) are not this database's.
        expect(objects.some((o) => o.schema === "dbo" && o.name === "yast_oi_parent")).toBe(false);
    });

    it("lists columns of tables, views, synonyms and table functions, in order", async () => {
        const started = Date.now();
        const [customers, lines, view, synonym, tvf, unknown, system] =
            await connection.listCompletionColumns(
                DATABASE,
                [
                    { schema: "dbo", name: "customers" },
                    { schema: "sales", name: "Order Lines" },
                    { schema: "dbo", name: "customer_orders" },
                    { schema: "dbo", name: "clients" },
                    { schema: "sales", name: "top_lines" },
                    { schema: "dbo", name: "nope" },
                    { schema: "sys", name: "schemas" },
                ],
                signal(),
            );
        console.log(`SQL Server: columns of 7 relations in ${Date.now() - started} ms`);
        expect(customers).toEqual([
            { name: "id", dataType: "int", nullable: false },
            { name: "name", dataType: "nvarchar(100)", nullable: true },
            { name: "email", dataType: "nvarchar(255)", nullable: false },
            { name: "created_at", dataType: "datetime2(7)", nullable: false },
        ]);
        expect(lines.map((c) => c.name)).toEqual(["line_id", "Unit Price", "qty"]);
        expect(view.map((c) => c.name)).toEqual(["id", "name", "amount"]);
        expect(synonym.map((c) => c.name)).toEqual(["id", "name", "email", "created_at"]);
        expect(tvf.map((c) => c.name)).toEqual(["line_id", "Unit Price", "qty"]);
        expect(unknown).toEqual([]);
        expect(system.map((c) => c.name)).toContain("schema_id");
    });

    it("gives the user's default schema, then dbo", async () => {
        expect(await connection.listDefaultSchemas(DATABASE, signal())).toEqual(["dbo"]);
        const user = await mssqlDriver.connect({
            options: mssqlOptions({ database: DATABASE, user: login, password: loginPassword }),
        });
        try {
            expect(await user.listDefaultSchemas(DATABASE, signal())).toEqual(["sales", "dbo"]);
            // Its unqualified names resolve in sales first.
            const own = new CompletionMetadata(user, DATABASE);
            const result = await suggest(mssqlDriver, own, "SELECT * FROM |");
            expect(item(result, "Order Lines")?.insertText).toBe("[Order Lines]");
            expect(item(result, "customers")?.insertText).toBe("customers");
            own.dispose();
        } finally {
            await user.close();
        }
    });

    it("reads another database than the session's without changing it", async () => {
        const objects = await admin.listCompletionObjects(DATABASE, signal());
        expect(objects.some((o) => o.name === "customers")).toBe(true);
        expect(await admin.getCurrentDatabase()).toBe(DATABASE);
        const other = await mssqlDriver.connect({ options: mssqlOptions() });
        try {
            const current = await other.getCurrentDatabase();
            await other.listCompletionColumns(
                DATABASE,
                [{ schema: "dbo", name: "orders" }],
                signal(),
            );
            expect(await other.getCurrentDatabase()).toBe(current);
        } finally {
            await other.close();
        }
    });

    it("never uses the query session: a long query or an open transaction does not block it", async () => {
        const session = await mssqlDriver.connect({
            options: mssqlOptions({ database: DATABASE }),
        });
        try {
            const abort = new AbortController();
            const running = session.execute(
                { text: "WAITFOR DELAY '00:00:20'", startLine: 0 },
                () => undefined,
                abort.signal,
            );
            await new Promise((r) => setTimeout(r, 300));
            expect(
                (await quickly(session.listCompletionObjects(DATABASE, signal()))).length,
            ).toBeGreaterThan(10);
            abort.abort();
            await running;

            await run(
                session,
                "BEGIN TRANSACTION; UPDATE dbo.customers SET name = name; CREATE TABLE dbo.yast_oe_completion_tx (a INT);",
            );
            const columns = await quickly(
                session.listCompletionColumns(
                    DATABASE,
                    [{ schema: "dbo", name: "customers" }],
                    signal(),
                ),
            );
            expect(columns[0].length).toBe(4);
            await quickly(session.listCompletionObjects(DATABASE, signal()));
            await run(session, "ROLLBACK");
        } finally {
            await session.close();
        }
    });

    it("cancels a read when the signal aborts", async () => {
        const abort = new AbortController();
        const reading = connection.listCompletionObjects(DATABASE, abort.signal);
        abort.abort();
        await expect(reading).rejects.toBeDefined();
        expect((await connection.listCompletionObjects(DATABASE, signal())).length).toBeGreaterThan(
            10,
        );
    });

    it("suggests from the real catalog", async () => {
        const from = await suggest(mssqlDriver, metadata, "SELECT * FROM |");
        expect(labels(from)).toEqual(
            expect.arrayContaining(["customers", "orders", "customer_orders", "sales.Order Lines"]),
        );
        expect(item(from, "sales.Order Lines")?.insertText).toBe("sales.[Order Lines]");
        expect(item(from, "objects")).toBeUndefined();

        const alias = await suggest(mssqlDriver, metadata, "SELECT c.| FROM dbo.customers c");
        expect(alias.items.map((i) => [i.label, i.description])).toEqual([
            ["id", "int"],
            ["name", "nvarchar(100)"],
            ["email", "nvarchar(255)"],
            ["created_at", "datetime2(7)"],
        ]);
        const where = await suggest(
            mssqlDriver,
            metadata,
            "SELECT * FROM dbo.customers c JOIN dbo.orders o ON o.customer_id = c.id WHERE |",
        );
        expect(labels(where)).toEqual(
            expect.arrayContaining([
                "c.id",
                "o.id",
                "email",
                "amount",
                "c",
                "o",
                "order_total",
                "GETDATE",
            ]),
        );
        expect(labels(await suggest(mssqlDriver, metadata, "EXEC |"))).toContain("archive_orders");
        expect(labels(await suggest(mssqlDriver, metadata, "USE |"))).toContain(DATABASE);
        expect(labels(await suggest(mssqlDriver, metadata, "DECLARE @x |"))).toEqual(
            expect.arrayContaining(["NVARCHAR", "phone"]),
        );
        expect(labels(await suggest(mssqlDriver, metadata, "SELECT * FROM sys.|"))).toContain(
            "objects",
        );
    });

    // -- Comparison with sqltoolsservice --------------------------------------------------------

    /** Names (and insert text) sqltoolsservice offers in a case, keeping the kinds that are compared. */
    function referenceItems(name: string, kinds: string[]): ReferenceItem[] {
        const reference_ = reference.cases[name];
        return reference_.items.filter((i) => kinds.includes(i.kind));
    }

    /** Same names offered, and same insert text for the names that need brackets. */
    async function expectSame(name: string, kinds: string[], { subset = false } = {}) {
        const expected = referenceItems(name, kinds);
        const result = await suggest(mssqlDriver, metadata, reference.cases[name].script);
        const ours = new Map(result.items.map((i) => [i.label, i]));
        for (const ref of expected) {
            // Where the user typed "[", sqltoolsservice's labels are bracketed; ours match on filterText.
            const mine =
                ours.get(ref.label) ?? result.items.find((i) => i.filterText === ref.label);
            expect(mine, `${name}: ${ref.label}`).toBeDefined();
            const insert = ref.insertText ?? ref.label;
            const needsBrackets = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(
                ref.label.replace(/^\[|\]$/g, ""),
            );
            if (needsBrackets || ref.label.startsWith("[")) {
                expect(mine!.insertText.replace(/\(\$0\)$/, ""), `${name}: ${ref.label}`).toBe(
                    insert.replace(/\(\$0\)$/, ""),
                );
            }
        }
        if (!subset) {
            const expectedLabels = new Set(expected.map((i) => i.label));
            const extra = result.items.filter(
                (i) =>
                    ["column", "table", "view", "synonym"].includes(i.kind) &&
                    !expectedLabels.has(i.label) &&
                    !expectedLabels.has(i.filterText ?? ""),
            );
            expect(
                extra.map((i) => i.label),
                name,
            ).toEqual([]);
        }
    }

    it.each([
        ["schemaDot", ["File", "Unit"]],
        ["schemaDotPartial", ["File", "Unit"]],
        ["otherSchemaDot", ["File", "Value"]],
        ["databaseSchemaDot", ["File", "Unit"]],
        ["informationSchemaDot", ["File"]],
        ["aliasDot", ["Field"]],
        ["aliasDotPartial", ["Field"]],
        ["tableDot", ["Field"]],
        ["schemaTableDot", ["Field"]],
        ["aliasDotOn", ["Field"]],
        ["bracketColumns", ["Field"]],
        ["insertColumns", ["Field"]],
        ["updateSet", ["Field"]],
        ["cte", ["Field"]],
        ["bracketPartial", ["File", "Value"]],
        ["reservedName", ["File", "Unit"]],
    ])("offers what sqltoolsservice offers: %s", async (name, kinds) => {
        await expectSame(name, kinds);
    });

    it.each([
        // Unqualified relations of the default schema, schemas (sqltoolsservice also lists the
        // built-in table functions of sys without schema; YAST offers them after "sys.").
        ["from", ["File", "Unit", "Module"]],
        ["fromPartial", ["File", "Unit", "Module"]],
        ["join", ["File", "Unit", "Module"]],
        ["commaJoin", ["File", "Unit", "Module"]],
        ["insertInto", ["File", "Unit", "Module"]],
        ["deleteFrom", ["File", "Unit", "Module"]],
        ["sysDot", ["File"]],
        ["use", ["Method"]],
        // System procedures included: sp_help, xp_logininfo... inserted without sys.
        ["exec", ["Module", "Unit"]],
        ["databaseDot", ["Module"]],
    ])("offers at least what sqltoolsservice offers: %s", async (name, kinds) => {
        await expectSame(name, kinds, { subset: true });
    });

    it("offers the user procedures after EXEC, and the columns in scope in expressions", async () => {
        const exec = await suggest(mssqlDriver, metadata, reference.cases.exec.script);
        expect(labels(exec)).toContain("archive_orders");
        for (const name of ["sp_help", "sp_who", "sp_executesql", "xp_logininfo"]) {
            expect(item(exec, name)?.insertText, name).toBe(name);
        }
        const all = [...exec.items]
            .sort((a, b) => (a.sortText < b.sortText ? -1 : 1))
            .map((i) => i.label);
        expect(all.indexOf("sp_help")).toBeGreaterThan(all.indexOf("archive_orders"));
        expect(labels(await suggest(mssqlDriver, metadata, "EXEC sys.|"))).toContain("sp_help");
        for (const name of [
            "selectList",
            "where",
            "orderBy",
            "groupBy",
            "whereTwoTables",
            "subquery",
            "secondStatement",
        ]) {
            const expected = referenceItems(name, ["Field"]).map((i) => i.label);
            const result = await suggest(mssqlDriver, metadata, reference.cases[name].script);
            const columns = result.items
                .filter((i) => i.kind === "column")
                .map((i) => i.label.replace(/^\w+\./, ""));
            expect(new Set(columns), name).toEqual(new Set(expected));
        }
        const variables = await suggest(mssqlDriver, metadata, reference.cases.variables.script);
        expect(labels(variables)).toContain("@total");
    });

    it("offers nothing in comments and strings (sqltoolsservice offers names inside strings)", async () => {
        for (const name of ["inComment", "inBlockComment", "inString"]) {
            expect(
                (await suggest(mssqlDriver, metadata, reference.cases[name].script)).items,
                name,
            ).toEqual([]);
        }
    });
});

describe("PostgreSQL completion", () => {
    let admin: DriverConnection;
    let connection: DriverConnection;
    let metadata: CompletionMetadata;

    beforeAll(async () => {
        admin = await pgDriver.connect({ options: pgOptions() });
        await run(admin, `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
        await run(admin, `CREATE DATABASE ${DATABASE}`);
        connection = await pgDriver.connect({ options: pgOptions({ database: DATABASE }) });
        await run(
            connection,
            `
            CREATE TABLE "Customers" (id SERIAL PRIMARY KEY, name VARCHAR(100), email TEXT NOT NULL);
            CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL, amount NUMERIC(10,2) NOT NULL);
            CREATE SCHEMA sales;
            CREATE TABLE sales.lines (line_id INT NOT NULL, "Unit Price" MONEY);
            CREATE TABLE sales.events (id INT, at DATE) PARTITION BY RANGE (at);
            CREATE TABLE sales.events_2024 PARTITION OF sales.events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
            CREATE VIEW customer_orders AS SELECT c.id, o.amount FROM "Customers" c JOIN orders o ON o.customer_id = c.id;
            CREATE MATERIALIZED VIEW sales.totals AS SELECT 1 AS total;
            CREATE FUNCTION order_total(customer INT) RETURNS NUMERIC LANGUAGE sql AS 'SELECT 0::numeric';
            CREATE FUNCTION order_total(customer INT, since DATE) RETURNS NUMERIC LANGUAGE sql AS 'SELECT 0::numeric';
            CREATE FUNCTION sales.top_lines(n INT) RETURNS TABLE (line_id INT, price MONEY) LANGUAGE sql AS 'SELECT line_id, "Unit Price" FROM sales.lines LIMIT n';
            CREATE FUNCTION sales.all_lines() RETURNS SETOF sales.lines LANGUAGE sql AS 'SELECT * FROM sales.lines';
            CREATE PROCEDURE archive_orders(before DATE) LANGUAGE sql AS 'SELECT 1';
            CREATE DOMAIN phone AS VARCHAR(20);
            CREATE TYPE mood AS ENUM ('ok', 'ko');
            CREATE SEQUENCE order_numbers;
            `,
        );
        metadata = new CompletionMetadata(connection, DATABASE);
    }, 60000);

    afterAll(async () => {
        metadata?.dispose();
        await connection?.close();
        if (admin) {
            await run(admin, `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(
                () => undefined,
            );
            await admin.close();
        }
    });

    it("lists the objects of the database", async () => {
        const started = Date.now();
        const objects = await connection.listCompletionObjects(DATABASE, signal());
        console.log(
            `PostgreSQL: ${objects.length} completion objects in ${Date.now() - started} ms`,
        );
        const find = (schema: string | undefined, name: string) =>
            objects.find((o) => o.schema === schema && o.name === name);
        expect(find("public", "Customers")).toMatchObject({ kind: "table" });
        expect(find("sales", "events")).toMatchObject({
            kind: "table",
            detail: "partitioned table",
        });
        expect(find("sales", "events_2024")).toBeUndefined();
        expect(find("public", "customer_orders")).toMatchObject({ kind: "view" });
        expect(find("sales", "totals")).toMatchObject({
            kind: "view",
            detail: "materialized view",
        });
        expect(find("public", "order_total")).toMatchObject({
            kind: "function",
            detail: "(customer integer) RETURNS numeric (+1 overload)",
        });
        expect(objects.filter((o) => o.name === "order_total")).toHaveLength(1);
        expect(find("sales", "top_lines")).toMatchObject({ kind: "function", returnsTable: true });
        expect(find("public", "archive_orders")).toMatchObject({
            kind: "procedure",
            detail: "(IN before date)",
        });
        expect(find("public", "phone")).toMatchObject({ kind: "type", detail: "domain" });
        expect(find("public", "mood")).toMatchObject({ kind: "type", detail: "enum" });
        expect(find("public", "order_numbers")).toMatchObject({ kind: "sequence" });
        expect(find(undefined, "sales")).toMatchObject({ kind: "schema" });
        expect(find("pg_catalog", "pg_class")).toMatchObject({ kind: "table", system: true });
        expect(find("information_schema", "tables")).toMatchObject({ kind: "view", system: true });
        // pg_catalog's thousands of functions are left to the built-in list.
        expect(objects.some((o) => o.schema === "pg_catalog" && o.kind === "function")).toBe(false);
    });

    it("lists columns of tables, views and set-returning functions", async () => {
        const [customers, lines, view, tvf, setof, unknown] =
            await connection.listCompletionColumns(
                DATABASE,
                [
                    { schema: "public", name: "Customers" },
                    { schema: "sales", name: "lines" },
                    { schema: "public", name: "customer_orders" },
                    { schema: "sales", name: "top_lines" },
                    { schema: "sales", name: "all_lines" },
                    { schema: "public", name: "nope" },
                ],
                signal(),
            );
        expect(customers).toEqual([
            { name: "id", dataType: "integer", nullable: false },
            { name: "name", dataType: "character varying(100)", nullable: true },
            { name: "email", dataType: "text", nullable: false },
        ]);
        expect(lines.map((c) => c.name)).toEqual(["line_id", "Unit Price"]);
        expect(view.map((c) => c.name)).toEqual(["id", "amount"]);
        expect(tvf.map((c) => [c.name, c.dataType])).toEqual([
            ["line_id", "integer"],
            ["price", "money"],
        ]);
        expect(setof.map((c) => c.name)).toEqual(["line_id", "Unit Price"]);
        expect(unknown).toEqual([]);
    });

    it("follows the search_path of the profile and of the database", async () => {
        expect(await connection.listDefaultSchemas(DATABASE, signal())).toEqual(["public"]);
        const withPath = await pgDriver.connect({
            options: pgOptions({ database: DATABASE, searchPath: 'sales, "$user", public' }),
        });
        try {
            expect(await withPath.listDefaultSchemas(DATABASE, signal())).toEqual([
                "sales",
                "public",
            ]);
        } finally {
            await withPath.close();
        }
        await run(admin, `ALTER DATABASE ${DATABASE} SET search_path = sales, public`);
        const fresh = await pgDriver.connect({ options: pgOptions({ database: DATABASE }) });
        try {
            expect(await fresh.listDefaultSchemas(DATABASE, signal())).toEqual(["sales", "public"]);
            const own = new CompletionMetadata(fresh, DATABASE);
            const result = await suggest(pgDriver, own, "SELECT * FROM |");
            expect(item(result, "lines")?.insertText).toBe("lines");
            expect(item(result, "Customers")?.insertText).toBe('"Customers"');
            own.dispose();
        } finally {
            await fresh.close();
            await run(admin, `ALTER DATABASE ${DATABASE} RESET search_path`);
        }
    });

    it("never uses the query session: a long query or an open transaction does not block it", async () => {
        const session = await pgDriver.connect({ options: pgOptions({ database: DATABASE }) });
        try {
            const abort = new AbortController();
            const running = session.execute(
                { text: "SELECT pg_sleep(20)", startLine: 0 },
                () => undefined,
                abort.signal,
            );
            await new Promise((r) => setTimeout(r, 300));
            expect(
                (await quickly(session.listCompletionObjects(DATABASE, signal()))).length,
            ).toBeGreaterThan(10);
            abort.abort();
            await running;

            await run(
                session,
                "BEGIN; CREATE TABLE in_transaction (a INT); LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;",
            );
            const objects = await quickly(session.listCompletionObjects(DATABASE, signal()));
            // Not committed: not visible from another connection.
            expect(objects.some((o) => o.name === "in_transaction")).toBe(false);
            await run(session, "ROLLBACK");
            expect(await session.getCurrentDatabase()).toBe(DATABASE);
        } finally {
            await session.close();
        }
    });

    it("suggests from the real catalog", async () => {
        const from = await suggest(pgDriver, metadata, "SELECT * FROM |");
        expect(labels(from)).toEqual(
            expect.arrayContaining([
                "Customers",
                "orders",
                "customer_orders",
                "sales.lines",
                "sales.top_lines",
            ]),
        );
        expect(item(from, "Customers")?.insertText).toBe('"Customers"');
        expect(item(from, "pg_class")).toBeUndefined();
        expect(labels(await suggest(pgDriver, metadata, "SELECT * FROM pg_catalog.|"))).toContain(
            "pg_class",
        );

        const alias = await suggest(pgDriver, metadata, 'SELECT c.| FROM "Customers" c');
        expect(alias.items.map((i) => [i.label, i.description])).toEqual([
            ["id", "integer"],
            ["name", "character varying(100)"],
            ["email", "text"],
        ]);
        const lines = await suggest(pgDriver, metadata, "SELECT l.| FROM sales.lines l");
        expect(item(lines, "Unit Price")?.insertText).toBe('"Unit Price"');
        expect(labels(await suggest(pgDriver, metadata, "CALL |"))).toContain("archive_orders");
        expect(labels(await suggest(pgDriver, metadata, "SELECT 1::|"))).toEqual(
            expect.arrayContaining(["TIMESTAMPTZ", "JSONB", "phone", "mood"]),
        );
        expect(labels(await suggest(pgDriver, metadata, "SELECT * FROM orders WHERE |"))).toEqual(
            expect.arrayContaining(["id", "customer_id", "amount", "order_total", "NOW"]),
        );
        expect(labels(await suggest(pgDriver, metadata, "INSERT INTO orders (|"))).toEqual([
            "id",
            "customer_id",
            "amount",
        ]);
    });
});
