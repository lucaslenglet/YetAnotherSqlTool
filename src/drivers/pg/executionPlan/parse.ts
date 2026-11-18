/**
 * PostgreSQL plan document -> the graphs of Microsoft's execution plan page.
 *
 * The document is what `EXPLAIN (FORMAT JSON)` returns: an array with one object per statement,
 * each with a "Plan" tree, and for an actual plan "Planning Time", "Execution Time", "Triggers"...
 * The converter of `executeForPlan` adds the statement under "Query Text" (the key `auto_explain`
 * uses in its JSON logs). A plain EXPLAIN output saved by hand, without it, is read as well.
 *
 * What the page gets, and how it is worked out
 *
 * - The root is a statement node (SELECT, INSERT...; "Query" when the statement is unknown), as in
 *   SQL Server's plans: no cost of its own, the plan below it, and the properties of the whole
 *   statement (planning and execution time, settings, JIT, triggers, statement text).
 * - Below it, one node per plan node. `name` is the node type as PostgreSQL writes it, then the object (and
 *   for InitPlans, SubPlans and CTEs their relationship) on the next lines; `type` is the icon
 *   (operators.ts).
 * - Costs. A node's "Total Cost" includes its children, and PostgreSQL does not make a parent
 *   cost at least the sum of its children: under a Limit, or an EXISTS-like subplan, a child can
 *   cost more than the node that stops reading it. So costs are *attributed* top-down, starting
 *   from the top operator's Total Cost (the statement node below which it hangs has none) as its budget:
 *     - the budget of a node is its `subTreeCost`;
 *     - when the children's Total Costs add up to no more than the budget, the node's own `cost`
 *       is the rest (budget - children), and each child gets its own Total Cost as budget;
 *     - when they add up to more, the node's own cost is 0 and each child gets its Total Cost
 *       scaled by budget / sum, so that the subtree still costs what the node said it does.
 *   Hence the costs of all nodes add up to the top operator's Total Cost, `relativeCost` is `cost` over
 *   that total (the percentages add up to 100%, none is negative), and `subTreeCost` is the
 *   budget. When the total is 0 (a plan of free nodes) every relative cost is 0, not NaN. The
 *   server's own numbers stay available as properties ("Startup Cost", "Total Cost").
 *   PostgreSQL costs the inner side of a nested loop (and a SubPlan) per execution. An estimated
 *   plan does not say how often it runs, so the loop node gets the cost of the repetitions; in an
 *   actual plan a node counts once per execution: its Total Cost times its "Actual Loops" (so a
 *   whole subtree below a repeated node is in the same units), and a node that never ran costs
 *   nothing. Parallel workers count once: below a Gather the loops are divided by the workers'.
 * - Rows. Estimated plan: "Plan Rows". Actual plan: "Actual Rows" times "Actual Loops" (a node
 *   that never ran shows "never executed"). `elapsedTimeInMs` is the time of the node itself:
 *   "Actual Total Time" times its executions (workers counted once, so it is close to wall-clock
 *   time), minus that of its children (which PostgreSQL includes).
 *   Edges carry the child's rows and "Plan Width" (bytes per row).
 * - Actual plans carry `liveQueryStatistics` (the page's "Rows: 3 of 3 (100%)" and "Elapsed"
 *   lines) on every operator, the statement node and the graph: see `liveStatistics`.
 * - Badges: parallelism on a Gather / Gather Merge and everything below it; one warning badge
 *   for the run-time problems of `nodeWarnings`.
 */

import {
    BadgeType,
    type ExecutionPlanBadge,
    type ExecutionPlanEdge,
    type ExecutionPlanGraph,
    type ExecutionPlanNode,
} from "../../../sharedInterfaces/executionPlan";
import {
    descriptionFor,
    iconFor,
    logicalOperation,
    operatorName,
    type NodeJson,
} from "./operators";
import { statementKind } from "./explain";
import { buildEdgeProperties, buildNodeProperties } from "./properties";

