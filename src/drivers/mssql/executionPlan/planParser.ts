/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Port of sqltoolsservice's ShowPlan/Node.cs, Edge.cs, showplangraph.cs, XmlPlanNodeBuilder.cs,
 * XmlPlanParser.cs, XmlPlanParserFactory.cs and the parsers (RelOpTypeParser.cs,
 * RelOpBaseTypeParser.cs, IndexOpTypeParser.cs, MergeTypeParser.cs, FilterTypeParser.cs,
 * FunctionTypeParser.cs, StatementParser.cs, CursorStatementParser.cs, CursorOperationParser.cs,
 * ConditionParser.cs, XmlPlanHierarchyParser.cs). Live plans (FlattenConditionClauses) and the
 * comparison skeleton are left out.
 */

import {
    ClrArray,
    ClrEnum,
    ClrNumber,
    clrToString,
    clrTypeName,
    format,
    formatFixed,
    roundHalfEven,
    SchemaObject,
    xmlConvertDouble,
} from "./clr";
import {
    defaultValue,
    deserializeShowPlan,
    enumXmlValue,
    isSchemaClass,
    schemaClass,
    serializationMembers,
} from "./deserialize";
import {
    convertFrom,
    createNamedProperty,
    isObjectTypeCode,
    LIST_SEPARATOR,
    mergeString,
    ObjectWrapper,
    parseProperties,
    PropertyBag,
    type PropertyInfo,
    propertiesOf,
    RunTimeCounters,
} from "./objectModel";
import {
    getCursorType,
    getLogicalOperation,
    getPhysicalOperation,
    getStatement,
    getStoredProc,
    getUdf,
    Operation,
} from "./operationTable";
import { SR } from "./showplanStrings.generated";
import { parseXml } from "./xml";

/** A missing index of a statement (Description.cs). */
export interface MissingIndex {
    caption: string;
    queryText: string;
    impact: string;
    database: string;
}

/** A statement's graph (ShowPlanGraph). */
export class ShowPlanGraph {
    root: Node | null = null;
    /** NodeStmtMap: every node created for the statement. */
    readonly nodeStmtMap = new Map<Node, unknown>();
    missingIndexes: MissingIndex[] = [];

    /** The statement's text, or a procedure's name for a UDF or stored procedure graph. */
    get statement(): string {
        const root = this.root!;
        const text = root.get("StatementText");
        if (typeof text === "string") return text;
        const procName = root.get("ProcName");
        return typeof procName === "string" ? procName : "";
    }
}

interface NodeBuilderContext {
    graph: ShowPlanGraph;
    nextNodeId(): number;
}

const LARGE_PLAN_NODE_COUNT = 20;

export class Node {
    readonly properties = new PropertyBag();
    readonly children: Node[] = [];
    readonly edges: Edge[] = [];
    operation: Operation | null = null;
    readonly root: Node;
    readonly graph: ShowPlanGraph;
    logicalOpUnlocName: string | null = null;
    physicalOpUnlocName: string | null = null;
    private costValue: number | undefined;
    private subtreeCostValue = 0;

    constructor(
        readonly id: number,
        context: NodeBuilderContext,
    ) {
        this.root = context.graph.root ?? this;
        this.graph = context.graph;
    }

    get(name: string): unknown {
        return this.properties.get(name);
    }

    set(name: string, value: unknown) {
        const existing = this.properties.find(name);
        if (existing) existing.value = value;
        else this.properties.add(createNamedProperty(name, value));
    }

    get displayName(): string {
        if (this.operation === Operation.unknown) return "";
        // First line: the physical operation; second line: the object, else the logical operation
        // (in parentheses, and only when it differs from the first line).
        let firstLine = this.get("PhysicalOp");
        if (typeof firstLine !== "string") {
            if (this.operation === null) return "";
            firstLine = this.operation.displayName;
        }
        let secondLine: string | null;
        const objectValue = this.get("Object");
        if (objectValue !== null) {
            secondLine = objectNameForDisplay(objectValue);
        } else {
            const logical = this.get("LogicalOp");
            secondLine =
                typeof logical === "string"
                    ? logical !== firstLine
                        ? `(${logical})`
                        : null
                    : null;
        }
        return secondLine === null || secondLine.length === 0
            ? (firstLine as string)
            : `${firstLine as string}\n${secondLine}`;
    }

    get description(): string | null {
        return this.operation!.description;
    }

    get isParallel(): boolean {
        return this.get("Parallel") === true;
    }

    get hasWarnings(): boolean {
        return this.get("Warnings") !== null;
    }

    get hasCriticalWarnings(): boolean {
        const warnings = this.get("Warnings");
        if (warnings instanceof ObjectWrapper) {
            const noJoinPredicate = warnings.get("NoJoinPredicate");
            if (noJoinPredicate !== null) return noJoinPredicate === true;
        }
        return false;
    }

