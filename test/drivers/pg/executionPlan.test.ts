import { describe, expect, it } from "vitest";
import { pgDriver } from "../../../src/drivers/pg";
import {
    classifyStatement,
    explainPrefix,
    majorVersion,
} from "../../../src/drivers/pg/executionPlan/explain";
import { NODE_TYPES, iconFor } from "../../../src/drivers/pg/executionPlan/operators";
import { NEVER_EXECUTED, parsePgPlan } from "../../../src/drivers/pg/executionPlan/parse";
import {
    BadgeType,
    ExecutionPlanGraphElementPropertyDataType as DataType,
    type ExecutionPlanGraph,
    type ExecutionPlanNode,
} from "../../../src/sharedInterfaces/executionPlan";
import captures from "../../../docs/reference/pg-explain-plans.json";

/** Names of the icons of vscode-mssql's `webviews/pages/ExecutionPlan/icons` (the page's keys). */
const UPSTREAM_ICONS = new Set(
    (
        "adaptive_join aggregate apply arithmetic_expression assert assign batch_hash_table_build bitmap " +
        "bookmark_lookup broadcast clustered_index_delete clustered_index_insert clustered_index_merge " +
        "clustered_index_scan clustered_index_seek clustered_index_update clustered_update " +
        "columnstore_index_delete columnstore_index_insert columnstore_index_merge " +
        "columnstore_index_scan columnstore_index_update compute_scalar compute_to_control_node " +
        "concatenation const_table_get constant_scan control_to_compute_nodes convert cursor_catch_all " +
        "declare delete deleted_scan dynamic external_broadcast external_export external_local_streaming " +
        "external_round_robin external_shuffle fetch_query filter foreign_key_references_check get " +
        "group_by_aggregate hash_match hash_match_root hash_match_team if index_delete index_insert " +
        "index_scan index_seek index_spool index_update insert inserted_scan intrinsic iterator_catch_all " +
        "join keyset language_construct_catch_all locate log_row_scan merge_interval merge_join " +
        "nested_loops parallelism parameter_table_scan population_query predict print project rank " +
        "refresh_query remote_delete remote_index_scan remote_index_seek remote_insert remote_query " +
        "remote_scan remote_update result rid_lookup row_count_spool segment sequence sequence_project " +
        "set_function shuffle single_source_round_robin single_source_shuffle snapshot sort split spool " +
        "sql stream_aggregate switch table_delete table_insert table_merge table_scan table_spool " +
        "table_update table_valued_function top trim udx union union_all update window_aggregate"
    ).split(" "),
);

/** Every "Node Type" of ExplainNode in PostgreSQL's src/backend/commands/explain.c (JSON names). */
const EXPLAIN_NODE_TYPES = [
    "Result",
    "ProjectSet",
    "ModifyTable",
    "Append",
    "Merge Append",
    "Recursive Union",
    "BitmapAnd",
    "BitmapOr",
    "Nested Loop",
    "Merge Join",
    "Hash Join",
    "Seq Scan",
    "Sample Scan",
    "Gather",
    "Gather Merge",
    "Index Scan",
    "Index Only Scan",
    "Bitmap Index Scan",
    "Bitmap Heap Scan",
    "Tid Scan",
    "Tid Range Scan",
    "Subquery Scan",
    "Function Scan",
    "Table Function Scan",
    "Values Scan",
    "CTE Scan",
    "Named Tuplestore Scan",
    "WorkTable Scan",
    "Foreign Scan",
    "Custom Scan",
    "Materialize",
    "Memoize",
    "Sort",
    "Incremental Sort",
    "Group",
    "Aggregate",
    "WindowAgg",
    "Unique",
    "SetOp",
    "LockRows",
    "Limit",
    "Hash",
];

type Kind = "estimated" | "actual";
interface CapturedPlan {
    name: string;
    kind: Kind;
    sql: string;
    plan: unknown[];
}
interface Capture {
    image: string;
    serverVersion: string;
    plans: CapturedPlan[];
}
const CAPTURES = (captures as { captures: Capture[] }).captures;

function* walk(node: ExecutionPlanNode): Generator<ExecutionPlanNode> {
    yield node;
    for (const child of node.children) yield* walk(child);
}
const nodesOf = (graph: ExecutionPlanGraph) => [...walk(graph.root)];
const property = (node: ExecutionPlanNode, name: string) =>
    node.properties.find((p) => p.name === name);

/**
 * `parse` with the statement node set aside: `root` is the plan's top operator and `statement`
 * the root node `parse` returns. Most tests are about operators.
 */
function parseTop(content: string) {
    return parsePgPlan(content).map((graph) => ({
        ...graph,
        statement: graph.root,
        root: graph.root.children[0],
    }));
}

