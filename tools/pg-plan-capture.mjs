// Dev tool: records real EXPLAIN (FORMAT JSON) output of PostgreSQL, estimated and actual, for a set
// of queries covering the node types that can be provoked. This is the oracle of the PostgreSQL
// execution plan converter (src/drivers/pg/executionPlan/): unit tests replay the captures
// through `parse`.
//
// Usage (needs Docker; starts and removes one container per image on a random loopback port):
//   node tools/pg-plan-capture.mjs docs/reference/pg-explain-plans.json postgres:12 postgres:17 postgres:18-alpine
// With no image, postgres:17 is used. Timings and costs differ from one run to the next: a capture
// is a sample of what the server writes, not something to compare byte for byte.
//
// The EXPLAIN options are the ones of src/drivers/pg/executionPlan/explain.ts (keep them in sync).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const [outFile, ...imageArgs] = process.argv.slice(2);
if (!outFile) {
    console.error("usage: node tools/pg-plan-capture.mjs <out.json> [image...]");
    process.exit(1);
}
const images = imageArgs.length > 0 ? imageArgs : ["postgres:17"];

const SETUP = `
CREATE TABLE cust (id int PRIMARY KEY, name text NOT NULL, region int NOT NULL);
INSERT INTO cust SELECT g, 'customer ' || g, g % 20 FROM generate_series(1, 5000) g;
CREATE TABLE ord (
  id int PRIMARY KEY, cust_id int NOT NULL REFERENCES cust(id), amount numeric(10,2) NOT NULL,
  status text NOT NULL, placed date NOT NULL);
INSERT INTO ord SELECT g, 1 + (g * 7919) % 5000, (g % 1000) / 10.0,
  (ARRAY['paid','pending','cancelled','shipped'])[1 + g % 4], date '2024-01-01' + (g % 365)
  FROM generate_series(1, 60000) g;
CREATE INDEX ord_cust ON ord (cust_id);
CREATE INDEX ord_status ON ord (status);
CREATE INDEX ord_amount ON ord (amount);
CREATE INDEX ord_status_placed ON ord (status, placed);
CREATE TABLE big (n int, grp int, pad text);
INSERT INTO big SELECT g, g % 100, md5(g::text) FROM generate_series(1, 200000) g;
CREATE TABLE tree (id int PRIMARY KEY, parent int);
INSERT INTO tree SELECT g, g / 2 FROM generate_series(1, 200) g;
ANALYZE;
`;