    private get hasPDWCost(): boolean {
        return this.get("PDWAccumulativeCost") !== null;
    }

    get cost(): number {
        if (this.costValue === undefined) {
            let cost = this.subtreeCost;
            for (const child of this.children) cost -= child.subtreeCost;
            // Rounding can leave a small negative number.
            this.costValue = Math.max(cost, 0);
        }
        return this.costValue;
    }

    get relativeCost(): number {
        const overall = this.root.subtreeCost;
        return overall > 0 ? this.cost / overall : 0;
    }

    /** Without a cost of its own, the sum of the children's (a getter that stores, as in the C#). */
    get subtreeCost(): number {
        if (this.subtreeCostValue === 0) {
            for (const child of this.children) this.subtreeCostValue += child.subtreeCost;
        }
        return this.subtreeCostValue;
    }

    set subtreeCost(value: number) {
        this.subtreeCostValue = value;
    }

    /** new DateTime(ms * TicksPerMillisecond).Millisecond: the milliseconds within the second. */
    private timeStatistic(counterName: string): number | null {
        const statistics = this.get("ActualTimeStatistics");
        if (statistics instanceof ObjectWrapper) {
            const counters = statistics.get(counterName);
            if (counters instanceof RunTimeCounters) return counters.maxCounter % 1000;
        }
        return null;
    }

    get elapsedTimeInMs(): number | null {
        return this.timeStatistic("ActualElapsedms");
    }

    get elapsedCpuTimeInMs(): number | null {
        return this.timeStatistic("ActualCPUms");
    }

    getDisplayLinesOfText(): string[] {
        return this.displayName.split("\n");
    }

    getRowCountDisplayString(): string {
        const actualRows = this.get("ActualRows");
        if (actualRows instanceof RunTimeCounters) return String(actualRows.totalCounters);
        const estimateRows = asDouble(this.get("EstimateRows"));
        const estimateExecutions = asDouble(this.get("EstimateExecutions"));
        if (estimateRows === null) return "";
        // Estimated rows are shown as an integer.
        const rows = roundHalfEven(
            estimateExecutions !== null ? estimateRows * estimateExecutions : estimateRows,
        );
        return new ClrNumber("double", rows).toString();
    }

    getNodeCostDisplayString(): string {
        let cost = this.relativeCost * 100;
        if (this.hasPDWCost && !(cost > 0)) return "";
        if (this.graph.nodeStmtMap.size < LARGE_PLAN_NODE_COUNT) cost = roundHalfEven(cost);
        return formatFixed(cost, 2) + "%";
    }

    addChild(child: Node) {
        this.edges.push(new Edge(child));
        this.children.push(child);
    }
}

/** `value as double?`: a boxed double, nothing else. */
function asDouble(value: unknown): number | null {
    return value instanceof ClrNumber && value.type === "double" ? value.value : null;
}

/** Convert.ToDouble(object). */
function toDouble(value: unknown): number {
    if (value instanceof ClrNumber) return value.value;
    if (typeof value === "boolean") return value ? 1 : 0;
    return Number.parseFloat(clrToString(value));
}

/** [Table].[Index] [Alias]: database and schema matter less than the table. */
function objectNameForDisplay(objectValue: unknown): string {
    if (objectValue instanceof ObjectWrapper) {
        const name = mergeString(".", objectValue.get("Table"), objectValue.get("Index"));
        return mergeString(" ", name, objectValue.get("Alias"));
    }
    return clrToString(objectValue);
}

/** The edge to a child: some of the child's properties, and the estimated data size. */
export class Edge {
    readonly properties = new PropertyBag();

    constructor(node: Node) {
        for (const name of [
            "ActualRows",
            "ActualRowsRead",
            "AvgRowSize",
            "EstimateRows",
            "EstimateRowsAllExecs",
            "StatementEstRows",
        ]) {
            const value = node.get(name);
            if (value !== null) this.set(name, value);
        }
        this.set(
            "EstimatedDataSize",
            new ClrNumber("double", this.rowSize * this.estimatedRowCount),
        );
    }

    get(name: string): unknown {
        return this.properties.get(name);
    }

    private set(name: string, value: unknown) {
        const existing = this.properties.find(name);
        if (existing) existing.value = value;
        else this.properties.add(createNamedProperty(name, value));
    }

    get rowSize(): number {
        const value = this.get("AvgRowSize");
        return value !== null ? toDouble(value) : 0;
    }

    get rowCount(): number {
        const actualRowsRead = this.get("ActualRowsRead");
        const actualRows = this.get("ActualRows");
        // Without actual counts, the estimate.
        if (actualRowsRead === null && actualRows === null) return this.estimatedRowCount;
        const read = actualRowsRead !== null ? toDouble(clrToString(actualRowsRead)) : 0;
        const rows = actualRows !== null ? toDouble(clrToString(actualRows)) : 0;
        return read > rows ? read : rows;
    }