/** An actual plan is flagged when the planner's row estimate is off by at least this factor... */
export const ESTIMATE_RATIO_WARNING = 100;
/** ...and the larger of the two row counts is at least this (a 1 against 100 is not a problem). */
export const ESTIMATE_MIN_ROWS_WARNING = 1000;

export const PARALLEL_TOOLTIP = "Parallel Execution";
export const WARNINGS_TOOLTIP = "Warnings";
export const NEVER_EXECUTED = "never executed";

const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export function parsePgPlan(content: string): ExecutionPlanGraph[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
    } catch (error) {
        throw new Error(
            `This is not a PostgreSQL plan: the file is not valid JSON (${(error as Error).message}). ` +
                "Expected the output of EXPLAIN (FORMAT JSON).",
        );
    }
    const documents = Array.isArray(parsed) ? parsed : [parsed];
    if (documents.length === 0) throw new Error("This PostgreSQL plan document contains no plan.");
    return documents.map((document, index) => {
        if (!isObject(document) || !isObject(document.Plan)) {
            throw new Error(
                "This is not a PostgreSQL plan: expected the output of EXPLAIN (FORMAT JSON), " +
                    'an array of objects with a "Plan" key.',
            );
        }
        try {
            return buildGraph(document, index, content);
        } catch (error) {
            throw new Error(`The PostgreSQL plan could not be read: ${(error as Error).message}`);
        }
    });
}

interface Draft {
    json: NodeJson;
    id: string;
    children: Draft[];
    parallel: boolean;
    /** An ancestor stops reading this node's rows before the end: fewer rows than planned is normal. */
    mayStopEarly: boolean;
    cost: number;
    subTreeCost: number;
    /** See assignExecutions. */
    executions: number;
    /**
     * Below a Gather: the workers of the Gather, and whether this node's "Plan Rows" are those of
     * one process of a parallel plan (divided by the parallel divisor) rather than of the whole.
     */
    workers?: { planned: number; launched: number; partial: boolean };
}

function buildGraph(
    document: Record<string, unknown>,
    index: number,
    content: string,
): ExecutionPlanGraph {
    // "0" is the statement node.
    let nextId = 1;
    const draft = (
        json: unknown,
        parentParallel: boolean,
        parentStops: boolean,
        relationship: string | undefined,
    ): Draft => {
        if (!isObject(json)) throw new Error("a plan node is not an object");
        const type = str(json["Node Type"]);
        const parallel = parentParallel || type === "Gather" || type === "Gather Merge";
        const stops =
            parentStops ||
            relationship === "InitPlan" ||
            relationship === "SubPlan" ||
            type === "Limit" ||
            type === "Merge Join" ||
            ["Semi", "Anti", "Right Semi", "Right Anti"].includes(str(json["Join Type"]) ?? "");
        const result: Draft = {
            json,
            id: String(nextId++),
            children: [],
            parallel,
            mayStopEarly: parentStops || relationship === "InitPlan" || relationship === "SubPlan",
            cost: 0,
            subTreeCost: 0,
            executions: 1,
        };
        const plans = json.Plans;
        if (plans !== undefined && !Array.isArray(plans)) throw new Error('"Plans" is not a list');
        result.children = ((plans ?? []) as unknown[]).map((child) =>
            draft(
                child,
                parallel,
                stops,
                isObject(child) ? str(child["Parent Relationship"]) : undefined,
            ),
        );
        return result;
    };
    const rootDraft = draft(document.Plan, false, false, undefined);
    assignExecutions(rootDraft, undefined);
    markPartial(rootDraft, undefined);
    const rootBudget = absoluteCostOf(rootDraft);
    attributeCosts(rootDraft, rootBudget);

    const statement = Object.fromEntries(
        Object.entries(document).filter(([key]) => key !== "Plan"),
    );
    const nodeCount = countNodes(rootDraft) + 1;
    const top = toNode(rootDraft, rootBudget, nodeCount, undefined);
    const queryElapsed = actualStatementElapsed(rootDraft, num(document["Execution Time"]));
    return {
        root: {
            ...statementNode(
                top,
                rootDraft.json,
                rootBudget,
                str(document["Query Text"]),
                statement,
            ),
            ...(queryElapsed === undefined
                ? {}
                : { liveQueryStatistics: { elapsedTimeInMs: queryElapsed } }),
        },
        query: str(document["Query Text"]) ?? "",
        graphFile: {
            graphFileContent: content,
            graphFileType: "json",
            planIndexInFile: index,
        },
        recommendations: [],
        ...(queryElapsed === undefined
            ? {}
            : { liveQueryStatistics: { elapsedTimeInMs: queryElapsed } }),
    };
}

