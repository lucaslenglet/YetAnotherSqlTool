/**
 * The node types of a PostgreSQL plan (`src/backend/commands/explain.c`, the `pname` / `sname`
 * switch of ExplainNode, as written in the "Node Type" key of EXPLAIN (FORMAT JSON)), with what
 * the page needs for each: the icon of Microsoft's operator it most resembles (`type` of the
 * node, a name of `webviews/pages/ExecutionPlan/icons`) and a one-sentence description.
 *
 * A node type this table does not know (a newer server) gets the generic operator icon.
 */

export type NodeJson = Record<string, unknown>;

/** Icon of the page's generic operator ("iterator_catch_all"). */
export const GENERIC_ICON = "iterator_catch_all";

interface NodeTypeInfo {
    /** Icon name, or a function of the node for the types whose look depends on a key. */
    icon: string | ((node: NodeJson) => string);
    description: string;
}

const str = (node: NodeJson, key: string): string | undefined =>
    typeof node[key] === "string" ? (node[key] as string) : undefined;

const byOperation =
    (icons: Record<string, string>, fallback: string) =>
    (node: NodeJson): string =>
        icons[str(node, "Operation") ?? ""] ?? fallback;

/** Index scans with a condition seek, the others read the index in order. */
const indexScanIcon = (node: NodeJson): string =>
    node["Index Cond"] !== undefined ? "index_seek" : "index_scan";

const byStrategy =
    (icons: Record<string, string>, fallback: string) =>
    (node: NodeJson): string =>
        icons[str(node, "Strategy") ?? ""] ?? fallback;

/** Every "Node Type" of explain.c, by the name EXPLAIN (FORMAT JSON) writes. */
export const NODE_TYPES: Readonly<Record<string, NodeTypeInfo>> = {
    Result: {
        icon: "result",
        description:
            "Compute a result without scanning a table: a constant expression, or a filter that applies once to its input.",
    },
    ProjectSet: {
        icon: "table_valued_function",
        description: "Expand set-returning functions of the select list into rows.",
    },
    ModifyTable: {
        icon: byOperation(
            {
                Insert: "table_insert",
                Update: "table_update",
                Delete: "table_delete",
                Merge: "table_merge",
            },
            "table_update",
        ),
        description: "Insert, update, delete or merge the rows produced by its input into a table.",
    },
    Append: {
        icon: "concatenation",
        description: "Concatenate the rows of several inputs (UNION ALL, partitions, inheritance).",
    },
    "Merge Append": {
        icon: "concatenation",
        description:
            "Concatenate several sorted inputs into one sorted output, keeping the sort order.",
    },
    "Recursive Union": {
        icon: "union_all",
        description:
            "Evaluate a recursive common table expression: the non-recursive term, then the recursive term until it returns no rows.",
    },
    BitmapAnd: {
        icon: "bitmap",
        description: "Intersect the bitmaps of several index scans (AND).",
    },
    BitmapOr: {
        icon: "bitmap",
        description: "Combine the bitmaps of several index scans (OR).",
    },
    "Nested Loop": {
        icon: "nested_loops",
        description:
            "For each row of the outer input, scan the inner input for matching rows. The inner side runs once per outer row.",
    },
    "Merge Join": {
        icon: "merge_join",
        description: "Join two inputs sorted on the join keys by merging them in one pass.",
    },
    "Hash Join": {
        icon: "hash_match",
        description:
            "Join by building a hash table of the inner input (Hash) and probing it with each row of the outer input.",
    },
    "Seq Scan": {
        icon: "table_scan",
        description: "Read every row of a table, in physical order.",
    },
    "Sample Scan": {
        icon: "table_scan",
        description: "Read a random sample of a table (TABLESAMPLE).",
    },
    Gather: {
        icon: "parallelism",
        description:
            "Collect the rows produced by parallel worker processes, in no particular order.",
    },
    "Gather Merge": {
        icon: "parallelism",
        description:
            "Collect the sorted rows of parallel worker processes and merge them, keeping the sort order.",
    },
    "Index Scan": {
        icon: indexScanIcon,
        description:
            "Find rows through an index and fetch them from the table (a backward scan reads the index in descending order).",
    },
    "Index Only Scan": {
        icon: indexScanIcon,
        description:
            "Find rows through an index without reading the table when the visibility map allows it (heap fetches count the exceptions).",
    },
    "Bitmap Index Scan": {
        icon: "index_seek",
        description: "Scan an index and build a bitmap of the table pages that hold matching rows.",
    },
    "Bitmap Heap Scan": {
        icon: "rid_lookup",
        description: "Read the table pages a bitmap points to, in physical order.",
    },
    "Tid Scan": {
        icon: "rid_lookup",
        description: "Fetch rows by their physical location (ctid).",
    },
    "Tid Range Scan": {
        icon: "table_scan",
        description: "Read the rows in a range of physical locations (ctid).",
    },
    "Subquery Scan": {
        icon: "filter",
        description: "Read the output of a subquery in FROM, applying a filter if there is one.",
    },
    "Function Scan": {
        icon: "table_valued_function",
        description: "Read the rows a set-returning function in FROM produces.",
    },
    "Table Function Scan": {
        icon: "table_valued_function",
        description: "Read the rows of a table function such as XMLTABLE or JSON_TABLE.",
    },
    "Values Scan": {
        icon: "constant_scan",
        description: "Read the rows of a VALUES list.",
    },
    "CTE Scan": {
        icon: "table_spool",
        description:
            "Read the stored result of a common table expression (WITH query). It is computed once.",
    },
    "Named Tuplestore Scan": {
        icon: "table_spool",
        description: "Read a named set of rows, such as the transition table of a trigger.",
    },
    "WorkTable Scan": {
        icon: "table_spool",
        description: "Read the rows of the previous round of a recursive common table expression.",
    },
    "Foreign Scan": {
        icon: byOperation(
            {
                Select: "remote_scan",
                Insert: "remote_insert",
                Update: "remote_update",
                Delete: "remote_delete",
            },
            "remote_scan",
        ),
        description: "Read or modify rows in a foreign table through its foreign data wrapper.",
    },
    "Custom Scan": {
        icon: "udx",
        description: "Run a plan node supplied by an extension.",
    },
    Materialize: {
        icon: "table_spool",
        description:
            "Store the rows of its input so that they can be read again without recomputing.",
    },
    Memoize: {
        icon: "index_spool",
        description:
            "Cache the rows the inner side returned for each parameter value, to skip repeated lookups.",
    },
    Sort: {
        icon: "sort",
        description: "Sort the rows (in memory, or on disk when they do not fit in work_mem).",
    },
    "Incremental Sort": {
        icon: "sort",
        description:
            "Sort rows that already arrive sorted on a prefix of the sort key, one group at a time.",
    },
    Group: {
        icon: "stream_aggregate",
        description: "Group sorted rows without computing aggregates (GROUP BY on sorted input).",
    },
    Aggregate: {
        icon: byStrategy(
            {
                Plain: "aggregate",
                Sorted: "stream_aggregate",
                Hashed: "hash_match",
                Mixed: "hash_match",
            },
            "aggregate",
        ),
        description:
            "Compute aggregates: one result (Plain), per group over sorted input (Sorted), or per group with a hash table (Hashed, Mixed).",
    },
    WindowAgg: {
        icon: "window_aggregate",
        description: "Compute window functions over sorted rows.",
    },
    Unique: {
        icon: "group_by_aggregate",
        description: "Remove duplicates from sorted rows (DISTINCT, UNION).",
    },
    SetOp: {
        icon: byStrategy({ Sorted: "merge_join", Hashed: "hash_match" }, "hash_match"),
        description: "Compute INTERSECT or EXCEPT, by sorting or by hashing the inputs.",
    },
    LockRows: {
        icon: "locate",
        description: "Lock the rows it reads (SELECT ... FOR UPDATE / SHARE).",
    },
    Limit: {
        icon: "top",
        description: "Return only the requested number of rows (LIMIT / OFFSET / FETCH FIRST).",
    },
    Hash: {
        icon: "batch_hash_table_build",
        description: "Build the hash table a Hash Join probes.",
    },
};