    get estimatedRowCount(): number {
        const value = this.get("EstimateRows") ?? this.get("StatementEstRows");
        return value !== null ? toDouble(value) : 0;
    }
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

interface FunctionTypeItem {
    function: SchemaObject;
    type: "udf" | "storedProcedure";
}

abstract class XmlPlanParser {
    abstract getCurrentNode(
        item: SchemaObject,
        parentItem: SchemaObject | null,
        parentNode: Node | null,
        context: NodeBuilderContext,
    ): Node | null;

    getChildren(item: SchemaObject): SchemaObject[] {
        return enumerateChildren(item);
    }

    extractFunctions(_item: SchemaObject): FunctionTypeItem[] {
        return [];
    }

    shouldParseItem(_item: SchemaObject): boolean {
        return true;
    }

    parseProperties(item: SchemaObject, target: PropertyBag) {
        parseProperties(item, target, (property) => this.shouldSkipProperty(property));
    }

    /** A property that holds child items is a hierarchy property, not a displayed one. */
    protected shouldSkipProperty(property: PropertyInfo): boolean {
        return getParser(property.type.replace(/\[\]$/, "")) !== null;
    }

    setNodeSpecialProperties(node: Node) {
        node.operation ??= this.getNodeOperation(node);
        node.subtreeCost = this.getNodeSubtreeCost(node);

        // EstimateExecutions = EstimateRebinds + EstimateRewinds + 1
        const rebinds = node.get("EstimateRebinds");
        const rewinds = node.get("EstimateRewinds");
        if (rebinds !== null && rewinds !== null) {
            node.set(
                "EstimateExecutions",
                new ClrNumber("double", toDouble(rebinds) + toDouble(rewinds) + 1),
            );
        }
        // EstimateRowsAllExecs = EstimateRows * EstimateExecutions
        const estimateRows = node.get("EstimateRows");
        const estimateExecutions = node.get("EstimateExecutions");
        const rows = estimateRows === null ? 0 : toDouble(estimateRows);
        const executions = estimateExecutions === null ? 0 : toDouble(estimateExecutions);
        node.set("EstimateRowsAllExecs", new ClrNumber("double", rows * executions));
    }

    protected getNodeOperation(_node: Node): Operation | null {
        throw new Error("GetNodeOperation is not defined for this parser");
    }

    protected getNodeSubtreeCost(_node: Node): number {
        throw new Error("GetNodeSubtreeCost is not defined for this parser");
    }
}

/** EnumerateChildren: the values of object-typed properties that have a parser. */
function enumerateChildren(item: SchemaObject): SchemaObject[] {
    const children: SchemaObject[] = [];
    for (const property of propertiesOf(item)) {
        if (!isObjectTypeCode(property.type)) continue;
        const value = item.values.get(property.name);
        if (value === null || value === undefined) continue;
        const values = value instanceof ClrArray ? value.items : [value];
        for (const v of values) {
            if (v instanceof SchemaObject && getParser(v.className) !== null) children.push(v);
        }
    }
    return children;
}

function newNode(context: NodeBuilderContext): Node {
    return new Node(context.nextNodeId(), context);
}

class RelOpTypeParser extends XmlPlanParser {
    getCurrentNode(
        _item: SchemaObject,
        _parentItem: SchemaObject | null,
        _parentNode: Node | null,
        context: NodeBuilderContext,
    ): Node {
        return newNode(context);
    }

    override getChildren(item: SchemaObject): SchemaObject[] {
        const operator = item.values.get("Item");
        return operator instanceof SchemaObject ? [operator] : [];
    }

    protected override getNodeOperation(node: Node): Operation {
        const physicalOpType = node.get("PhysicalOp");
        const logicalOpType = node.get("LogicalOp");
        if (physicalOpType === null || logicalOpType === null)
            throw new Error(SR.UnknownShowPlanSource);
        let physicalOpTypeName = clrToString(physicalOpType);
        let logicalOpTypeName = clrToString(logicalOpType);

        // A clustered index seek with Lookup=true is shown as a Key Lookup (SQLBU 434739).
        if (node.get("Lookup") === true) {
            if (physicalOpTypeName.toLowerCase() === "clusteredindexseek")
                physicalOpTypeName = "KeyLookup";
            if (logicalOpTypeName.toLowerCase() === "clusteredindexseek")
                logicalOpTypeName = "KeyLookup";
        }

        // Index scans read Storage on the node; DML operators on their Object.
        const lower = physicalOpTypeName.toLowerCase();
        if (lower === "indexscan" || lower === "clusteredindexscan") {
            const storage = node.get("Storage");
            if (storage instanceof ClrEnum && storage.member === "ColumnStore")
                physicalOpTypeName = "ColumnstoreIndexScan";
        } else {
            const objectWrapper = node.get("Object");
            if (objectWrapper instanceof ObjectWrapper) {
                const storage = objectWrapper.properties.find("Storage");
                if (
                    storage &&
                    storage.value instanceof ClrEnum &&
                    storage.value.member === "ColumnStore"
                ) {
                    if (lower === "indexdelete" || lower === "clusteredindexdelete")
                        physicalOpTypeName = "ColumnstoreIndexDelete";
                    else if (lower === "indexinsert" || lower === "clusteredindexinsert")
                        physicalOpTypeName = "ColumnstoreIndexInsert";
                    else if (lower === "indexmerge" || lower === "clusteredindexmerge")
                        physicalOpTypeName = "ColumnstoreIndexMerge";
                    else if (lower === "indexupdate" || lower === "clusteredindexupdate")
                        physicalOpTypeName = "ColumnstoreIndexUpdate";
                }
            }
        }

        const physicalOp = getPhysicalOperation(physicalOpTypeName);
        const logicalOp = getLogicalOperation(logicalOpTypeName);
        const resultOp =
            logicalOp.image !== null && logicalOp.description !== null ? logicalOp : physicalOp;

        node.logicalOpUnlocName = logicalOpTypeName;
        node.physicalOpUnlocName = physicalOpTypeName;
        node.set("PhysicalOp", physicalOp.displayName);
        node.set("LogicalOp", logicalOp.displayName);
        return resultOp;
    }