const roundMs = (ms: number): number => Math.round(ms * 1000) / 1000;

/**
 * The counters the page shows under each operator of an actual plan ("Rows: 3 of 3 (100%)",
 * "Elapsed: 0.012 s"), in the shape of what vscode-mssql's addExecutionPlanStatistics adds to
 * SQL Server graphs.
 * - `actualRows`: the rows shown on the edge, "Actual Rows" x "Actual Loops", as digits.
 * - `estimatedRows`: "Plan Rows" x the same "Actual Loops", the planner's per-execution estimate
 *   over the executions that happened, so the percentage compares like with like (SQL Server's is
 *   EstimateRows x (1 + rebinds + rewinds)). In a parallel plan the "Plan Rows" of a partial node
 *   are those of one process: the whole divided by the parallel divisor (the workers planned, plus
 *   the leader's share, 1 - 0.3 x workers while that is positive), whereas its loops count the
 *   processes: it is "Plan Rows" x divisor x the loops each process ran.
 *   Left out (the page shows no rows line) for nodes whose "Actual Rows" PostgreSQL does not
 *   count as rows: ModifyTable (0 without RETURNING) and BitmapAnd / BitmapOr (always 0).
 * - `elapsedTimeInMs`: SQL Server's ActualElapsedms includes the operator's children, so this is
 *   the inclusive time too: "Actual Total Time" x executions (workers counted once), to the
 *   microsecond, which is what the page displays.
 * A node that never ran has none of them: the page then shows neither line, and the edge says
 * "never executed". An estimated plan has no such object at all.
 */
function liveStatistics(draft: Draft): ExecutionPlanNode["liveQueryStatistics"] {
    const loops = num(draft.json["Actual Loops"]);
    if (loops === undefined) return undefined;
    if (loops === 0) return {};
    const type = str(draft.json["Node Type"]);
    const countsRows = type !== "ModifyTable" && type !== "BitmapAnd" && type !== "BitmapOr";
    const rows = countsRows ? actualRowsOf(draft.json) : undefined;
    const planRows = num(draft.json["Plan Rows"]);
    const elapsed = elapsedTime(draft);
    let estimatedRows: number | undefined;
    if (countsRows && planRows !== undefined) {
        const workers = draft.workers;
        if (workers?.partial) {
            // Parallel divisor of the planner (get_parallel_divisor), leader participating.
            const divisor = workers.planned + Math.max(0, 1 - 0.3 * workers.planned);
            const perProcess = loops / (workers.launched + 1);
            estimatedRows = planRows * divisor * Math.max(perProcess, 1);
        } else {
            estimatedRows = planRows * loops;
        }
    }
    return {
        actualRows: rows === undefined ? undefined : BigInt(rows).toString(),
        estimatedRows,
        elapsedTimeInMs: elapsed === undefined ? undefined : roundMs(elapsed),
    };
}

/**
 * Marks the nodes below a Gather whose "Plan Rows" are per process: parallel-aware nodes, and
 * those that process the rows of such a node (not the inner side of a join, an InitPlan or a
 * SubPlan, which every process runs in full).
 */