// "min": the first major version that has the node or the syntax. "settings": SET LOCAL commands.
// Each query runs in a transaction that is rolled back, so INSERT / UPDATE / DELETE leave no trace.
const QUERIES = [
    { name: "result", sql: "SELECT 1" },
    {
        name: "seq-scan-filter",
        sql: "SELECT * FROM ord WHERE amount > 50 AND status = 'paid'",
        settings: ["SET LOCAL enable_indexscan = off", "SET LOCAL enable_bitmapscan = off"],
    },
    { name: "index-scan", sql: "SELECT * FROM ord WHERE id = 4242" },
    { name: "index-scan-backward", sql: "SELECT * FROM ord ORDER BY id DESC LIMIT 5" },
    { name: "index-only-scan", sql: "SELECT id FROM ord WHERE id < 500" },
    { name: "bitmap-heap-scan", sql: "SELECT * FROM ord WHERE cust_id < 40" },
    {
        name: "bitmap-or",
        sql: "SELECT * FROM ord WHERE cust_id = 5 OR status = 'cancelled' AND placed = '2024-03-01'",
        settings: ["SET LOCAL enable_seqscan = off"],
    },
    {
        name: "bitmap-and",
        sql: "SELECT * FROM ord WHERE cust_id < 300 AND amount < 5",
        settings: ["SET LOCAL enable_seqscan = off", "SET LOCAL enable_indexscan = off"],
    },
    { name: "tid-scan", sql: "SELECT * FROM cust WHERE ctid = '(0,1)'" },
    { name: "tid-range-scan", sql: "SELECT * FROM cust WHERE ctid < '(1,0)'", min: 14 },
    { name: "sample-scan", sql: "SELECT * FROM big TABLESAMPLE SYSTEM (1)" },
    { name: "function-scan", sql: "SELECT * FROM generate_series(1, 10) AS g(i)" },
    {
        name: "values-scan",
        sql: "SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS v(n, s) WHERE n > 1",
    },
    {
        name: "table-function-scan",
        sql: "SELECT * FROM XMLTABLE('/r/x' PASSING ('<r><x>1</x><x>2</x></r>'::xml) COLUMNS v int PATH '.')",
    },
    {
        name: "subquery-scan",
        sql: "SELECT * FROM (SELECT status, count(*) AS c FROM ord GROUP BY status) s WHERE c > 10",
    },
    {
        name: "nested-loop",
        sql: "SELECT c.name, o.amount FROM cust c JOIN ord o ON o.cust_id = c.id WHERE c.id < 20",
    },
    {
        name: "hash-join",
        sql: "SELECT c.name, o.amount FROM cust c JOIN ord o ON o.cust_id = c.id",
    },
    {
        name: "hash-left-join",
        sql: "SELECT c.name, o.id FROM cust c LEFT JOIN ord o ON o.cust_id = c.id AND o.amount > 99",
    },
    {
        name: "hash-semi-join",
        sql: "SELECT * FROM cust c WHERE EXISTS (SELECT 1 FROM ord o WHERE o.cust_id = c.id AND o.amount > 99)",
    },
    {
        name: "hash-anti-join",
        sql: "SELECT * FROM cust c WHERE NOT EXISTS (SELECT 1 FROM ord o WHERE o.cust_id = c.id)",
    },
    {
        name: "merge-join",
        sql: "SELECT c.name, o.amount FROM cust c JOIN ord o ON o.cust_id = c.id",
        settings: ["SET LOCAL enable_hashjoin = off", "SET LOCAL enable_nestloop = off"],
    },
    {
        name: "memoize",
        sql: "SELECT c.id, (SELECT count(*) FROM ord o WHERE o.cust_id = c.id) FROM cust c",
        min: 14,
    },
    {
        name: "memoize-join",
        sql: "SELECT * FROM ord o JOIN cust c ON c.id = o.cust_id WHERE o.id < 20000",
        settings: ["SET LOCAL enable_hashjoin = off", "SET LOCAL enable_mergejoin = off"],
        min: 14,
    },
    { name: "sort", sql: "SELECT * FROM ord ORDER BY amount DESC, placed" },
    { name: "sort-top-n", sql: "SELECT * FROM ord ORDER BY placed DESC, amount LIMIT 10" },
    {
        name: "sort-spill",
        sql: "SELECT * FROM big ORDER BY pad",
        settings: ["SET LOCAL work_mem = '64kB'", "SET LOCAL max_parallel_workers_per_gather = 0"],
    },
    {
        name: "hash-spill",
        sql: "SELECT * FROM big a JOIN big b ON a.pad = b.pad WHERE a.n < 100000",
        settings: [
            "SET LOCAL work_mem = '64kB'",
            "SET LOCAL max_parallel_workers_per_gather = 0",
            "SET LOCAL enable_mergejoin = off",
        ],
    },
    {
        name: "incremental-sort",
        sql: "SELECT * FROM ord ORDER BY status, amount LIMIT 100",
        min: 13,
        settings: ["SET LOCAL enable_seqscan = off"],
    },
    { name: "aggregate-plain", sql: "SELECT count(*), avg(amount) FROM ord" },
    { name: "aggregate-hashed", sql: "SELECT cust_id, sum(amount) FROM ord GROUP BY cust_id" },
    {
        name: "aggregate-sorted",
        sql: "SELECT cust_id, sum(amount) FROM ord GROUP BY cust_id",
        settings: ["SET LOCAL enable_hashagg = off"],
    },
    {
        name: "aggregate-mixed",
        sql: "SELECT status, placed, count(*) FROM ord GROUP BY GROUPING SETS ((status), (status, placed), ())",
        settings: ["SET LOCAL max_parallel_workers_per_gather = 0"],
    },
    {
        name: "group",
        sql: "SELECT cust_id FROM ord GROUP BY cust_id",
        settings: ["SET LOCAL enable_hashagg = off"],
    },
    {
        name: "unique",
        sql: "SELECT DISTINCT cust_id FROM ord ORDER BY cust_id",
        settings: ["SET LOCAL enable_hashagg = off"],
    },
    { name: "limit", sql: "SELECT * FROM ord WHERE status = 'paid' LIMIT 10" },
    { name: "limit-offset-sort", sql: "SELECT * FROM ord ORDER BY amount OFFSET 100 LIMIT 5" },
    {
        name: "materialize",
        sql: "SELECT * FROM cust c JOIN cust d ON d.region < c.region WHERE c.id < 50 AND d.id < 100",
    },
    {
        name: "cte-materialized",
        sql: "WITH paid AS MATERIALIZED (SELECT * FROM ord WHERE status = 'paid') SELECT count(*) FROM paid p1 JOIN paid p2 ON p1.cust_id = p2.cust_id AND p2.amount > 99",
        min: 12,
    },
    {
        name: "cte-scan",
        sql: "WITH s AS MATERIALIZED (SELECT cust_id, sum(amount) AS t FROM ord GROUP BY cust_id) SELECT * FROM s WHERE t > 100",
        min: 12,
    },
    {
        name: "recursive-cte",
        sql: "WITH RECURSIVE t(id, parent, depth) AS (SELECT id, parent, 0 FROM tree WHERE id = 1 UNION ALL SELECT n.id, n.parent, t.depth + 1 FROM tree n JOIN t ON n.parent = t.id) SELECT * FROM t",
    },
    {
        name: "initplan",
        sql: "SELECT * FROM ord WHERE amount > (SELECT avg(amount) FROM ord) AND id < 100",
    },
    {
        name: "subplan",
        sql: "SELECT c.id, (SELECT max(amount) FROM ord o WHERE o.cust_id = c.id) AS m FROM cust c WHERE c.id < 50",
        settings: ["SET LOCAL enable_memoize = off"],
        min: 14,
    },
    {
        name: "subplan-hashed",
        sql: "SELECT * FROM cust WHERE id NOT IN (SELECT cust_id FROM ord WHERE amount > 99)",
    },
    {
        name: "window",
        sql: "SELECT id, cust_id, sum(amount) OVER (PARTITION BY cust_id ORDER BY placed) FROM ord WHERE id < 5000",
    },
    { name: "union-all", sql: "SELECT id FROM cust UNION ALL SELECT id FROM ord WHERE id < 100" },
    { name: "union", sql: "SELECT cust_id FROM ord UNION SELECT id FROM cust" },
    {
        name: "merge-append",
        sql: "SELECT id FROM cust UNION ALL SELECT id FROM ord WHERE id < 100 ORDER BY 1",
    },
    { name: "intersect", sql: "SELECT cust_id FROM ord INTERSECT SELECT id FROM cust" },
    {
        name: "except-sorted",
        sql: "SELECT id FROM cust EXCEPT ALL SELECT cust_id FROM ord",
        settings: ["SET LOCAL enable_hashagg = off"],
    },
    { name: "project-set", sql: "SELECT id, generate_series(1, 3) FROM cust WHERE id < 5" },
    { name: "lock-rows", sql: "SELECT * FROM cust WHERE id < 10 FOR UPDATE" },
    {
        name: "insert",
        sql: "INSERT INTO cust SELECT g + 100000, 'new', 1 FROM generate_series(1, 100) g",
        mutates: true,
    },
    {
        name: "insert-returning",
        sql: "INSERT INTO cust VALUES (100001, 'x', 1) RETURNING id",
        mutates: true,
    },
    { name: "update", sql: "UPDATE ord SET status = 'late' WHERE cust_id = 7", mutates: true },
    { name: "delete", sql: "DELETE FROM ord WHERE id < 100", mutates: true },
    {
        name: "insert-cte",
        sql: "WITH d AS (DELETE FROM ord WHERE id < 50 RETURNING cust_id) INSERT INTO tree SELECT cust_id + 10000, 1 FROM d",
        mutates: true,
    },
    {
        name: "merge",
        sql: "MERGE INTO cust t USING (VALUES (1, 'merged'), (200000, 'fresh')) AS s(id, name) ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.name, 0)",
        mutates: true,
        min: 15,
    },
    {
        name: "create-table-as",
        sql: "CREATE TABLE ord_paid AS SELECT * FROM ord WHERE status = 'paid'",
        mutates: true,
    },
    {
        name: "gather",
        sql: "SELECT count(*), sum(n) FROM big WHERE grp < 50",
        settings: [
            "SET LOCAL parallel_setup_cost = 0",
            "SET LOCAL parallel_tuple_cost = 0",
            "SET LOCAL min_parallel_table_scan_size = 0",
            "SET LOCAL max_parallel_workers_per_gather = 2",
        ],
    },
    {
        name: "gather-merge",
        sql: "SELECT * FROM big ORDER BY n DESC",
        settings: [
            "SET LOCAL parallel_setup_cost = 0",
            "SET LOCAL parallel_tuple_cost = 0",
            "SET LOCAL min_parallel_table_scan_size = 0",
            "SET LOCAL max_parallel_workers_per_gather = 2",
            "SET LOCAL enable_indexscan = off",
        ],
    },
    {
        name: "parallel-hash-join",
        sql: "SELECT count(*) FROM big a JOIN big b ON a.n = b.n",
        settings: [
            "SET LOCAL parallel_setup_cost = 0",
            "SET LOCAL parallel_tuple_cost = 0",
            "SET LOCAL min_parallel_table_scan_size = 0",
            "SET LOCAL max_parallel_workers_per_gather = 2",
        ],
        min: 12,
    },
    {
        name: "settings",
        sql: "SELECT * FROM ord WHERE cust_id = 3",
        settings: ["SET LOCAL enable_bitmapscan = off", "SET LOCAL random_page_cost = 1.1"],
    },
];

