/**
 * The properties of a plan node as the page lists them (properties pane, tooltip, "find node"):
 * every key of the EXPLAIN node, in a stable order, with the data type and the "better value"
 * hint of the ones we know, and a few computed ones.
 *
 * Display orders (the page sorts by them; it adds "Operator Cost" at 3 and "Subtree Cost" at 8):
 *   0 node type, 0.5 warnings, 1.x kind of operation, 2.x object, 4.x actual counters,
 *   5.x estimates, 6.x run-time details, 9.x costs, 10.x conditions and lists, 11.x buffers,
 *   12.x WAL, 20.x whole-statement properties (root only), 100+ keys we do not know (newer servers).
 */

import {
    ExecutionPlanGraphElementPropertyBetterValue as Better,
    ExecutionPlanGraphElementPropertyDataType as DataType,
    type ExecutionPlanGraphElementProperty,
} from "../../../sharedInterfaces/executionPlan";

interface PropertyDef {
    /** Name shown instead of the key. */
    name?: string;
    order: number;
    tooltip?: boolean;
    /** Long text (conditions, lists): shown below the others in the tooltip. */
    bottom?: boolean;
    better?: Better;
    /** Appended to the displayed number. */
    unit?: string;
}

const LOWER = Better.LowerNumber;
const HIGHER = Better.HigherNumber;

/** Keys that become the label, the children or the badges rather than properties of their own. */
const STRUCTURAL_KEYS = new Set(["Plans"]);