const doc = (plan: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify([{ Plan: plan, ...extra }]);
const scan = (extra: Record<string, unknown> = {}) => ({
    "Node Type": "Seq Scan",
    "Relation Name": "t",
    Schema: "public",
    Alias: "t",
    "Startup Cost": 0,
    "Total Cost": 10,
    "Plan Rows": 100,
    "Plan Width": 8,
    ...extra,
});

describe("node types and icons", () => {
    it("has an entry for every node type of explain.c, and none else", () => {
        expect(Object.keys(NODE_TYPES).sort()).toEqual([...EXPLAIN_NODE_TYPES].sort());
    });

    it.each(EXPLAIN_NODE_TYPES)("gives %s an icon of the page", (type) => {
        expect(UPSTREAM_ICONS.has(iconFor({ "Node Type": type }))).toBe(true);
        expect(NODE_TYPES[type].description).not.toBe("");
    });

    it("picks the icon from the strategy, operation and condition of a node", () => {
        const icon = (node: Record<string, unknown>) => iconFor(node);
        expect(icon({ "Node Type": "Aggregate", Strategy: "Plain" })).toBe("aggregate");
        expect(icon({ "Node Type": "Aggregate", Strategy: "Sorted" })).toBe("stream_aggregate");
        expect(icon({ "Node Type": "Aggregate", Strategy: "Hashed" })).toBe("hash_match");
        expect(icon({ "Node Type": "Aggregate", Strategy: "Mixed" })).toBe("hash_match");
        expect(icon({ "Node Type": "ModifyTable", Operation: "Insert" })).toBe("table_insert");
        expect(icon({ "Node Type": "ModifyTable", Operation: "Update" })).toBe("table_update");
        expect(icon({ "Node Type": "ModifyTable", Operation: "Delete" })).toBe("table_delete");
        expect(icon({ "Node Type": "ModifyTable", Operation: "Merge" })).toBe("table_merge");
        expect(icon({ "Node Type": "Index Scan", "Index Cond": "(id = 1)" })).toBe("index_seek");
        expect(icon({ "Node Type": "Index Scan" })).toBe("index_scan");
        expect(icon({ "Node Type": "Foreign Scan", Operation: "Insert" })).toBe("remote_insert");
        expect(icon({ "Node Type": "SetOp", Strategy: "Hashed" })).toBe("hash_match");
        expect(icon({ "Node Type": "Hash Join", "Join Type": "Left" })).toBe("hash_match");
    });

    it("falls back to the generic operator for a node type of a newer server", () => {
        expect(iconFor({ "Node Type": "Quantum Scan" })).toBe("iterator_catch_all");
        expect(iconFor({})).toBe("iterator_catch_all");
    });
});

describe("replaying real EXPLAIN output", () => {
    it("has captures of the oldest and of a recent server", () => {
        const majors = CAPTURES.map((c) => Number(c.serverVersion.split(".")[0]));
        expect(Math.min(...majors)).toBe(12);
        expect(Math.max(...majors)).toBeGreaterThanOrEqual(17);
    });

    for (const capture of CAPTURES) {
        describe(`${capture.image} (${capture.serverVersion})`, () => {
            it.each(capture.plans.map((p) => [`${p.name} (${p.kind})`, p] as const))(
                "%s",
                (_label, captured) => {
                    const content = JSON.stringify(captured.plan);
                    const graphs = pgDriver.executionPlan!.parse(content);
                    expect(graphs).toHaveLength(1);
                    const [graph] = graphs;
                    expect(graph.graphFile).toEqual({
                        graphFileContent: content,
                        graphFileType: "json",
                        planIndexInFile: 0,
                    });
                    expect(graph.recommendations).toEqual([]);
                    expectInvariants(graph, captured.kind);
                },
            );
        });
    }

    function expectInvariants(graph: ExecutionPlanGraph, kind: Kind) {
        const nodes = nodesOf(graph);
        const ids = nodes.map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
        let relativeSum = 0;
        for (const node of nodes) {
            expect(UPSTREAM_ICONS.has(node.type), `icon ${node.type}`).toBe(true);
            for (const value of [node.cost, node.subTreeCost, node.relativeCost]) {
                expect(Number.isFinite(value)).toBe(true);
                expect(value).toBeGreaterThanOrEqual(0);
            }
            expect(node.relativeCost).toBeLessThanOrEqual(1 + 1e-9);
            expect(Number.isFinite(node.elapsedTimeInMs)).toBe(true);
            expect(node.elapsedTimeInMs).toBeGreaterThanOrEqual(0);
            // The subtree is the node plus its children's subtrees.
            const below = node.children.reduce((sum, c) => sum + c.subTreeCost, 0);
            expect(node.subTreeCost).toBeCloseTo(node.cost + below, 6);
            expect(node.edges).toHaveLength(node.children.length);
            for (const edge of node.edges) {
                expect(edge.rowCount).toBeGreaterThanOrEqual(0);
                expect(Number.isFinite(edge.rowSize)).toBe(true);
            }
            expect(node.name).not.toBe("");
            expect(node.subtext).toEqual(node.name.split("\n"));
            if (node !== graph.root) {
                expect(node.description).not.toBe("");
                expect(node.rowCountDisplayString).not.toBe("");
            }
            expect(node.costDisplayString).toMatch(/^\d+(\.\d+)?%$/);
            for (const p of node.properties) {
                expect(p.name).not.toBe("");
                expect(Number.isFinite(p.displayOrder)).toBe(true);
                if (p.dataType === DataType.Nested) expect(Array.isArray(p.value)).toBe(true);
                else expect(typeof p.value).toBe("string");
            }
            expect(property(node, "Node Type")?.displayOrder).toBe(0);
            if (kind === "actual" && node !== graph.root) {
                expect(node.costMetrics.some((m) => m.name === "ActualRows")).toBe(true);
            }
            relativeSum += node.relativeCost;
        }
        // The page's "Rows: x of y" and "Elapsed" counters: on an actual plan only.
        if (kind === "estimated") {
            for (const node of nodes) expect(node.liveQueryStatistics).toBeUndefined();
            expect(graph.liveQueryStatistics).toBeUndefined();
        } else {
            for (const node of nodes) {
                const stats = node.liveQueryStatistics;
                if (node === graph.root) {
                    expect(Object.keys(stats!)).toEqual(["elapsedTimeInMs"]);
                    continue;
                }
                if (node.rowCountDisplayString === "never executed") {
                    expect(stats).toEqual({});
                    continue;
                }
                const type = String(property(node, "Node Type")!.value);
                if (["ModifyTable", "BitmapAnd", "BitmapOr"].includes(type)) {
                    // PostgreSQL counts no rows there: no rows line on the page.
                    expect(stats!.actualRows).toBeUndefined();
                    expect(stats!.estimatedRows).toBeUndefined();
                } else {
                    expect(stats!.actualRows).toMatch(/^\d+$/);
                    expect(stats!.actualRows).toBe(node.rowCountDisplayString);
                    expect(Number.isFinite(stats!.estimatedRows)).toBe(true);
                    expect(stats!.estimatedRows).toBeGreaterThanOrEqual(0);
                }
                expect(stats!.elapsedTimeInMs).toBeGreaterThanOrEqual(0);
            }
            const longest = Math.max(
                ...nodes.map((n) => n.liveQueryStatistics?.elapsedTimeInMs ?? 0),
            );
            expect(graph.liveQueryStatistics).toEqual({ elapsedTimeInMs: longest });
            expect(graph.root.liveQueryStatistics).toEqual({ elapsedTimeInMs: longest });
            expect(longest).toBeGreaterThanOrEqual(
                Number(property(graph.root, "Execution Time")!.value),
            );
        }
        // The statement node: free, with the plan below it and one edge to its top operator.
        const top = graph.root.children[0];
        expect(graph.root.id).toBe("0");
        expect(graph.root.children).toHaveLength(1);
        expect(graph.root.cost).toBe(0);
        expect(graph.root.relativeCost).toBe(0);
        expect(graph.root.elapsedTimeInMs).toBe(0);
        expect(graph.root.badges).toEqual([]);
        expect(graph.root.subTreeCost).toBeCloseTo(top.subTreeCost, 9);
        expect(graph.root.edges[0].rowSize).toBe(Number(property(top, "Plan Width")!.value));
        expect(graph.root.edges[0].rowCount).toBe(Number(top.rowCountDisplayString) || 0);
        expect(graph.root.name).toBe("Query");
        expect(relativeSum).toBeCloseTo(graph.root.subTreeCost > 0 ? 1 : 0, 6);
        // Page: total relative cost of a statement = root.cost + root.subTreeCost = the plan's total.
        expect(graph.root.cost + graph.root.subTreeCost).toBeCloseTo(
            nodes.reduce((sum, n) => sum + n.cost, 0),
            6,
        );
        // Whole-statement properties are on the statement node, not on the top operator.
        for (const name of ["Planning Time", "Execution Time", "Settings", "JIT", "Triggers"]) {
            expect(property(top, name)).toBeUndefined();
        }
        if (kind === "actual") {
            expect(property(graph.root, "Planning Time")).toBeDefined();
            expect(property(graph.root, "Execution Time")).toBeDefined();
        }
    }

    const first = (name: string, kind: Kind, image = "postgres:17") => {
        const captured = CAPTURES.find((c) => c.image === image)!.plans.find(
            (p) => p.name === name && p.kind === kind,
        )!;
        return parseTop(JSON.stringify(captured.plan))[0];
    };

    it("covers all node types that can be provoked", () => {
        const seen = new Set<string>();
        for (const capture of CAPTURES) {
            for (const plan of capture.plans) {
                const [graph] = parseTop(JSON.stringify(plan.plan));
                for (const node of nodesOf(graph)) {
                    seen.add(String(property(node, "Node Type")?.value));
                }
            }
        }
        // Foreign Scan, Custom Scan and Named Tuplestore Scan need an extension or a trigger.
        const missing = EXPLAIN_NODE_TYPES.filter((t) => !seen.has(t));
        expect(missing.sort()).toEqual(["Custom Scan", "Foreign Scan", "Named Tuplestore Scan"]);
    });

    it("converts an estimated hash join", () => {
        const graph = first("hash-join", "estimated");
        const root = graph.root;
        expect(graph.query).toBe("");
        expect(root.type).toBe("hash_match");
        expect(root.name).toBe("Hash Join\n(Inner Join)");
        expect(root.subtext).toEqual(["Hash Join", "(Inner Join)"]);
        expect(root.children.map((c) => c.name)).toEqual(["Seq Scan\npublic.ord o", "Hash"]);
        expect(root.children[1].type).toBe("batch_hash_table_build");
        expect(root.children[1].children[0].name).toBe("Seq Scan\npublic.cust c");
        expect(root.rowCountDisplayString).toBe(property(root, "Plan Rows")!.value);
        // No run-time counters in an estimated plan.
        expect(property(root, "Actual Rows")).toBeUndefined();
        expect(root.elapsedTimeInMs).toBe(0);
        expect(root.badges).toEqual([]);
        // The edge carries the rows and the width of the child.
        expect(root.edges[0].rowCount).toBe(Number(property(root.children[0], "Plan Rows")!.value));
        expect(root.edges[0].rowSize).toBe(Number(property(root.children[0], "Plan Width")!.value));
    });

    it("converts an actual plan with rows, loops and time", () => {
        const graph = first("nested-loop", "actual");
        const root = graph.root;
        expect(root.name).toBe("Nested Loop\n(Inner Join)");
        const inner = root.children[1];
        const loops = Number(property(inner, "Actual Loops")!.value);
        expect(loops).toBeGreaterThan(1);
        const rowsPerLoop = Number(property(inner, "Actual Rows")!.value);
        expect(inner.rowCountDisplayString).toBe(String(Math.round(rowsPerLoop * loops)));
        expect(property(inner, "Actual Number of Rows for All Executions")!.value).toBe(
            String(Math.round(rowsPerLoop * loops)),
        );
        expect(inner.costMetrics.find((m) => m.name === "ActualRows")!.value).toBe(
            Math.round(rowsPerLoop * loops),
        );
        const rootTime = Number(property(root, "Actual Total Time")!.value);
        expect(Number(property(graph.statement, "Execution Time")!.value)).toBeGreaterThanOrEqual(
            rootTime,
        );
        // The time of the root node alone does not include its children.
        expect(root.elapsedTimeInMs).toBeLessThanOrEqual(rootTime);
    });

    it("labels InitPlans, SubPlans and CTEs", () => {
        const initplan = first("initplan", "estimated");
        const sub = nodesOf(initplan).find((n) => n.name.includes("InitPlan"))!;
        expect(sub.name).toMatch(/^Aggregate\nInitPlan 1/);
        expect(property(sub, "Parent Relationship")!.value).toBe("InitPlan");
        const cte = first("cte-scan", "estimated");
        const lines = nodesOf(cte).map((n) => n.name.split("\n"));
        expect(lines).toContainEqual(["CTE Scan", "CTE s"]);
        // The node that computes the CTE is labelled with it too.
        expect(lines).toContainEqual(["HashAggregate", "CTE s"]);
        const sp = first("subplan", "estimated");
        expect(nodesOf(sp).some((n) => /\nSubPlan \d/.test(n.name))).toBe(true);
    });

    it("names an index scan after its index and table", () => {
        const graph = first("index-scan", "estimated");
        expect(graph.root.name).toBe("Index Scan\nord_pkey on public.ord");
        expect(graph.root.type).toBe("index_seek");
        const backward = first("index-scan-backward", "estimated");
        expect(nodesOf(backward).map((n) => n.name.split("\n")[0])).toContain(
            "Index Scan Backward",
        );
    });

    it("marks everything below a Gather as parallel", () => {
        const graph = first("gather", "actual");
        const gather = nodesOf(graph).find((n) => n.name.startsWith("Gather"))!;
        for (const node of walk(gather)) {
            expect(node.badges.some((b) => b.type === BadgeType.Parallelism)).toBe(true);
        }
        expect(graph.root.badges.some((b) => b.type === BadgeType.Parallelism)).toBe(false);
        expect(property(gather, "Workers Launched")!.dataType).toBe(DataType.Number);
        const withWorkers = nodesOf(graph).find((n) => property(n, "Workers"));
        expect(property(withWorkers!, "Workers")!.dataType).toBe(DataType.Nested);
    });

    it("warns about a sort that spilled to disk", () => {
        const graph = first("sort-spill", "actual");
        const sort = nodesOf(graph).find((n) => n.name.startsWith("Sort"))!;
        const warning = sort.badges.find((b) => b.type === BadgeType.Warning);
        expect(warning!.tooltip).toMatch(/spilled to disk/);
        expect(property(sort, "Warnings")!.dataType).toBe(DataType.Nested);
        expect(property(sort, "Sort Space Type")!.value).toBe("Disk");
        const quiet = first("sort", "actual");
        expect(nodesOf(quiet).some((n) => n.name.startsWith("Sort") && n.badges.length > 0)).toBe(
            false,
        );
    });

    it("warns about a hash that was split into batches", () => {
        const graph = first("hash-spill", "actual");
        const hash = nodesOf(graph).find((n) => n.name === "Hash")!;
        expect(hash.badges.find((b) => b.type === BadgeType.Warning)!.tooltip).toMatch(
            /split into \d+ batches/,
        );
    });

    it("shows the settings and statement properties on the root", () => {
        const graph = first("settings", "actual");
        const settings = property(graph.statement, "Settings")!;
        expect(settings.dataType).toBe(DataType.Nested);
        expect((settings.value as { name: string }[]).map((p) => p.name)).toContain(
            "random_page_cost",
        );
        expect(property(graph.root, "Shared Hit Blocks")).toBeDefined();
        expect(property(graph.statement, "Execution Time")!.displayValue).toMatch(/ ms$/);
    });

    it("converts ModifyTable with its operation", () => {
        const update = first("update", "actual");
        expect(update.root.name).toBe("Update\npublic.ord");
        expect(update.root.type).toBe("table_update");
        const insert = first("insert", "estimated");
        expect(insert.root.type).toBe("table_insert");
    });

    it("keeps the costs of the server and attributes them so that they add up", () => {
        const graph = first("limit", "estimated");
        const root = graph.root;
        expect(root.name).toBe("Limit");
        expect(root.subTreeCost).toBe(Number(property(root, "Total Cost")!.value));
        const total = nodesOf(graph).reduce((sum, n) => sum + n.cost, 0);
        expect(total).toBeCloseTo(root.subTreeCost, 6);
    });
});

describe("costs", () => {
    it("scales the children of a node that costs less than they do (Limit)", () => {
        const [graph] = parseTop(
            doc({
                "Node Type": "Limit",
                "Startup Cost": 0,
                "Total Cost": 10,
                "Plan Rows": 5,
                "Plan Width": 4,
                Plans: [
                    scan({ "Total Cost": 1000, "Parent Relationship": "Outer", "Plan Rows": 1000 }),
                ],
            }),
        );
        const [limit, child] = [graph.root, graph.root.children[0]];
        expect(limit.cost).toBe(0);
        expect(limit.subTreeCost).toBe(10);
        expect(child.cost).toBeCloseTo(10, 9);
        expect(child.subTreeCost).toBeCloseTo(10, 9);
        expect(limit.relativeCost).toBe(0);
        expect(child.relativeCost).toBeCloseTo(1, 9);
        expect(child.costDisplayString).toBe("100%");
        // The server's number is still there.
        expect(property(child, "Total Cost")!.value).toBe("1000");
    });

    it("gives a node the part of its cost its children do not explain", () => {
        const [graph] = parseTop(
            doc({
                "Node Type": "Hash Join",
                "Join Type": "Inner",
                "Total Cost": 100,
                "Plan Rows": 5,
                "Plan Width": 4,
                Plans: [
                    scan({ "Total Cost": 30, "Parent Relationship": "Outer" }),
                    scan({ "Total Cost": 50, "Parent Relationship": "Inner" }),
                ],
            }),
        );
        expect(graph.root.cost).toBe(20);
        expect(graph.root.relativeCost).toBeCloseTo(0.2, 9);
        expect(graph.root.children.map((c) => c.relativeCost)).toEqual([
            expect.closeTo(0.3, 9),
            expect.closeTo(0.5, 9),
        ]);
        expect(graph.root.costDisplayString).toBe("20%");
    });

    it("counts the inner side of a nested loop once per execution in an actual plan", () => {
        // Estimated: PostgreSQL costs the inner side once, so the loop's own cost is the rest.
        const [estimated] = parseTop(
            doc({
                "Node Type": "Nested Loop",
                "Join Type": "Inner",
                "Total Cost": 60,
                "Plan Rows": 5,
                "Plan Width": 4,
                Plans: [
                    scan({ "Total Cost": 10, "Parent Relationship": "Outer" }),
                    scan({ "Total Cost": 2, "Parent Relationship": "Inner" }),
                ],
            }),
        );
        expect(estimated.root.cost).toBe(48);
        // Actual, 20 executions of the inner side: it carries them.
        const [actual] = parseTop(
            doc({
                "Node Type": "Nested Loop",
                "Join Type": "Inner",
                "Total Cost": 60,
                "Plan Rows": 5,
                "Plan Width": 4,
                "Actual Loops": 1,
                "Actual Rows": 5,
                "Actual Total Time": 1,
                Plans: [
                    scan({
                        "Total Cost": 10,
                        "Parent Relationship": "Outer",
                        "Actual Loops": 1,
                        "Actual Rows": 20,
                        "Actual Total Time": 0.1,
                    }),
                    scan({
                        "Total Cost": 2,
                        "Parent Relationship": "Inner",
                        "Actual Loops": 20,
                        "Actual Rows": 1,
                        "Actual Total Time": 0.01,
                    }),
                ],
            }),
        );
        const [outer, repeated] = actual.root.children;
        expect(repeated.cost).toBeCloseTo(40, 9);
        expect(actual.root.cost).toBeCloseTo(10, 9);
        expect(outer.cost).toBeCloseTo(10, 9);
        expect(actual.root.cost + outer.cost + repeated.cost).toBeCloseTo(60, 9);
    });

    it("keeps a repeated subtree in one unit: the grandchildren of an inner side", () => {
        const run = (loops: number, total: number) => ({
            "Actual Loops": loops,
            "Actual Rows": 1,
            "Actual Total Time": 0.01,
            "Total Cost": total,
        });
        const [graph] = parseTop(
            doc({
                "Node Type": "Nested Loop",
                "Join Type": "Inner",
                "Plan Rows": 1,
                "Plan Width": 4,
                ...run(1, 5000),
                Plans: [
                    scan({ ...run(1, 1000), "Parent Relationship": "Outer" }),
                    {
                        ...scan({ ...run(1000, 4), "Parent Relationship": "Inner" }),
                        "Node Type": "Bitmap Heap Scan",
                        Plans: [
                            scan({
                                ...run(1000, 2),
                                "Node Type": "Bitmap Index Scan",
                                "Parent Relationship": "Outer",
                            }),
                        ],
                    },
                ],
            }),
        );
        const heap = graph.root.children[1];
        const index = heap.children[0];
        // 4000 for the heap scan and its child: 2000 each.
        expect(heap.subTreeCost).toBeCloseTo(4000, 6);
        expect(heap.cost).toBeCloseTo(2000, 6);
        expect(index.cost).toBeCloseTo(2000, 6);
    });

    it("counts parallel workers once in the elapsed time", () => {
        const [graph] = parseTop(
            doc({
                "Node Type": "Gather",
                "Total Cost": 100,
                "Plan Rows": 1,
                "Plan Width": 4,
                "Actual Loops": 1,
                "Actual Rows": 3,
                "Actual Total Time": 310,
                "Workers Planned": 2,
                "Workers Launched": 2,
                Plans: [
                    scan({
                        "Total Cost": 90,
                        "Parent Relationship": "Outer",
                        "Parallel Aware": true,
                        "Actual Loops": 3,
                        "Actual Rows": 1,
                        "Actual Total Time": 300,
                    }),
                ],
            }),
        );
        expect(graph.root.children[0].elapsedTimeInMs).toBeCloseTo(300, 6);
        expect(graph.root.elapsedTimeInMs).toBeCloseTo(10, 6);
        expect(graph.root.children[0].cost).toBeCloseTo(90, 6);
    });

    it("keeps a Gather that runs several times in the units of its executions", () => {
        const [graph] = parseTop(
            doc({
                "Node Type": "Gather",
                "Total Cost": 100,
                "Plan Rows": 1,
                "Plan Width": 4,
                "Actual Loops": 5,
                "Actual Rows": 3,
                "Actual Total Time": 10,
                Plans: [
                    scan({
                        "Total Cost": 90,
                        "Parent Relationship": "Outer",
                        "Actual Loops": 15,
                        "Actual Rows": 1,
                        "Actual Total Time": 9,
                    }),
                ],
            }),
        );
        // 5 executions of both: 100 x 5 = 500 for the Gather, 90 x 5 = 450 for its child.
        expect(graph.root.subTreeCost).toBeCloseTo(500, 6);
        expect(graph.root.children[0].cost).toBeCloseTo(450, 6);
        expect(graph.root.cost).toBeCloseTo(50, 6);
        expect(graph.root.elapsedTimeInMs).toBeCloseTo(5, 6);
    });

    it("does not subtract a CTE's subplan from the node that owns it", () => {
        const [graph] = parseTop(
            doc({
                "Node Type": "Hash Join",
                "Join Type": "Inner",
                "Total Cost": 100,
                "Plan Rows": 1,
                "Plan Width": 4,
                "Actual Loops": 1,
                "Actual Rows": 1,
                "Actual Total Time": 20,
                Plans: [
                    scan({
                        "Node Type": "CTE Scan",
                        "Total Cost": 50,
                        "Parent Relationship": "Outer",
                        "Actual Loops": 1,
                        "Actual Rows": 1,
                        "Actual Total Time": 18,
                    }),
                    scan({
                        "Total Cost": 40,
                        "Parent Relationship": "InitPlan",
                        "Subplan Name": "CTE s",
                        "Actual Loops": 1,
                        "Actual Rows": 1,
                        "Actual Total Time": 17,
                    }),
                ],
            }),
        );
        expect(graph.root.elapsedTimeInMs).toBeCloseTo(2, 6);
    });

    it("never divides by zero on a plan that costs nothing", () => {
        const [graph] = parseTop(
            doc({
                "Node Type": "Result",
                "Total Cost": 0,
                "Plan Rows": 1,
                "Plan Width": 0,
                Plans: [scan({ "Total Cost": 0 })],
            }),
        );
        for (const node of nodesOf(graph)) {
            expect(node.relativeCost).toBe(0);
            expect(node.cost).toBe(0);
            expect(node.costDisplayString).toBe("0%");
        }
    });

    it("tolerates missing, negative and non-numeric costs", () => {
        const [graph] = parseTop(
            doc({
                "Node Type": "Result",
                "Total Cost": -5,
                Plans: [scan({ "Total Cost": "free" }), scan({ "Total Cost": undefined })],
            }),
        );
        for (const node of nodesOf(graph)) {
            expect(node.cost).toBe(0);
            expect(node.relativeCost).toBe(0);
        }
    });
});

describe("actual plan details", () => {
    const actualScan = (extra: Record<string, unknown>) =>
        scan({
            "Actual Startup Time": 0.1,
            "Actual Total Time": 2,
            "Actual Rows": 100,
            "Actual Loops": 1,
            ...extra,
        });

    it("shows a node that never ran as such", () => {
        const [graph] = parseTop(
            doc({
                "Node Type": "Nested Loop",
                "Join Type": "Inner",
                "Total Cost": 100,
                "Plan Rows": 1,
                "Plan Width": 4,
                "Actual Total Time": 0.5,
                "Actual Rows": 0,
                "Actual Loops": 1,
                Plans: [
                    actualScan({ "Actual Rows": 0, "Parent Relationship": "Outer" }),
                    actualScan({
                        "Actual Rows": 0,
                        "Actual Loops": 0,
                        "Actual Total Time": 0,
                        "Parent Relationship": "Inner",
                    }),
                ],
            }),
        );
        const never = graph.root.children[1];
        expect(never.rowCountDisplayString).toBe(NEVER_EXECUTED);
        expect(never.elapsedTimeInMs).toBe(0);
        expect(never.edges).toEqual([]);
        expect(graph.root.edges[1].rowCount).toBe(0);
    });

    it("multiplies rows and time by the loops, and rounds the fractional rows of PostgreSQL 18", () => {
        const [graph] = parseTop(
            doc(actualScan({ "Actual Rows": 1.5, "Actual Loops": 3, "Actual Total Time": 4 })),
        );
        expect(graph.root.rowCountDisplayString).toBe("5");
        expect(graph.root.elapsedTimeInMs).toBeCloseTo(12, 9);
        expect(property(graph.root, "Actual Time for All Executions")!.value).toBe("12");
        expect(property(graph.root, "Estimated Number of Rows for All Executions")!.value).toBe(
            "300",
        );
    });

    it("warns when fewer workers than planned were launched", () => {
        const [graph] = parseTop(
            doc(
                actualScan({
                    "Node Type": "Gather",
                    "Workers Planned": 4,
                    "Workers Launched": 1,
                }),
            ),
        );
        // The warning is last: the page draws it over the parallelism badge.
        expect(graph.root.badges.map((b) => b.type)).toEqual([
            BadgeType.Parallelism,
            BadgeType.Warning,
        ]);
        expect(graph.root.badges[1].tooltip).toContain("Only 1 of 4 planned parallel workers");
    });

    it("warns about a row estimate that is far off, but not below a Limit", () => {
        const [off] = parseTop(doc(actualScan({ "Plan Rows": 1, "Actual Rows": 5000 })));
        expect(off.root.badges[0].type).toBe(BadgeType.Warning);
        expect(off.root.badges[0].tooltip).toContain("off by a factor of 5000");

        const small = actualScan({ "Plan Rows": 1, "Actual Rows": 50 });
        expect(parseTop(doc(small))[0].root.badges).toEqual([]);

        const over = actualScan({ "Plan Rows": 50000, "Actual Rows": 3 });
        expect(parseTop(doc(over))[0].root.badges[0].type).toBe(BadgeType.Warning);
        const [limited] = parseTop(
            doc({
                "Node Type": "Limit",
                "Total Cost": 10,
                "Plan Rows": 3,
                "Actual Rows": 3,
                "Actual Loops": 1,
                "Actual Total Time": 1,
                Plans: [{ ...over, "Parent Relationship": "Outer" }],
            }),
        );
        expect(limited.root.children[0].badges).toEqual([]);
    });

    it("warns about a spilled hash aggregate and a spilled worker sort", () => {
        const [agg] = parseTop(
            doc(actualScan({ "Node Type": "Aggregate", Strategy: "Hashed", "Disk Usage": 4096 })),
        );
        expect(agg.root.badges[0].tooltip).toContain("hash aggregate spilled to disk (4096 kB)");
        const [sort] = parseTop(
            doc(
                actualScan({
                    "Node Type": "Sort",
                    "Sort Method": "quicksort",
                    "Sort Space Type": "Memory",
                    Workers: [{ "Worker Number": 0, "Sort Space Type": "Disk" }],
                }),
            ),
        );
        expect(sort.root.badges[0].tooltip).toContain("spilled to disk");
    });
});

describe("parse", () => {
    it("reads plain EXPLAIN (FORMAT JSON) output saved by hand, and takes the statement from Query Text", () => {
        const plain = parseTop(doc(scan()));
        expect(plain[0].query).toBe("");
        const withText = parseTop(doc(scan(), { "Query Text": "SELECT * FROM t" }));
        expect(withText[0].query).toBe("SELECT * FROM t");
        expect(property(withText[0].statement, "Statement")!.value).toBe("SELECT * FROM t");
    });

    it("reads a single object and several plans", () => {
        expect(parseTop(JSON.stringify({ Plan: scan() }))).toHaveLength(1);
        const two = parseTop(JSON.stringify([{ Plan: scan() }, { Plan: scan() }]));
        expect(two.map((g) => g.graphFile.planIndexInFile)).toEqual([0, 1]);
    });

    it("ignores a byte order mark", () => {
        const bom = String.fromCharCode(0xfeff);
        expect(parseTop(bom + doc(scan()))).toHaveLength(1);
    });

    it("keeps keys it does not know as properties, after the known ones", () => {
        const [graph] = parseTop(doc(scan({ "Index Searches": 3, "Fancy Mode": "on" })));
        const names = graph.root.properties.map((p) => p.name);
        expect(names.slice(-2)).toEqual(["Index Searches", "Fancy Mode"]);
        expect(property(graph.root, "Index Searches")!.dataType).toBe(DataType.Number);
    });

    it("sorts properties by display order, node type first", () => {
        const [graph] = parseTop(doc(scan({ Filter: "(a > 1)", "Rows Removed by Filter": 4 })));
        const orders = graph.root.properties.map((p) => p.displayOrder);
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
        expect(graph.root.properties[0].name).toBe("Node Type");
        expect(property(graph.root, "Filter")).toMatchObject({
            positionAtBottom: true,
            showInTooltip: true,
        });
    });

    it.each([
        ["not JSON", "SELECT 1", /not valid JSON/],
        ["an empty array", "[]", /contains no plan/],
        ["a JSON object that is no plan", '{"a": 1}', /not a PostgreSQL plan/],
        ["an array of numbers", "[1, 2]", /not a PostgreSQL plan/],
        ["a showplan XML", "<ShowPlanXML/>", /not valid JSON/],
        ["a node that is not an object", '[{"Plan": {"Plans": [3]}}]', /could not be read/],
        ["plans that are not a list", '[{"Plan": {"Plans": 3}}]', /could not be read/],
    ])("rejects %s with a readable error", (_label, content, message) => {
        expect(() => parseTop(content)).toThrow(message);
    });

    it("is the parse function of the driver", () => {
        expect(pgDriver.executionPlan).toMatchObject({
            fileExtension: "json",
            documentLanguage: "json",
        });
    });
});

describe("actual-plan counters of the page", () => {
    const stats = (node: ExecutionPlanNode) => node.liveQueryStatistics;
    const timed = (extra: Record<string, unknown>) =>
        scan({
            "Actual Startup Time": 0.1,
            "Actual Total Time": 2,
            "Actual Rows": 100,
            "Actual Loops": 1,
            ...extra,
        });

    it("counts rows and time over the executions of a nested loop's inner side", () => {
        const [graph] = parsePgPlan(
            doc(
                {
                    "Node Type": "Nested Loop",
                    "Join Type": "Inner",
                    "Total Cost": 100,
                    "Plan Rows": 40,
                    "Plan Width": 8,
                    "Actual Rows": 30,
                    "Actual Loops": 1,
                    "Actual Total Time": 5.0004,
                    Plans: [
                        timed({
                            "Parent Relationship": "Outer",
                            "Plan Rows": 10,
                            "Actual Rows": 10,
                        }),
                        timed({
                            "Parent Relationship": "Inner",
                            "Plan Rows": 2,
                            "Actual Rows": 1.5,
                            "Actual Loops": 10,
                            "Actual Total Time": 0.2,
                        }),
                    ],
                },
                { "Execution Time": 6.5 },
            ),
        );
        const [join, outer, inner] = [
            graph.root.children[0],
            graph.root.children[0].children[0],
            graph.root.children[0].children[1],
        ];
        expect(stats(join)).toEqual({ actualRows: "30", estimatedRows: 40, elapsedTimeInMs: 5 });
        expect(stats(outer)).toEqual({ actualRows: "10", estimatedRows: 10, elapsedTimeInMs: 2 });
        // 1.5 rows x 10 loops against 2 estimated x 10; 0.2 ms x 10 loops, children included.
        expect(stats(inner)).toEqual({ actualRows: "15", estimatedRows: 20, elapsedTimeInMs: 2 });
        // The statement: its own Execution Time, the longest of all.
        expect(stats(graph.root)).toEqual({ elapsedTimeInMs: 6.5 });
        expect(graph.liveQueryStatistics).toEqual({ elapsedTimeInMs: 6.5 });
    });

    it("counts parallel workers once in the time, and their rows in the rows", () => {
        const [graph] = parsePgPlan(
            doc({
                "Node Type": "Gather",
                "Total Cost": 100,
                "Plan Rows": 90,
                "Plan Width": 4,
                "Actual Loops": 1,
                "Actual Rows": 90,
                "Actual Total Time": 310,
                "Workers Planned": 2,
                "Workers Launched": 2,
                Plans: [
                    timed({
                        "Total Cost": 90,
                        "Parent Relationship": "Outer",
                        "Parallel Aware": true,
                        // The planner divides 90 by the parallel divisor of 2 workers: 2.4.
                        "Plan Rows": 37.5,
                        "Actual Loops": 3,
                        "Actual Rows": 30,
                        "Actual Total Time": 300,
                    }),
                ],
            }),
        );
        const scanNode = graph.root.children[0].children[0];
        expect(stats(scanNode)).toEqual({
            actualRows: "90",
            estimatedRows: 90,
            elapsedTimeInMs: 300,
        });
        expect(stats(graph.root.children[0])).toEqual({
            actualRows: "90",
            estimatedRows: 90,
            elapsedTimeInMs: 310,
        });
        expect(graph.liveQueryStatistics).toEqual({ elapsedTimeInMs: 310 });
    });

    it("compares like with like under a Gather, on real captures", () => {
        for (const capture of CAPTURES) {
            for (const name of ["gather", "gather-merge", "parallel-hash-join"]) {
                const plan = capture.plans.find((p) => p.name === name && p.kind === "actual");
                if (!plan) continue;
                const [graph] = parsePgPlan(JSON.stringify(plan.plan));
                const inside = nodesOf(graph).filter((n) =>
                    n.badges.some((b) => b.type === BadgeType.Parallelism),
                );
                expect(inside.length).toBeGreaterThan(1);
                for (const node of inside) {
                    const s = node.liveQueryStatistics!;
                    if (Number(s.actualRows) < 1000) continue;
                    const ratio = Number(s.actualRows) / s.estimatedRows!;
                    expect(ratio, `${capture.image} ${name} ${node.name}`).toBeGreaterThan(0.6);
                    expect(ratio, `${capture.image} ${name} ${node.name}`).toBeLessThan(1.7);
                }
            }
        }
    });

    it("leaves the rows out of nodes PostgreSQL does not count rows for", () => {
        const [graph] = parsePgPlan(
            doc(timed({ "Node Type": "ModifyTable", Operation: "Insert", "Actual Rows": 0 })),
        );
        expect(stats(graph.root.children[0])).toEqual({ elapsedTimeInMs: 2 });
    });

    it("takes the longest operator when it outlasts the Execution Time, and knows no time without timing", () => {
        const [slow] = parsePgPlan(doc(timed({ "Actual Total Time": 9 }), { "Execution Time": 4 }));
        expect(slow.liveQueryStatistics).toEqual({ elapsedTimeInMs: 9 });
        const untimed = {
            ...timed({}),
            "Actual Total Time": undefined,
            "Actual Startup Time": undefined,
        };
        const [none] = parsePgPlan(doc(untimed));
        expect(none.liveQueryStatistics).toBeUndefined();
        expect(none.root).not.toHaveProperty("liveQueryStatistics");
        expect(stats(none.root.children[0])).toMatchObject({ actualRows: "100" });
        expect(stats(none.root.children[0])!.elapsedTimeInMs).toBeUndefined();
    });

    it("gives a node that never ran no counters, and the page renders none", () => {
        const [graph] = parsePgPlan(
            doc({
                "Node Type": "Nested Loop",
                "Join Type": "Inner",
                "Total Cost": 100,
                "Plan Rows": 1,
                "Plan Width": 4,
                "Actual Rows": 0,
                "Actual Loops": 1,
                "Actual Total Time": 0.5,
                Plans: [
                    timed({ "Parent Relationship": "Outer", "Actual Rows": 0 }),
                    timed({
                        "Parent Relationship": "Inner",
                        "Actual Rows": 0,
                        "Actual Loops": 0,
                        "Actual Total Time": 0,
                    }),
                ],
            }),
        );
        expect(stats(graph.root.children[0].children[1])).toEqual({});
        expect(graph.root.children[0].children[1].rowCountDisplayString).toBe("never executed");
    });

    it("has none on an estimated plan, which keeps the page's usual labels", () => {
        const [graph] = parsePgPlan(doc(scan()));
        expect(graph.liveQueryStatistics).toBeUndefined();
        for (const node of nodesOf(graph)) expect(node).not.toHaveProperty("liveQueryStatistics");
    });

    it("rounds the time to the microsecond", () => {
        const [graph] = parsePgPlan(
            doc(timed({ "Actual Total Time": 0.12345, "Actual Loops": 3 })),
        );
        expect(stats(graph.root.children[0])!.elapsedTimeInMs).toBe(0.37);
    });
});

describe("statement node", () => {
    const root = (sql: string | undefined) =>
        parsePgPlan(doc(scan(), sql === undefined ? {} : { "Query Text": sql }))[0].root;
    const RESULT = "result";

    it.each([
        ["SELECT 1", "SELECT", "result"],
        ["(SELECT 1) UNION (SELECT 2)", "SELECT", "result"],
        ["SELECT 1 INTO t", "SELECT", "result"],
        ["VALUES (1)", "VALUES", "result"],
        ["TABLE t", "TABLE", "result"],
        ["INSERT INTO t VALUES (1)", "INSERT", RESULT],
        ["update t set a = 1", "UPDATE", RESULT],
        ["DELETE FROM t", "DELETE", RESULT],
        ["MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE", "MERGE", RESULT],
        ["EXECUTE p(1)", "EXECUTE", RESULT],
        ["DECLARE c CURSOR FOR SELECT 1", "DECLARE", RESULT],
        ["CREATE TABLE t AS SELECT 1", "CREATE TABLE AS", RESULT],
        ["CREATE MATERIALIZED VIEW v AS SELECT 1", "CREATE MATERIALIZED VIEW", RESULT],
        ["-- c\nWITH x AS (SELECT 1) SELECT * FROM x", "SELECT", "result"],
        ["WITH RECURSIVE x(n) AS (SELECT 1) INSERT INTO t SELECT n FROM x", "INSERT", RESULT],
        ["WITH d AS (DELETE FROM t RETURNING *) UPDATE u SET a = 1", "UPDATE", RESULT],
        ["WITH x AS (SELECT 1) VALUES (2)", "VALUES", "result"],
        ["WITH x AS (SELECT 1) TABLE x", "TABLE", "result"],
        ["WITH x AS (SELECT 1) (SELECT * FROM x)", "SELECT", "result"],
        ["WITH update AS (SELECT 1) SELECT * FROM update", "SELECT", "result"],
        ["WITH x AS (SELECT 1), delete AS (SELECT 2) SELECT 1", "SELECT", "result"],
        ["WITH x(a, b) AS NOT MATERIALIZED (SELECT 1, 2) DELETE FROM t", "DELETE", RESULT],
        ["WITH x AS (SELECT 1", "Query", RESULT],
        ["WITH x (SELECT 1) SELECT 1", "Query", RESULT],
        [
            "CREATE TABLE t AS WITH x AS MATERIALIZED (SELECT 1) SELECT * FROM x",
            "CREATE TABLE AS",
            RESULT,
        ],
        ["CREATE TABLE t AS SELECT 1 AS materialized", "CREATE TABLE AS", RESULT],
        ["CREATE TABLE materialized AS SELECT 1", "CREATE TABLE AS", RESULT],
        ["CREATE UNLOGGED TABLE t AS SELECT 1", "CREATE TABLE AS", RESULT],
        ["", "Query", RESULT],
        ["SET x = 1", "Query", RESULT],
    ])("names the root after %j", (sql, name, type) => {
        expect(root(sql)).toMatchObject({ name, type, subtext: [name] });
    });

    it("never uses language_construct_catch_all, which is drawn as the text T-SQL", () => {
        // Every icon a node type can take, whatever its Strategy, Operation or conditions.
        const variants: Record<string, unknown>[] = [{}];
        for (const Strategy of ["Plain", "Sorted", "Hashed", "Mixed"]) variants.push({ Strategy });
        for (const Operation of ["Select", "Insert", "Update", "Delete", "Merge", "Other"]) {
            variants.push({ Operation });
        }
        variants.push({ "Index Cond": "(a = 1)" });
        for (const type of EXPLAIN_NODE_TYPES) {
            for (const variant of variants) {
                expect(iconFor({ "Node Type": type, ...variant })).not.toBe(
                    "language_construct_catch_all",
                );
            }
        }
        expect(iconFor({})).not.toBe("language_construct_catch_all");
        for (const sql of ["", "SET x = 1", "INSERT INTO t VALUES (1)", "CALL p()", "DO $$ $$"]) {
            expect(root(sql).type).toBe("result");
        }
    });

    it("is called Query when the document has no statement text", () => {
        expect(root(undefined).name).toBe("Query");
    });

    it("costs nothing, holds the plan and the whole-statement properties", () => {
        const [graph] = parsePgPlan(
            doc(scan({ "Total Cost": 25 }), {
                "Query Text": "SELECT * FROM t",
                "Planning Time": 0.5,
                "Execution Time": 3,
                Settings: { work_mem: "1MB" },
            }),
        );
        const { root } = graph;
        expect(root).toMatchObject({
            id: "0",
            cost: 0,
            relativeCost: 0,
            subTreeCost: 25,
            elapsedTimeInMs: 0,
            badges: [],
            costDisplayString: "0%",
        });
        expect(root.edges).toHaveLength(1);
        expect(root.edges[0]).toMatchObject({ rowCount: 100, rowSize: 8 });
        const top = root.children[0];
        expect(top.id).toBe("1");
        expect(top.relativeCost).toBeCloseTo(1, 9);
        expect(top.subTreeCost).toBe(25);
        expect(root.cost + root.subTreeCost).toBe(25);
        expect(root.properties.map((p) => p.name)).toEqual(
            expect.arrayContaining([
                "Node Type",
                "Planning Time",
                "Execution Time",
                "Settings",
                "Statement",
            ]),
        );
        expect(property(root, "Node Type")!.value).toBe("SELECT");
        expect(top.properties.map((p) => p.name)).not.toContain("Planning Time");
        expect(top.properties.map((p) => p.name)).not.toContain("Statement");
    });

    it("sizes a statement by the plan total, not by the top operator's own cost twice", () => {
        const [graph] = parsePgPlan(
            doc({
                "Node Type": "Aggregate",
                Strategy: "Plain",
                "Total Cost": 20000,
                "Plan Rows": 1,
                "Plan Width": 8,
                Plans: [scan({ "Total Cost": 17000 })],
            }),
        );
        // The top operator owns 3000 of the 20000: the page adds root.cost + root.subTreeCost.
        expect(graph.root.children[0].cost).toBe(3000);
        expect(graph.root.cost + graph.root.subTreeCost).toBe(20000);
    });

    it("has a zero total on a plan that costs nothing, without NaN", () => {
        const [graph] = parsePgPlan(doc(scan({ "Total Cost": 0 })));
        expect(graph.root.subTreeCost).toBe(0);
        expect(graph.root.relativeCost).toBe(0);
        expect(graph.root.children[0].relativeCost).toBe(0);
    });
});

describe("classifyStatement", () => {
    const type = (sql: string) => classifyStatement(sql).type;

    it.each([
        "SELECT 1",
        "select * from t",
        "  INSERT INTO t VALUES (1)",
        "UPDATE t SET a = 1",
        "DELETE FROM t",
        "MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE",
        "VALUES (1), (2)",
        "TABLE t",
        "EXECUTE p(1)",
        "DECLARE c CURSOR FOR SELECT 1",
        "WITH x AS (SELECT 1) SELECT * FROM x",
        "WITH d AS (DELETE FROM t RETURNING *) INSERT INTO u SELECT * FROM d",
        "(SELECT 1) UNION (SELECT 2)",
        "-- comment\nSELECT 1",
        "/* block /* nested */ */ SELECT 1",
        "CREATE TABLE t AS SELECT 1",
        "create temp table t as select 1",
        "CREATE UNLOGGED TABLE IF NOT EXISTS t (a) AS TABLE s",
        "CREATE GLOBAL TEMPORARY TABLE t AS VALUES (1)",
        "CREATE MATERIALIZED VIEW v AS SELECT 1",
        "CREATE MATERIALIZED VIEW IF NOT EXISTS v (a) WITH (fillfactor = 70) AS SELECT 1",
    ])("explains %j", (sql) => {
        expect(type(sql)).toBe("explainable");
    });

    it.each([
        ["CREATE TABLE t (a int)", "CREATE TABLE"],
        ["CREATE TABLE t (a int GENERATED ALWAYS AS (1) STORED)", "CREATE TABLE"],
        ["CREATE VIEW v AS SELECT 1", "CREATE VIEW"],
        ["CREATE INDEX i ON t (a)", "CREATE INDEX"],
        ["DROP TABLE t", "DROP TABLE"],
        ["ALTER TABLE t ADD c int", "ALTER TABLE"],
        ["SET search_path = x", "SET"],
        ["BEGIN", "BEGIN"],
        ["COMMIT", "COMMIT"],
        ["TRUNCATE t", "TRUNCATE"],
        ["COPY t TO STDOUT", "COPY"],
        ["PREPARE p AS SELECT 1", "PREPARE"],
        ["GRANT SELECT ON t TO u", "GRANT"],
        ["REFRESH MATERIALIZED VIEW v", "REFRESH"],
        ["DO $$ BEGIN PERFORM 1; END $$", "DO"],
        ["CALL p()", "CALL"],
        ["CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql", "CREATE FUNCTION"],
        ['"SELECT" 1', '"SELECT"'],
        ["", "empty statement"],
        ["-- only a comment", "empty statement"],
    ])("does not explain %j", (sql, label) => {
        expect(classifyStatement(sql)).toEqual({ type: "other", label });
    });

    it("knows which statements create a table and which declare a cursor", () => {
        expect(classifyStatement("SELECT 1 INTO t")).toMatchObject({ creates: true });
        expect(classifyStatement("SELECT (SELECT 1 INTO x)")).toMatchObject({ creates: false });
        expect(classifyStatement("INSERT INTO t VALUES (1)")).toMatchObject({ creates: false });
        expect(classifyStatement("CREATE TABLE t AS SELECT 1")).toMatchObject({ creates: true });
        expect(classifyStatement("DECLARE c CURSOR FOR SELECT 1")).toMatchObject({
            declare: true,
        });
    });

    it("is not fooled by SELECT in a string or a comment", () => {
        expect(type("/* SELECT */ SET x = 'SELECT'")).toBe("other");
        expect(type("DO $$ SELECT 1 $$")).toBe("other");
    });

    it("tells whether an EXPLAIN would run its statement", () => {
        const analyze = (sql: string) => {
            const c = classifyStatement(sql);
            return c.type === "explain" ? c.analyze : "not explain";
        };
        expect(analyze("EXPLAIN SELECT 1")).toBe(false);
        expect(analyze("explain analyze select 1")).toBe(true);
        expect(analyze("EXPLAIN ANALYSE VERBOSE SELECT 1")).toBe(true);
        expect(analyze("EXPLAIN VERBOSE SELECT 1")).toBe(false);
        expect(analyze("EXPLAIN (FORMAT JSON) SELECT 1")).toBe(false);
        expect(analyze("EXPLAIN (ANALYZE) SELECT 1")).toBe(true);
        expect(analyze("EXPLAIN (VERBOSE, ANALYZE, FORMAT TEXT) SELECT 1")).toBe(true);
        expect(analyze("EXPLAIN (ANALYZE true) SELECT 1")).toBe(true);
        expect(analyze("EXPLAIN (ANALYZE off) SELECT 1")).toBe(false);
        expect(analyze("EXPLAIN (ANALYZE false, VERBOSE) SELECT 1")).toBe(false);
        expect(analyze("EXPLAIN (ANALYZE 0) SELECT 1")).toBe(false);
        // Quoted option names and repeated options count as on: the server may run the statement.
        expect(analyze('EXPLAIN ("analyze") DELETE FROM t')).toBe(true);
        expect(analyze('EXPLAIN (U&"\\0061nalyze") DELETE FROM t')).toBe(true);
        expect(analyze("EXPLAIN (ANALYZE false, ANALYZE true) DELETE FROM t")).toBe(true);
        expect(analyze("EXPLAIN (ANALYZE true, ANALYZE false) DELETE FROM t")).toBe(true);
        expect(analyze("EXPLAIN (COSTS off) SELECT 'ANALYZE'")).toBe(false);
        expect(analyze("EXPLAIN (COSTS off) SELECT * FROM (SELECT 1) analyze")).toBe(false);
    });
});

describe("EXPLAIN options", () => {
    it("builds the prefix for each kind of plan and server version", () => {
        expect(explainPrefix("estimated", 17)).toBe("EXPLAIN (FORMAT JSON, VERBOSE, SETTINGS) ");
        expect(explainPrefix("actual", 17)).toBe(
            "EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, WAL, FORMAT JSON) ",
        );
        expect(explainPrefix("actual", 12)).toBe(
            "EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) ",
        );
        expect(explainPrefix("estimated", undefined)).toBe("EXPLAIN (FORMAT JSON, VERBOSE) ");
        expect(explainPrefix("actual", undefined)).toBe(
            "EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ",
        );
    });

    it("reads the major version", () => {
        expect(majorVersion("17.2")).toBe(17);
        expect(majorVersion("12.22 (Debian 12.22-1)")).toBe(12);
        expect(majorVersion("18beta1")).toBe(18);
        expect(majorVersion("unknown")).toBeUndefined();
    });
});