    protected override getNodeSubtreeCost(node: Node): number {
        const value = node.get("PDWAccumulativeCost") ?? node.get("EstimatedTotalSubtreeCost");
        return value !== null ? toDouble(value) : 0;
    }

    override parseProperties(item: SchemaObject, target: PropertyBag) {
        super.parseProperties(item, target);
        const runTimeInformation = item.values.get("RunTimeInformation") as ClrArray | null;
        if (runTimeInformation && runTimeInformation.items.length > 0) {
            parseRunTimeInformation(runTimeInformation.items as SchemaObject[], target);
        }
        // RunTimePartitionSummary is shown as separate properties, not nested.
        const summary = item.values.get("RunTimePartitionSummary") as SchemaObject | null;
        const partitions = summary?.values.get("PartitionsAccessed") as
            SchemaObject | null | undefined;
        if (partitions) {
            target.add(
                createNamedProperty("PartitionCount", partitions.values.get("PartitionCount")),
            );
            const ranges = partitions.values.get("PartitionRange") as ClrArray | null;
            if (ranges && ranges.items.length > 0) {
                const text = (ranges.items as SchemaObject[])
                    .map((range) => {
                        const start = clrToString(range.values.get("Start"));
                        const end = clrToString(range.values.get("End"));
                        return start === end ? start : `${start}..${end}`;
                    })
                    .join(LIST_SEPARATOR);
                target.add(createNamedProperty("PartitionsAccessed", text));
            }
        }
    }
}

/** RelOpTypeParser: the per-thread counters of an actual plan, as properties. */
function parseRunTimeInformation(perThread: SchemaObject[], target: PropertyBag) {
    const counter = () => new RunTimeCounters();
    const actualRows = counter();
    const actualRowsRead = counter();
    const actualBatches = counter();
    const actualRebinds = counter();
    const actualRewinds = counter();
    const actualExecutions = counter();
    const actualLocallyAggregatedRows = counter();
    const optional: Record<string, RunTimeCounters> = {
        ActualElapsedms: new RunTimeCounters(false),
        ActualCPUms: counter(),
        ActualScans: counter(),
        ActualLogicalReads: counter(),
        ActualPhysicalReads: counter(),
        ActualPageServerReads: counter(),
        ActualReadAheads: counter(),
        ActualPageServerReadAheads: counter(),
        ActualLobLogicalReads: counter(),
        ActualLobPhysicalReads: counter(),
        ActualLobPageServerReads: counter(),
        ActualLobReadAheads: counter(),
        ActualLobPageServerReadAheads: counter(),
        ActualRowsRead: actualRowsRead,
        Batches: actualBatches,
        HpcRowCount: counter(),
        HpcKernelElapsedUs: counter(),
        HpcHostToDeviceBytes: counter(),
        HpcDeviceToHostBytes: counter(),
        InputMemoryGrant: new RunTimeCounters(true, true),
        OutputMemoryGrant: new RunTimeCounters(true, true),
        UsedMemoryGrant: counter(),
    };
    let actualExecutionMode = "";
    let actualJoinType = "";
    let isInterleavedExecuted = false;

    for (const c of perThread) {
        const v = c.values;
        const num = (name: string) => (v.get(name) as ClrNumber).value;
        // Brick ids only change the per-thread names, which are not shown.
        const thread = num("Thread");
        actualRows.addCounter(thread, num("ActualRows"));
        actualRebinds.addCounter(thread, num("ActualRebinds"));
        actualRewinds.addCounter(thread, num("ActualRewinds"));
        actualExecutions.addCounter(thread, num("ActualExecutions"));
        actualLocallyAggregatedRows.addCounter(thread, num("ActualLocallyAggregatedRows"));
        for (const [name, counters] of Object.entries(optional)) {
            if (v.get(name + "Specified") === true) counters.addCounter(thread, num(name));
        }
        if (num("ActualExecutions") > 0)
            actualExecutionMode = clrToString(v.get("ActualExecutionMode"));
        if (v.get("ActualJoinTypeSpecified") === true)
            actualJoinType = clrToString(v.get("ActualJoinType"));
        if (v.get("IsInterleavedExecuted") === true) isInterleavedExecuted = true;
    }

    if (isInterleavedExecuted) target.add(createNamedProperty("IsInterleavedExecuted", true));
    target.add(createNamedProperty("ActualRows", actualRows));
    target.add(createNamedProperty("ActualBatches", actualBatches));
    target.add(createNamedProperty("ActualRebinds", actualRebinds));
    target.add(createNamedProperty("ActualRewinds", actualRewinds));
    target.add(createNamedProperty("ActualExecutions", actualExecutions));
    if (actualRowsRead.totalCounters > 0)
        target.add(createNamedProperty("ActualRowsRead", actualRowsRead));
    if (actualLocallyAggregatedRows.totalCounters > 0) {
        target.add(createNamedProperty("ActualLocallyAggregatedRows", actualLocallyAggregatedRows));
    }
    for (const name of [
        "HpcRowCount",
        "HpcKernelElapsedUs",
        "HpcHostToDeviceBytes",
        "HpcDeviceToHostBytes",
    ]) {
        if (optional[name].totalCounters > 0) target.add(createNamedProperty(name, optional[name]));
    }
    if (actualExecutionMode)
        target.add(createNamedProperty("ActualExecutionMode", actualExecutionMode));
    if (actualJoinType) target.add(createNamedProperty("ActualJoinType", actualJoinType));

    const group = (wrapperName: string, names: string[]) => {
        const wrapper = new ObjectWrapper();
        for (const name of names) {
            if (optional[name].numOfCounters > 0)
                wrapper.properties.add(createNamedProperty(name, optional[name]));
        }
        if (wrapper.properties.count > 0) target.add(createNamedProperty(wrapperName, wrapper));
    };
    group("ActualTimeStatistics", ["ActualElapsedms", "ActualCPUms"]);
    group("ActualIOStatistics", [
        "ActualScans",
        "ActualLogicalReads",
        "ActualPhysicalReads",
        "ActualPageServerReads",
        "ActualReadAheads",
        "ActualPageServerReadAheads",
        "ActualLobLogicalReads",
        "ActualLobPhysicalReads",
        "ActualLobPageServerReads",
        "ActualLobReadAheads",
        "ActualLobPageServerReadAheads",
    ]);
    group("ActualMemoryGrantStats", ["InputMemoryGrant", "OutputMemoryGrant", "UsedMemoryGrant"]);
}

/** An operator's own element (IndexScan, Hash…): its properties go on the RelOp's node. */
class RelOpBaseTypeParser extends XmlPlanParser {
    getCurrentNode(
        _item: SchemaObject,
        _parentItem: SchemaObject | null,
        parentNode: Node | null,
    ): Node | null {
        return parentNode;
    }