function markPartial(
    draft: Draft,
    gather: { planned: number; launched: number } | undefined,
): void {
    let workers = gather;
    if (isGather(draft)) {
        workers = {
            planned: num(draft.json["Workers Planned"]) ?? 0,
            launched: num(draft.json["Workers Launched"]) ?? 0,
        };
    }
    for (const child of draft.children) markPartial(child, workers);
    if (!workers || isGather(draft)) return;
    const flows = (child: Draft) => {
        const relationship = str(child.json["Parent Relationship"]);
        return (
            child.workers?.partial === true &&
            relationship !== "Inner" &&
            relationship !== "InitPlan" &&
            relationship !== "SubPlan"
        );
    };
    draft.workers = {
        ...workers,
        partial: draft.json["Parallel Aware"] === true || draft.children.some(flows),
    };
}

/**
 * Elapsed time of the statement of an actual plan, as SQL Server's: the larger of the query's
 * own time ("Execution Time") and the longest operator. Undefined for an estimated plan.
 */
function actualStatementElapsed(
    root: Draft,
    executionTime: number | undefined,
): number | undefined {
    if (num(root.json["Actual Loops"]) === undefined) return undefined;
    // No "Execution Time" and no operator time (TIMING OFF, auto_explain without timing): unknown.
    let longest = executionTime;
    const visit = (draft: Draft) => {
        const time = elapsedTime(draft);
        if (time !== undefined) longest = Math.max(longest ?? 0, time);
        draft.children.forEach(visit);
    };
    visit(root);
    if (longest === undefined) return undefined;
    return roundMs(longest);
}

/**
 * The root of every graph, like the SELECT / INSERT node of SQL Server's plans: it costs nothing
 * of its own (the page adds `root.cost + root.subTreeCost` to size a statement against the
 * script, which only works if the root's own cost is not already inside its subtree cost), its
 * subtree is the plan, and it holds what belongs to the whole statement: planning and execution
 * time, settings, JIT, triggers, the statement text.
 */
function statementNode(
    top: ExecutionPlanNode,
    topJson: NodeJson,
    totalCost: number,
    queryText: string | undefined,
    statement: Record<string, unknown>,
): ExecutionPlanNode {
    const kind = statementKind(queryText ?? "");
    return {
        id: "0",
        type: kind.icon,
        cost: 0,
        subTreeCost: totalCost,
        relativeCost: 0,
        elapsedTimeInMs: 0,
        elapsedCpuTimeInMs: 0,
        properties: buildNodeProperties({ "Node Type": kind.name }, { warnings: [], statement }),
        name: kind.name,
        description: "",
        subtext: [kind.name],
        children: [top],
        edges: [
            {
                rowCount: rowsOf(topJson) ?? 0,
                rowSize: num(topJson["Plan Width"]) ?? 0,
                properties: buildEdgeProperties(topJson, actualRowsOf(topJson)),
            },
        ],
        badges: [],
        rowCountDisplayString: "",
        costDisplayString: "0%",
        costMetrics: [],
    };
}

const countNodes = (draft: Draft): number =>
    1 + draft.children.reduce((sum, child) => sum + countNodes(child), 0);

const isGather = (draft: Draft): boolean => {
    const type = str(draft.json["Node Type"]);
    return type === "Gather" || type === "Gather Merge";
};

/**
 * How many times a node ran, counting a Gather's workers as one: its "Actual Loops", except below
 * a Gather, where the loops are divided by those of the Gather's child (the workers, whose time
 * and cost PostgreSQL already reports per process). 1 in an estimated plan, which knows no run
 * counts; 0 for a node that never ran.
 */
function assignExecutions(draft: Draft, parent: Draft | undefined, workerLoops?: number): void {
    const loops = num(draft.json["Actual Loops"]);
    let base = workerLoops;
    if (loops === undefined) {
        draft.executions = 1;
    } else if (parent && isGather(parent)) {
        // The Gather may run several times (inner side of a loop): its child runs as often.
        base = parent.executions > 0 && loops > 0 ? loops / parent.executions : 1;
        draft.executions = loops === 0 ? 0 : parent.executions;
    } else {
        draft.executions = base ? loops / base : loops;
    }
    for (const child of draft.children) assignExecutions(child, draft, base);
}