/** Icon of a node. */
export function iconFor(node: NodeJson): string {
    const info = NODE_TYPES[str(node, "Node Type") ?? ""];
    if (!info) return GENERIC_ICON;
    return typeof info.icon === "function" ? info.icon(node) : info.icon;
}

export function descriptionFor(node: NodeJson): string {
    return NODE_TYPES[str(node, "Node Type") ?? ""]?.description ?? "";
}

/** Join types as SSMS words them in the second line of a join operator. */
const JOIN_LOGICAL_NAMES: Record<string, string> = {
    Inner: "Inner Join",
    Left: "Left Outer Join",
    Right: "Right Outer Join",
    Full: "Full Outer Join",
    Semi: "Left Semi Join",
    Anti: "Left Anti Semi Join",
    "Right Semi": "Right Semi Join",
    "Right Anti": "Right Anti Semi Join",
};

/** First line of a node's label: the node type as PostgreSQL's text format writes it. */
export function operatorName(node: NodeJson): string {
    const type = str(node, "Node Type") ?? "Unknown";
    switch (type) {
        case "Index Scan":
        case "Index Only Scan":
            return str(node, "Scan Direction") === "Backward" ? `${type} Backward` : type;
        case "ModifyTable":
            return str(node, "Operation") ?? type;
        case "Aggregate": {
            const strategy = str(node, "Strategy");
            const base =
                strategy === "Sorted"
                    ? "GroupAggregate"
                    : strategy === "Hashed"
                      ? "HashAggregate"
                      : strategy === "Mixed"
                        ? "MixedAggregate"
                        : "Aggregate";
            const mode = str(node, "Partial Mode");
            return mode === "Partial" || mode === "Finalize" ? `${mode} ${base}` : base;
        }
        case "SetOp":
            return str(node, "Strategy") === "Hashed" ? "HashSetOp" : "SetOp";
        case "Foreign Scan": {
            const operation = str(node, "Operation");
            return operation && operation !== "Select" ? `Foreign ${operation}` : type;
        }
        default:
            return type;
    }
}

/** Logical operation shown in parentheses under a join's name, like SSMS: "(Left Outer Join)". */
export function logicalOperation(node: NodeJson): string | undefined {
    const joinType = str(node, "Join Type");
    if (joinType === undefined) return undefined;
    const name = JOIN_LOGICAL_NAMES[joinType] ?? `${joinType} Join`;
    return `(${name})`;
}