    override getChildren(item: SchemaObject): SchemaObject[] {
        if (!propertiesOf(item).some((p) => p.name === "RelOp")) return [];
        const value = item.values.get("RelOp");
        if (value === null || value === undefined) return [];
        return (value instanceof ClrArray ? value.items : [value]) as SchemaObject[];
    }
}

class IndexOpTypeParser extends RelOpBaseTypeParser {
    override parseProperties(item: SchemaObject, target: PropertyBag) {
        super.parseProperties(item, target);
        // The index kind of the (single) object becomes PhysicalOperationKind.
        const objects = item.values.get("Object");
        if (objects instanceof ClrArray && objects.items.length === 1) {
            const object = objects.items[0] as SchemaObject;
            if (object.values.get("IndexKindSpecified") === true) {
                const kind = clrToString(object.values.get("IndexKind"));
                if (kind.length > 0) target.add(createNamedProperty("PhysicalOperationKind", kind));
            }
        }
    }
}

class MergeTypeParser extends RelOpBaseTypeParser {
    override parseProperties(item: SchemaObject, target: PropertyBag) {
        super.parseProperties(item, target);
        // A new property combines InnerSideJoinColumns and OuterSideJoinColumns.
        const mergeColumns = new SchemaObject(
            "MergeColumns",
            new Map([
                ["InnerSideJoinColumns", item.values.get("InnerSideJoinColumns") ?? null],
                ["OuterSideJoinColumns", item.values.get("OuterSideJoinColumns") ?? null],
            ]),
            "MergeColumns",
        );
        target.add(createNamedProperty("WhereJoinColumns", convertFrom(mergeColumns)));
    }