/** Cost of a node and everything below it over all its executions (never negative or NaN). */
const absoluteCostOf = (draft: Draft): number =>
    Math.max(0, num(draft.json["Total Cost"]) ?? 0) * draft.executions;

/** See "Costs" in the header of this file. */
function attributeCosts(draft: Draft, budget: number): void {
    const childTotals = draft.children.map(absoluteCostOf);
    const sum = childTotals.reduce((a, b) => a + b, 0);
    draft.subTreeCost = budget;
    if (budget >= sum) {
        draft.cost = budget - sum;
        draft.children.forEach((child, i) => attributeCosts(child, childTotals[i]));
    } else {
        draft.cost = 0;
        const scale = budget / sum;
        draft.children.forEach((child, i) => attributeCosts(child, childTotals[i] * scale));
    }
}

/** Time of all executions of a node, children included, in ms (loops added up). */
function inclusiveTime(json: NodeJson): number | undefined {
    const time = num(json["Actual Total Time"]);
    const loops = num(json["Actual Loops"]);
    return time === undefined || loops === undefined ? undefined : time * loops;
}

/** Like inclusiveTime, but parallel workers count once (see assignExecutions): wall-clock-like. */
function elapsedTime(draft: Draft): number | undefined {
    const time = num(draft.json["Actual Total Time"]);
    return time === undefined || num(draft.json["Actual Loops"]) === undefined
        ? undefined
        : time * draft.executions;
}

/** Rows of all executions, rounded (PostgreSQL 18 reports fractions of a row per loop). */
function actualRowsOf(json: NodeJson): number | undefined {
    const rows = num(json["Actual Rows"]);
    const loops = num(json["Actual Loops"]);
    return rows === undefined || loops === undefined ? undefined : Math.round(rows * loops);
}

function toNode(
    draft: Draft,
    rootBudget: number,
    nodeCount: number,
    statement: Record<string, unknown> | undefined,
): ExecutionPlanNode {
    const { json } = draft;
    const loops = num(json["Actual Loops"]);
    const actual = loops !== undefined;
    const rows = actualRowsOf(json);
    const planRows = num(json["Plan Rows"]);

    // A CTE's subplan is listed under the node that owns the WITH, but runs lazily inside the
    // CTE Scan that reads it, whose time includes it: it is not subtracted from the owner.
    const childrenTime = draft.children
        .filter((c) => !/^CTE /.test(str(c.json["Subplan Name"]) ?? ""))
        .reduce((sum, c) => sum + (elapsedTime(c) ?? 0), 0);
    const nodeTime = elapsedTime(draft);
    const elapsed = nodeTime === undefined ? 0 : Math.max(0, nodeTime - childrenTime);
    const ownTime = inclusiveTime(json);

    const warnings = nodeWarnings(json, draft.mayStopEarly);
    // The page draws every badge of a node at the same place, the last one on top. Below a Gather
    // every node is parallel, so the warning comes last: it must not hide behind the parallelism
    // badge (sqltoolsservice has the other order, and a SQL Server warning does hide there).
    const badges: ExecutionPlanBadge[] = [];
    if (draft.parallel) badges.push({ type: BadgeType.Parallelism, tooltip: PARALLEL_TOOLTIP });
    if (warnings.length > 0) {
        badges.push({
            type: BadgeType.Warning,
            tooltip: `${WARNINGS_TOOLTIP}\n${warnings.join("\n")}`,
        });
    }

    const relativeCost = rootBudget > 0 ? draft.cost / rootBudget : 0;
    const percent = relativeCost * 100;
    // Like SSMS: whole percentages in a small plan, two decimals in a large one.
    const costDisplayString = `${nodeCount < 100 ? Math.round(percent) : parseFloat(percent.toFixed(2))}%`;

    const name = nodeLabelLines(json).join("\n");
    const costMetrics: ExecutionPlanNode["costMetrics"] = [];
    if (rows !== undefined) costMetrics.push({ name: "ActualRows", value: rows });
    if (planRows !== undefined) {
        costMetrics.push({
            name: "EstimateRowsAllExecs",
            value: Math.round(planRows * (loops ?? 1)),
        });
    }
    const rowsRead = actualRowsRead(json);
    if (rowsRead !== undefined) costMetrics.push({ name: "ActualRowsRead", value: rowsRead });

    return {
        id: draft.id,
        type: iconFor(json),
        cost: draft.cost,
        subTreeCost: draft.subTreeCost,
        relativeCost,
        elapsedTimeInMs: elapsed,
        elapsedCpuTimeInMs: 0,
        properties: buildNodeProperties(json, {
            actual: actual ? { loops, rows: rows ?? 0, time: ownTime } : undefined,
            warnings,
            statement,
        }),
        name,
        description: descriptionFor(json),
        subtext: name.split("\n"),
        children: draft.children.map((child) => toNode(child, rootBudget, nodeCount, undefined)),
        edges: draft.children.map((child): ExecutionPlanEdge => ({
            rowCount: rowsOf(child.json) ?? 0,
            rowSize: num(child.json["Plan Width"]) ?? 0,
            properties: buildEdgeProperties(child.json, actualRowsOf(child.json)),
        })),
        badges,
        rowCountDisplayString: rowCountDisplayString(json),
        costDisplayString,
        costMetrics,
        ...(actual ? { liveQueryStatistics: liveStatistics(draft) } : {}),
    };
}