const KNOWN: Readonly<Record<string, PropertyDef>> = {
    "Node Type": { order: 0, tooltip: true },

    Operation: { order: 1.1, tooltip: true },
    Strategy: { order: 1.2, tooltip: true },
    "Partial Mode": { order: 1.3 },
    "Join Type": { order: 1.4, tooltip: true },
    "Inner Unique": { order: 1.5 },
    Command: { order: 1.6, tooltip: true },
    "Parent Relationship": { order: 1.7 },
    "Subplan Name": { order: 1.8, tooltip: true },
    "Scan Direction": { order: 1.9 },
    "Parallel Aware": { order: 1.91 },
    "Async Capable": { order: 1.92 },
    "Single Copy": { order: 1.93 },
    "Workers Planned": { order: 1.94, tooltip: true },
    "Workers Launched": { order: 1.95, tooltip: true, better: HIGHER },
    "Subplans Removed": { order: 1.96 },
    Disabled: { order: 1.97, tooltip: true },
    "Disabled Nodes": { order: 1.97, tooltip: true, better: LOWER },

    Schema: { order: 2.1 },
    "Relation Name": { order: 2.2, tooltip: true },
    Alias: { order: 2.3 },
    "Index Name": { order: 2.4, tooltip: true },
    "CTE Name": { order: 2.5, tooltip: true },
    "Function Name": { order: 2.6, tooltip: true },
    "Sampling Method": { order: 2.7 },
    "Sampling Parameters": { order: 2.8 },
    "Custom Plan Provider": { order: 2.9 },

    // Computed: see buildNodeProperties.
    "Actual Number of Rows for All Executions": { order: 4.1, tooltip: true },
    "Actual Rows": { order: 4.2 },
    "Actual Loops": { order: 4.3, tooltip: true, better: LOWER },
    "Actual Startup Time": { order: 4.4, unit: " ms", better: LOWER },
    "Actual Total Time": { order: 4.5, tooltip: true, unit: " ms", better: LOWER },
    "Actual Time for All Executions": { order: 4.6, unit: " ms", better: LOWER },

    "Estimated Number of Rows for All Executions": { order: 5.1 },
    "Plan Rows": { order: 5.2, tooltip: true },
    "Plan Width": { order: 5.3, tooltip: true, unit: " B" },

    "Heap Fetches": { order: 6.1, tooltip: true, better: LOWER },
    "Rows Removed by Filter": { order: 6.2, tooltip: true, better: LOWER },
    "Rows Removed by Index Recheck": { order: 6.3, better: LOWER },
    "Rows Removed by Join Filter": { order: 6.4, tooltip: true, better: LOWER },
    "Exact Heap Blocks": { order: 6.5 },
    "Lossy Heap Blocks": { order: 6.6, better: LOWER },
    "Sort Method": { order: 6.7, tooltip: true },
    "Sort Space Used": { order: 6.71, tooltip: true, unit: " kB", better: LOWER },
    "Sort Space Type": { order: 6.72, tooltip: true },
    "Presorted Key": { order: 6.73 },
    "Full-sort Groups": { order: 6.74 },
    "Pre-sorted Groups": { order: 6.75 },
    "Hash Buckets": { order: 6.8 },
    "Original Hash Buckets": { order: 6.81 },
    "Hash Batches": { order: 6.82, tooltip: true, better: LOWER },
    "Original Hash Batches": { order: 6.83 },
    "Peak Memory Usage": { order: 6.84, tooltip: true, unit: " kB", better: LOWER },
    "HashAgg Batches": { order: 6.85, better: LOWER },
    "Planned Partitions": { order: 6.86 },
    "Disk Usage": { order: 6.87, tooltip: true, unit: " kB", better: LOWER },
    "Cache Mode": { order: 6.9 },
    "Cache Hits": { order: 6.91, better: HIGHER },
    "Cache Misses": { order: 6.92, better: LOWER },
    "Cache Evictions": { order: 6.93, better: LOWER },
    "Cache Overflows": { order: 6.94, better: LOWER },
    "Tuples Inserted": { order: 6.95 },
    "Tuples Updated": { order: 6.96 },
    "Tuples Deleted": { order: 6.97 },
    "Tuples Skipped": { order: 6.98 },
    "Conflict Resolution": { order: 6.981 },
    "Conflict Arbiter Indexes": { order: 6.982 },
    "Conflicting Tuples": { order: 6.99 },
    Workers: { order: 6.995 },

    "Startup Cost": { order: 9.1, tooltip: true, better: LOWER },
    "Total Cost": { order: 9.2, tooltip: true, better: LOWER },

    "Index Cond": { order: 10.1, tooltip: true, bottom: true },
    "Recheck Cond": { order: 10.2, tooltip: true, bottom: true },
    "TID Cond": { order: 10.3, tooltip: true, bottom: true },
    "Order By": { order: 10.4, bottom: true },
    "Hash Cond": { order: 10.5, tooltip: true, bottom: true },
    "Merge Cond": { order: 10.6, tooltip: true, bottom: true },
    "Join Filter": { order: 10.7, tooltip: true, bottom: true },
    "One-Time Filter": { order: 10.8, tooltip: true, bottom: true },
    Filter: { order: 10.9, tooltip: true, bottom: true },
    "Sort Key": { order: 10.91, tooltip: true, bottom: true },
    "Group Key": { order: 10.92, tooltip: true, bottom: true },
    "Grouping Sets": { order: 10.93, bottom: true },
    "Cache Key": { order: 10.94, bottom: true },
    "Function Call": { order: 10.95, bottom: true },
    Output: { name: "Output List", order: 10.99, bottom: true },

    "Shared Hit Blocks": { order: 11.1 },
    "Shared Read Blocks": { order: 11.2, better: LOWER },
    "Shared Dirtied Blocks": { order: 11.3, better: LOWER },
    "Shared Written Blocks": { order: 11.4, better: LOWER },
    "Local Hit Blocks": { order: 11.5 },
    "Local Read Blocks": { order: 11.6, better: LOWER },
    "Local Dirtied Blocks": { order: 11.7, better: LOWER },
    "Local Written Blocks": { order: 11.8, better: LOWER },
    "Temp Read Blocks": { order: 11.9, better: LOWER },
    "Temp Written Blocks": { order: 11.95, better: LOWER },
    "Shared I/O Read Time": { order: 11.96, unit: " ms", better: LOWER },
    "Shared I/O Write Time": { order: 11.97, unit: " ms", better: LOWER },
    "Local I/O Read Time": { order: 11.98, unit: " ms", better: LOWER },
    "Local I/O Write Time": { order: 11.99, unit: " ms", better: LOWER },
    "Temp I/O Read Time": { order: 11.991, unit: " ms", better: LOWER },
    "Temp I/O Write Time": { order: 11.992, unit: " ms", better: LOWER },
    "I/O Read Time": { order: 11.993, unit: " ms", better: LOWER },
    "I/O Write Time": { order: 11.994, unit: " ms", better: LOWER },

    "WAL Records": { order: 12.1, better: LOWER },
    "WAL FPI": { order: 12.2, better: LOWER },
    "WAL Bytes": { order: 12.3, unit: " B", better: LOWER },

    // Whole statement (root node only).
    "Query Text": { name: "Statement", order: 20.9, tooltip: true, bottom: true },
    "Planning Time": { order: 20.1, tooltip: true, unit: " ms", better: LOWER },
    "Execution Time": { order: 20.2, tooltip: true, unit: " ms", better: LOWER },
    Settings: { order: 20.3, tooltip: true },
    Planning: { order: 20.4 },
    JIT: { order: 20.5 },
    Triggers: { order: 20.6 },
    "Total Runtime": { order: 20.7, unit: " ms", better: LOWER },
};