    protected override shouldSkipProperty(property: PropertyInfo): boolean {
        if (property.name === "InnerSideJoinColumns" || property.name === "OuterSideJoinColumns")
            return true;
        return super.shouldSkipProperty(property);
    }
}

class FilterTypeParser extends RelOpBaseTypeParser {
    override parseProperties(item: SchemaObject, target: PropertyBag) {
        super.parseProperties(item, target);
        if (item.values.get("StartupExpression") === true) {
            target.find("Predicate")?.setDisplayName(SR.StartupExpressionPredicate);
        }
    }
}

class FunctionTypeParser extends XmlPlanParser {
    getCurrentNode(
        item: SchemaObject,
        parentItem: SchemaObject | null,
        _parentNode: Node | null,
        context: NodeBuilderContext,
    ): Node {
        const node = newNode(context);
        // The parent's StoredProc property references a stored procedure; anything else is a UDF.
        const isStoredProcedure =
            parentItem !== null &&
            propertiesOf(parentItem).some((p) => p.name === "StoredProc") &&
            parentItem.values.get("StoredProc") === item;
        node.operation = isStoredProcedure ? getStoredProc() : getUdf();
        return node;
    }

    protected override getNodeOperation(): Operation | null {
        return null;
    }

    protected override getNodeSubtreeCost(): number {
        return 0;
    }
}

class StatementParser extends XmlPlanParser {
    getCurrentNode(
        _item: SchemaObject,
        _parentItem: SchemaObject | null,
        _parentNode: Node | null,
        context: NodeBuilderContext,
    ): Node {
        return newNode(context);
    }

    protected override getNodeOperation(node: Node): Operation {
        const statementType = node.get("StatementType");
        return statementType !== null
            ? getStatement(clrToString(statementType))
            : Operation.unknown;
    }

    protected override getNodeSubtreeCost(node: Node): number {
        const value = node.get("StatementSubTreeCost");
        return value !== null ? toDouble(value) : 0;
    }

    override shouldParseItem(item: SchemaObject): boolean {
        // The hidden wrapper statements of UDFs and stored procedures have no StatementId.
        return !(
            item.className === "StmtSimpleType" && item.values.get("StatementIdSpecified") !== true
        );
    }

    override extractFunctions(item: SchemaObject): FunctionTypeItem[] {
        const found: FunctionTypeItem[] = [];
        if (item.className === "StmtSimpleType") {
            const udfs = item.values.get("UDF") as ClrArray | null;
            if (udfs) {
                for (const fn of udfs.items)
                    found.push({ function: fn as SchemaObject, type: "udf" });
                item.values.set("UDF", null);
            }
            const storedProc = item.values.get("StoredProc") as SchemaObject | null;
            if (storedProc) {
                found.push({ function: storedProc, type: "storedProcedure" });
                item.values.set("StoredProc", null);
            }
        } else {
            for (const child of this.getChildren(item))
                found.push(...getParser(child.className)!.extractFunctions(child));
        }
        return found;
    }
}

class CursorStatementParser extends StatementParser {
    protected override getNodeOperation(node: Node): Operation {
        const cursorType = node.get("CursorActualType") ?? node.get("StatementType");
        return cursorType !== null ? getCursorType(clrToString(cursorType)) : Operation.unknown;
    }
}

class CursorOperationParser extends XmlPlanParser {
    getCurrentNode(
        _item: SchemaObject,
        _parentItem: SchemaObject | null,
        _parentNode: Node | null,
        context: NodeBuilderContext,
    ): Node {
        return newNode(context);
    }

    protected override getNodeOperation(node: Node): Operation {
        const name = node.get("OperationType");
        return name !== null ? getPhysicalOperation(clrToString(name)) : Operation.unknown;
    }

    protected override getNodeSubtreeCost(): number {
        return 0;
    }
}

/** Elements that only hold others: their properties go on the parent's node. */
class XmlPlanHierarchyParser extends XmlPlanParser {
    getCurrentNode(
        _item: SchemaObject,
        _parentItem: SchemaObject | null,
        parentNode: Node | null,
    ): Node | null {
        return parentNode;
    }