/** Rows a node returned (actual plan) or is expected to return (estimated plan). */
function rowsOf(json: NodeJson): number | undefined {
    const planRows = num(json["Plan Rows"]);
    return actualRowsOf(json) ?? (planRows === undefined ? undefined : Math.round(planRows));
}

function rowCountDisplayString(json: NodeJson): string {
    if (num(json["Actual Loops"]) === 0) return NEVER_EXECUTED;
    const rows = rowsOf(json);
    return rows === undefined ? "" : String(rows);
}

/** Rows a scan read: those it returned plus those a filter removed, over all executions. */
function actualRowsRead(json: NodeJson): number | undefined {
    const returned = actualRowsOf(json);
    const loops = num(json["Actual Loops"]);
    if (returned === undefined || loops === undefined) return undefined;
    const removed = [
        "Rows Removed by Filter",
        "Rows Removed by Index Recheck",
        "Rows Removed by Join Filter",
    ].map((key) => num(json[key]));
    if (removed.every((r) => r === undefined)) return undefined;
    return returned + Math.round(removed.reduce<number>((sum, r) => sum + (r ?? 0), 0) * loops);
}

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

/**
 * The lines of a node's label: the operator, then the object it works on or (for a join) its
 * logical operation in parentheses, then the InitPlan / SubPlan / CTE the node is the root of.
 */
export function nodeLabelLines(json: NodeJson): string[] {
    const lines = [operatorName(json)];
    const object = objectLine(json) ?? logicalOperation(json);
    if (object) lines.push(object);
    const relationship = str(json["Parent Relationship"]);
    const subplan =
        str(json["Subplan Name"]) ??
        (relationship === "InitPlan" || relationship === "SubPlan" ? relationship : undefined);
    if (subplan) lines.push(subplan);
    return lines;
}