/** Units of the keys nested inside objects (workers, groups, JIT), by key. */
const NESTED_UNITS: Readonly<Record<string, string>> = {
    "Actual Startup Time": " ms",
    "Actual Total Time": " ms",
    "Sort Space Used": " kB",
    "Average Sort Space Used": " kB",
    "Peak Sort Space Used": " kB",
    "Peak Memory Usage": " kB",
    Time: " ms",
    Generation: " ms",
    Inlining: " ms",
    Optimization: " ms",
    Emission: " ms",
    Total: " ms",
};

export const WARNINGS_NAME = "Warnings";

const base = (
    name: string,
    value: string | ExecutionPlanGraphElementProperty[],
    displayValue: string,
    dataType: DataType,
    def: PropertyDef | undefined,
    order: number,
): ExecutionPlanGraphElementProperty => ({
    name,
    value,
    showInTooltip: def?.tooltip ?? false,
    displayOrder: order,
    positionAtBottom: def?.bottom ?? false,
    displayValue,
    dataType,
    betterValue: def?.better ?? Better.None,
});

const formatNumber = (n: number): string =>
    Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(4)));

/** A name for the n-th element of an array of objects (workers, triggers...). */
function elementName(key: string, element: unknown, index: number): string {
    if (typeof element === "object" && element !== null) {
        const e = element as Record<string, unknown>;
        if (typeof e["Worker Number"] === "number") return `Worker ${e["Worker Number"]}`;
        if (typeof e["Trigger Name"] === "string") return `Trigger ${e["Trigger Name"]}`;
    }
    return `${key} ${index + 1}`;
}

/** Converts any JSON value of a plan into a property: scalars, lists of text, nested objects. */
export function valueToProperty(
    key: string,
    value: unknown,
    def: PropertyDef | undefined,
    order: number,
    nested = false,
): ExecutionPlanGraphElementProperty | undefined {
    const name = def?.name ?? key;
    const unit = def?.unit ?? (nested ? NESTED_UNITS[key] : undefined) ?? "";
    if (value === null || value === undefined) return undefined;
    if (typeof value === "number") {
        const text = formatNumber(value);
        return base(name, String(value), text + unit, DataType.Number, def, order);
    }
    if (typeof value === "boolean") {
        const text = value ? "True" : "False";
        return base(name, text, text, DataType.Boolean, def, order);
    }
    if (typeof value === "string") {
        return base(name, value, value, DataType.String, def, order);
    }
    if (Array.isArray(value)) {
        if (value.every((v) => typeof v !== "object" || v === null)) {
            const text = value.map(String).join(", ");
            return base(name, text, text, DataType.String, def, order);
        }
        const children = value
            .map((element, i) =>
                valueToProperty(elementName(key, element, i), element, undefined, i, true),
            )
            .filter((p): p is ExecutionPlanGraphElementProperty => p !== undefined);
        return base(name, children, "", DataType.Nested, def, order);
    }
    if (typeof value === "object") {
        const children = Object.entries(value as Record<string, unknown>)
            .map(([k, v], i) => valueToProperty(k, v, undefined, i, true))
            .filter((p): p is ExecutionPlanGraphElementProperty => p !== undefined);
        return base(name, children, "", DataType.Nested, def, order);
    }
    return undefined;
}