    override extractFunctions(item: SchemaObject): FunctionTypeItem[] {
        return this.getChildren(item).flatMap((child) =>
            getParser(child.className)!.extractFunctions(child),
        );
    }
}

class ConditionParser extends XmlPlanHierarchyParser {
    override extractFunctions(item: SchemaObject): FunctionTypeItem[] {
        const udfs = item.values.get("UDF") as ClrArray | null;
        if (!udfs) return [];
        item.values.set("UDF", null);
        return udfs.items.map((fn) => ({ function: fn as SchemaObject, type: "udf" as const }));
    }
}

const PARSERS = {
    relOp: new RelOpTypeParser(),
    statement: new StatementParser(),
    relOpBase: new RelOpBaseTypeParser(),
    filter: new FilterTypeParser(),
    merge: new MergeTypeParser(),
    cursorStatement: new CursorStatementParser(),
    cursorOperation: new CursorOperationParser(),
    hierarchy: new XmlPlanHierarchyParser(),
    condition: new ConditionParser(),
    function: new FunctionTypeParser(),
    indexOp: new IndexOpTypeParser(),
};

/** XmlPlanParserFactory.GetParser: by the type, else by its base types. */
function getParser(typeName: string): XmlPlanParser | null {
    for (
        let type: string | undefined = typeName;
        type && isSchemaClass(type);
        type = schemaClass(type).base
    ) {
        switch (type) {
            case "RelOpType":
                return PARSERS.relOp;
            case "BaseStmtInfoType":
                return PARSERS.statement;
            case "RelOpBaseType":
                return PARSERS.relOpBase;
            case "FilterType":
                return PARSERS.filter;
            case "MergeType":
                return PARSERS.merge;
            case "StmtCursorType":
                return PARSERS.cursorStatement;
            case "CursorPlanTypeOperation":
                return PARSERS.cursorOperation;
            case "StmtBlockType":
            case "QueryPlanType":
            case "CursorPlanType":
            case "ReceivePlanTypeOperation":
            case "StmtCondTypeThen":
            case "StmtCondTypeElse":
                return PARSERS.hierarchy;
            case "StmtCondTypeCondition":
                return PARSERS.condition;
            case "FunctionType":
                return PARSERS.function;
            case "IndexScanType":
            case "CreateIndexType":
                return PARSERS.indexOp;
        }
    }
    return null;
}

/** XmlPlanParser.Parse: creates the item's node (or fills its parent's), then its children's. */
function parseItem(
    item: SchemaObject,
    parentItem: SchemaObject | null,
    parentNode: Node | null,
    context: NodeBuilderContext,
) {
    const parser = getParser(clrTypeName(item));
    if (!parser) throw new Error(SR.UnexpectedRunType);
    let node: Node | null;
    if (parser.shouldParseItem(item)) {
        node = parser.getCurrentNode(item, parentItem, parentNode, context);
        if (node) {
            if (!context.graph.nodeStmtMap.has(node)) context.graph.nodeStmtMap.set(node, item);
            parser.parseProperties(item, node.properties);
        }
        if (parentNode === null) context.graph.root = node;
    } else {
        node = parentNode;
    }
    for (const child of parser.getChildren(item)) parseItem(child, item, node, context);
    if (node !== parentNode && node !== null) {
        parser.setNodeSpecialProperties(node);
        parentNode?.addChild(node);
    }
}

// ---------------------------------------------------------------------------------------------
// XmlPlanNodeBuilder
// ---------------------------------------------------------------------------------------------

/** Parses a showplan document into one graph per statement (XmlPlanNodeBuilder.Execute). */
export function parseShowPlanGraphs(xml: string): ShowPlanGraph[] {
    const plan = deserializeShowPlan(parseXml(xml));
    const graphs: ShowPlanGraph[] = [];
    for (const statement of enumStatements(plan)) {
        let currentNodeId = 0;
        const context: NodeBuilderContext = {
            graph: new ShowPlanGraph(),
            nextNodeId: () => ++currentNodeId,
        };
        parseItem(statement, null, null, context);
        context.graph.missingIndexes = parseMissingIndexes(statement);
        graphs.push(context.graph);
    }
    return graphs;
}

/** Statements of every batch, with UDFs and stored procedures moved to statements of their own. */
function enumStatements(plan: SchemaObject): SchemaObject[] {
    const statements: SchemaObject[] = [];
    const batches = plan.values.get("BatchSequence") as ClrArray | null;
    for (const batch of (batches?.items ?? []) as ClrArray[]) {
        for (const block of batch.items as SchemaObject[]) {
            extractBlockFunctions(block);
            statements.push(
                ...(((block.values.get("Items") as ClrArray | null)?.items ??
                    []) as SchemaObject[]),
            );
        }
    }
    return statements;
}

function extractBlockFunctions(block: SchemaObject) {
    const items = block.values.get("Items") as ClrArray | null;
    if (!items) return;
    const target: SchemaObject[] = [];
    for (const statement of items.items as SchemaObject[]) {
        target.push(statement);
        extractFunctions(statement, target);
    }
    block.values.set("Items", new ClrArray(items.elementType, target));
}

/** Each UDF and stored procedure gets an empty wrapper statement placed after its statement. */
function extractFunctions(statement: SchemaObject, target: SchemaObject[]) {
    const parser = getParser(statement.className)!;
    for (const functionItem of parser.extractFunctions(statement)) {
        const values = new Map<string, unknown>();
        for (const member of serializationMembers("StmtSimpleType"))
            values.set(member.name, defaultValue(member.type));
        values.set("StatementIdSpecified", false);
        if (functionItem.type === "storedProcedure")
            values.set("StoredProc", functionItem.function);
        else values.set("UDF", new ClrArray("FunctionType", [functionItem.function]));
        target.push(new SchemaObject("StmtSimpleType", values, "StmtSimple"));

        const statements = functionItem.function.values.get("Statements") as SchemaObject | null;
        const items = statements?.values.get("Items") as ClrArray | null | undefined;
        for (const functionStatement of (items?.items ?? []) as SchemaObject[])
            extractFunctions(functionStatement, target);
    }
}

// ---------------------------------------------------------------------------------------------
// Description: missing indexes
// ---------------------------------------------------------------------------------------------

interface SerializedElement {
    name: string;
    object?: SchemaObject;
    array?: ClrArray;
}

/**
 * The elements under a statement in the order XmlSerializer writes them (sqltoolsservice searches
 * the statement re-serialized on its own, so extracted functions are no longer under it).
 */
function* serializedElements(object: SchemaObject): Generator<SerializedElement> {
    for (const member of serializationMembers(object.className)) {
        const value = object.values.get(member.name);
        if (value === null || value === undefined) continue;
        if (member.array !== undefined) {
            const array = value as ClrArray;
            yield { name: member.array, array };
            for (const item of array.items) {
                if (item instanceof SchemaObject) {
                    yield { name: member.arrayItem!, object: item };
                    yield* serializedElements(item);
                } else if (item instanceof ClrArray) {
                    yield { name: member.arrayItem!, array: item };
                    for (const inner of item.items as SchemaObject[]) {
                        yield { name: member.arrayItemNested!, object: inner };
                        yield* serializedElements(inner);
                    }
                }
            }
        } else if (member.elements && !member.ignore) {
            const items = value instanceof ClrArray ? value.items : [value];
            for (const item of items) {
                if (!(item instanceof SchemaObject)) continue;
                const name = member.elements.length > 1 ? item.elementName : member.elements[0][0];
                yield { name, object: item };
                yield* serializedElements(item);
            }
        }
    }
}

function parseMissingIndexes(statement: SchemaObject): MissingIndex[] {
    const elements = [...serializedElements(statement)];
    const missingIndexes = elements.find((e) => e.name === "MissingIndexes");
    if (!missingIndexes) return [];

    // A memory-optimized table gets an index added to it rather than created.
    const scan =
        elements.find((e) => e.name === "IndexScan") ??
        elements.find((e) => e.name === "TableScan");
    const storage = scan?.object?.values.get("Storage");
    const memoryOptimized =
        scan?.object?.values.get("StorageSpecified") === true &&
        storage instanceof ClrEnum &&
        enumXmlValue(storage.enumType, storage.member) === "MemoryOptimized";

    // Environment.NewLine in the C#: "\n" as sqltoolsservice on Linux gives it (the reference
    // capture); on Windows it is "\r\n".
    const createIndexTemplate =
        "CREATE NONCLUSTERED INDEX [<Name of Missing Index, sysname,>]\nON {0}.{1} ({2})\n";
    const addIndexTemplate =
        "ALTER TABLE {0}.{1}\nADD INDEX [<Name of Missing Index, sysname,>]\nNONCLUSTERED ({2})\n";
    const result: MissingIndex[] = [];
    for (const group of (missingIndexes.array?.items ?? []) as SchemaObject[]) {
        // One missing index per group.
        const missingIndex = ((group.values.get("MissingIndex") as ClrArray | null)?.items ??
            [])[0] as SchemaObject | undefined;
        if (!missingIndex) throw new Error("Object reference not set to an instance of an object.");
        const database = missingIndex.values.get("Database") as string;
        const schemaName = missingIndex.values.get("Schema") as string;
        const tableName = missingIndex.values.get("Table") as string;
        let indexColumns = "";
        let includeColumns = "";
        for (const columnGroup of ((missingIndex.values.get("ColumnGroup") as ClrArray | null)
            ?.items ?? []) as SchemaObject[]) {
            const usage = columnGroup.values.get("Usage") as ClrEnum;
            for (const column of ((columnGroup.values.get("Column") as ClrArray | null)?.items ??
                []) as SchemaObject[]) {
                const columnName = column.values.get("Name") as string;
                if (enumXmlValue(usage.enumType, usage.member) !== "INCLUDE") {
                    indexColumns =
                        indexColumns === "" ? columnName : `${indexColumns},${columnName}`;
                } else if (!memoryOptimized) {
                    includeColumns =
                        includeColumns === "" ? columnName : `${includeColumns},${columnName}`;
                }
            }
        }
        let queryText = format(
            memoryOptimized ? addIndexTemplate : createIndexTemplate,
            schemaName,
            tableName,
            indexColumns,
        );
        if (includeColumns) queryText += `INCLUDE (${includeColumns})`;
        const impact = xmlConvertDouble((group.values.get("Impact") as ClrNumber).value);
        result.push({
            caption: format(SR.MissingIndexFormat, impact, queryText),
            queryText,
            impact,
            database,
        });
    }
    return result;
}