const ESTIMATED = "EXPLAIN (FORMAT JSON, VERBOSE, SETTINGS)";
const actualOptions = (major) =>
    `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS${major >= 13 ? ", WAL" : ""}, FORMAT JSON)`;

function docker(...args) {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`docker ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
}

/** The image restarts its server once after initdb, so the first connections may fail. */
async function connectWhenReady(config) {
    for (let attempt = 0; ; attempt++) {
        const client = new Client(config);
        try {
            await client.connect();
            await client.query("SELECT 1");
            return client;
        } catch (error) {
            await client.end().catch(() => undefined);
            if (attempt > 60) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}

async function capture(image) {
    const password = randomBytes(12).toString("hex");
    const name = `yast-plan-capture-${randomBytes(4).toString("hex")}`;
    docker(
        "run",
        "-d",
        "--name",
        name,
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-p",
        "127.0.0.1::5432",
        image,
    );
    try {
        const port = Number(docker("port", name, "5432/tcp").split(":").pop());
        const client = await connectWhenReady({
            host: "127.0.0.1",
            port,
            user: "postgres",
            password,
            database: "postgres",
        });
        await client.query(SETUP);
        const version = (await client.query("SHOW server_version")).rows[0].server_version;
        const major = Number(
            (await client.query("SHOW server_version_num")).rows[0].server_version_num.slice(0, -4),
        );
        const plans = [];
        for (const query of QUERIES) {
            if (query.min && major < query.min) continue;
            for (const kind of ["estimated", "actual"]) {
                const explain = kind === "estimated" ? ESTIMATED : actualOptions(major);
                try {
                    await client.query("BEGIN");
                    for (const setting of query.settings ?? []) await client.query(setting);
                    const rows = (await client.query(`${explain} ${query.sql}`)).rows;
                    plans.push({
                        name: query.name,
                        kind,
                        sql: query.sql,
                        settings: query.settings ?? [],
                        plan: rows[0]["QUERY PLAN"],
                    });
                } catch (error) {
                    console.warn(`${image} ${query.name} (${kind}): ${error.message}`);
                } finally {
                    await client.query("ROLLBACK").catch(() => undefined);
                }
            }
        }
        await client.end();
        return { image, serverVersion: version, plans };
    } finally {
        docker("rm", "-f", "-v", name);
    }
}

const captures = [];
for (const image of images) {
    console.log(`capturing ${image}`);
    captures.push(await capture(image));
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ captures }) + "\n");
console.log(`${outFile}: ${captures.map((c) => `${c.image} ${c.plans.length} plans`).join(", ")}`);