export interface NodePropertyContext {
    /** Present when the plan has run-time counters. */
    actual?: {
        loops: number;
        /** Rows of all executions (rows per loop times loops). */
        rows: number;
        /** Time of all executions in ms. */
        time: number | undefined;
    };
    /** Warnings found by the converter, one sentence each. */
    warnings: string[];
    /** Properties of the whole statement, for the root node. */
    statement?: Record<string, unknown>;
}

/** All the properties of a node, sorted by display order. */
export function buildNodeProperties(
    node: Record<string, unknown>,
    context: NodePropertyContext,
): ExecutionPlanGraphElementProperty[] {
    const result: ExecutionPlanGraphElementProperty[] = [];
    const add = (key: string, value: unknown, order?: number, nameKey: string = key): void => {
        const def = KNOWN[nameKey];
        const property = valueToProperty(key, value, def, order ?? def?.order ?? 100);
        if (property) result.push(property);
    };

    let unknownIndex = 0;
    const addAll = (source: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(source)) {
            if (STRUCTURAL_KEYS.has(key)) continue;
            const known = KNOWN[key];
            add(key, value, known ? known.order : 100 + unknownIndex++ / 1000);
        }
    };
    addAll(node);
    if (context.statement) addAll(context.statement);

    if (context.actual) {
        const { loops, rows, time } = context.actual;
        add("Actual Number of Rows for All Executions", rows);
        if (time !== undefined) add("Actual Time for All Executions", time);
        const planRows = node["Plan Rows"];
        if (typeof planRows === "number") {
            add("Estimated Number of Rows for All Executions", Math.round(planRows * loops));
        }
    }

    if (context.warnings.length > 0) {
        const items = context.warnings.map((text, i) =>
            base(`Warning ${i + 1}`, text, text, DataType.String, undefined, i),
        );
        result.push({
            ...base(
                WARNINGS_NAME,
                items,
                "",
                DataType.Nested,
                { order: 0.5, tooltip: true, bottom: true },
                0.5,
            ),
        });
    }

    // Stable: two properties with the same order keep the order of the server's keys.
    return result
        .map((property, index) => ({ property, index }))
        .sort((a, b) => a.property.displayOrder - b.property.displayOrder || a.index - b.index)
        .map(({ property }) => property);
}

/** The properties of the edge going into a node: what the page shows when hovering the arrow. */
export function buildEdgeProperties(
    child: Record<string, unknown>,
    actualRows: number | undefined,
): ExecutionPlanGraphElementProperty[] {
    const result: ExecutionPlanGraphElementProperty[] = [];
    let order = 0;
    const add = (name: string, value: number | undefined, unit = "") => {
        if (value === undefined) return;
        result.push({
            name,
            value: String(value),
            showInTooltip: true,
            displayOrder: order++,
            positionAtBottom: false,
            displayValue: formatNumber(value) + unit,
            dataType: DataType.Number,
            betterValue: Better.None,
        });
    };
    add("Actual Number of Rows for All Executions", actualRows);
    const planRows = child["Plan Rows"];
    const width = child["Plan Width"];
    add("Estimated Number of Rows", typeof planRows === "number" ? planRows : undefined);
    add("Estimated Row Size", typeof width === "number" ? width : undefined, " B");
    if (typeof planRows === "number" && typeof width === "number") {
        add("Estimated Data Size", planRows * width, " B");
    }
    return result;
}