function objectLine(json: NodeJson): string | undefined {
    const relation = str(json["Relation Name"]);
    const schema = str(json.Schema);
    const alias = str(json.Alias);
    const index = str(json["Index Name"]);
    const cte = str(json["CTE Name"]);
    const fn = str(json["Function Name"]);
    // The alias only shows when it differs from the name.
    const withAlias = (text: string, name: string) =>
        alias && alias !== name ? `${text} ${alias}` : text;
    if (relation) {
        const qualified = withAlias(schema ? `${schema}.${relation}` : relation, relation);
        return index ? `${index} on ${qualified}` : qualified;
    }
    if (index) return index;
    if (cte) return withAlias(`CTE ${cte}`, cte);
    if (fn) return withAlias(fn, fn);
    return alias ?? str(json["Custom Plan Provider"]);
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** True when a sort node, or one of its workers or group summaries, wrote its rows to disk. */
function sortSpilled(json: Record<string, unknown>): boolean {
    const spilled = (o: Record<string, unknown>): boolean => {
        const methods = Array.isArray(o["Sort Methods Used"]) ? o["Sort Methods Used"] : [];
        return (
            o["Sort Space Type"] === "Disk" ||
            /^external/.test(str(o["Sort Method"]) ?? "") ||
            methods.some((m) => /^external/.test(String(m))) ||
            [o["Full-sort Groups"], o["Pre-sorted Groups"]].some(
                (group) => isObject(group) && spilled(group),
            )
        );
    };
    const workers = Array.isArray(json.Workers) ? json.Workers.filter(isObject) : [];
    return spilled(json) || workers.some(spilled);
}

/**
 * Run-time problems stated from the numbers of an actual plan; an estimated plan has none.
 * - a sort that spilled to disk ("Sort Space Type" is "Disk", or an external sort method);
 * - a Hash with more than one batch, or a hash aggregate that used disk: the hash table did not
 *   fit in work_mem and was split into temporary files;
 * - parallel workers launched fewer than planned;
 * - a row estimate off by at least ESTIMATE_RATIO_WARNING (when the larger count is at least
 *   ESTIMATE_MIN_ROWS_WARNING), over all executions. Returning fewer rows than planned is
 *   expected below a Limit, a merge join, a semi or anti join or an EXISTS subplan, which stop
 *   reading early, so only an underestimate is reported there.
 */
export function nodeWarnings(json: NodeJson, mayStopEarly: boolean): string[] {
    const loops = num(json["Actual Loops"]);
    if (loops === undefined) return [];
    const warnings: string[] = [];

    if (sortSpilled(json)) {
        const space = num(json["Sort Space Used"]);
        warnings.push(
            `The sort did not fit in memory and spilled to disk${space === undefined ? "" : ` (${space} kB)`}.`,
        );
    }
    const type = str(json["Node Type"]);
    const batches = num(json["Hash Batches"]);
    if (type === "Hash" && batches !== undefined && batches > 1) {
        warnings.push(
            `The hash table did not fit in memory: it was split into ${batches} batches, written to temporary files.`,
        );
    }
    const diskUsage = num(json["Disk Usage"]);
    if (type === "Aggregate" && diskUsage !== undefined && diskUsage > 0) {
        warnings.push(`The hash aggregate spilled to disk (${diskUsage} kB).`);
    }
    const planned = num(json["Workers Planned"]);
    const launched = num(json["Workers Launched"]);
    if (planned !== undefined && launched !== undefined && launched < planned) {
        warnings.push(`Only ${launched} of ${planned} planned parallel workers were launched.`);
    }
    const planRows = num(json["Plan Rows"]);
    const rows = num(json["Actual Rows"]);
    if (loops > 0 && planRows !== undefined && rows !== undefined) {
        const estimated = planRows * loops;
        const actual = rows * loops;
        const larger = Math.max(estimated, actual);
        const ratio = larger / Math.max(Math.min(estimated, actual), 1);
        const underestimated = actual > estimated;
        if (
            ratio >= ESTIMATE_RATIO_WARNING &&
            larger >= ESTIMATE_MIN_ROWS_WARNING &&
            (underestimated || !mayStopEarly)
        ) {
            warnings.push(
                `The row estimate is off by a factor of ${Math.round(ratio)}: ` +
                    `${Math.round(estimated)} rows expected, ${Math.round(actual)} returned.`,
            );
        }
    }
    return warnings;
}
