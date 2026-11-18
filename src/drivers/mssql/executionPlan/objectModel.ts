/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Port of sqltoolsservice's ShowPlan/PropertyValue.cs, PropertyFactory.cs, Attributes.cs (the type
 * converters), ObjectParser.cs, ExpandableObjectWrapper.cs, ExpandableArrayWrapper.cs,
 * RunTimeCounters.cs and ObjectWrapperTypeConverter.cs. The C# finds properties and converters by
 * reflection (TypeDescriptor); here the property lists come from showplanSchema.generated.ts and
 * the converters are dispatched on the CLR type a value keeps (clr.ts).
 */

import {
    ClrArray,
    ClrDateTime,
    ClrEnum,
    ClrNumber,
    ClrXmlAttribute,
    ClrXmlElement,
    clrToString,
    clrTypeName,
    format,
    formatDateTimeShort,
    formatDouble,
    formatFixed,
    roundHalfEven,
    SchemaObject,
} from "./clr";
import { isEnum, type ReflectedMember, reflectedMembers } from "./deserialize";
import { SR } from "./showplanStrings.generated";

/** BetterValue of Attributes.cs (same numbers as the page's ExecutionPlanGraphElementPropertyBetterValue). */
export enum BetterValue {
    LowerNumber = 0,
    HigherNumber = 1,
    True = 2,
    False = 3,
    None = 4,
}

/** CultureInfo.CurrentCulture.TextInfo.ListSeparator in en-US. */
export const LIST_SEPARATOR = ",";

// ---------------------------------------------------------------------------------------------
// PropertyFactory: the property templates
// ---------------------------------------------------------------------------------------------

interface Template {
    /** DisplayNameDescription's display name key (SR); without it the name is the property name. */
    key?: string;
    /** DisplayOrder; Int32.MaxValue without it. */
    order?: number;
    /** ShowInToolTip, and whether it is a LongString. */
    tooltip?: "yes" | "long";
    better?: BetterValue;
    converter?: "float" | "dataSize" | "kbSize";
    browsable?: false;
}

/** The public properties of PropertyFactory.cs, with their attributes, in declaration order. */
const TEMPLATES: Record<string, Template> = {
    PhysicalOp: { key: "PhysicalOperation", order: 0, tooltip: "yes" },
    LogicalOp: { key: "LogicalOperation", order: 1, tooltip: "yes" },
    EstimatedExecutionMode: { key: "EstimatedExecMode", order: 2, tooltip: "yes" },
    ActualExecutionMode: { key: "ActualExecMode", order: 2, tooltip: "yes" },
    Storage: { key: "Storage", order: 3, tooltip: "yes" },
    EstimatedDataSize: {
        key: "EstimatedDataSize",
        order: 102,
        tooltip: "yes",
        converter: "dataSize",
    },
    ActualRows: { key: "NumberOfRows", order: 4, tooltip: "yes" },
    ActualRowsRead: {
        key: "ActualRowsRead",
        order: 4,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualBatches: {
        key: "NumberOfBatches",
        order: 5,
        tooltip: "yes",
        better: BetterValue.HigherNumber,
    },
    StatementText: { key: "Statement", order: 6, tooltip: "long" },
    Predicate: { key: "Predicate", order: 6, tooltip: "long" },
    AvgRowSize: { key: "EstimatedRowSize", order: 101, tooltip: "yes", converter: "dataSize" },
    CachedPlanSize: {
        key: "CachedPlanSize",
        order: 7,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
        converter: "kbSize",
    },
    UsePlan: { key: "UsePlan", order: 7, tooltip: "yes", better: BetterValue.True },
    ContainsInlineScalarTsqlUdfs: { key: "ContainsInlineScalarTsqlUdfs", order: 7, tooltip: "yes" },
    EstimateIO: {
        key: "EstimatedIoCost",
        order: 8,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
        converter: "float",
    },
    DegreeOfParallelism: {
        key: "DegreeOfParallelism",
        order: 8,
        tooltip: "yes",
        better: BetterValue.HigherNumber,
    },
    EffectiveDegreeOfParallelism: {
        key: "EffectiveDegreeOfParallelism",
        order: 8,
        tooltip: "yes",
        better: BetterValue.HigherNumber,
    },
    EstimateCPU: {
        key: "EstimatedCpuCost",
        order: 9,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
        converter: "float",
    },
    MemoryGrant: {
        key: "MemoryGrant",
        order: 9,
        tooltip: "yes",
        better: BetterValue.HigherNumber,
        converter: "kbSize",
    },
    ParameterList: { key: "ParameterList", order: 10 },
    ActualExecutions: {
        key: "NumberOfExecutions",
        order: 10,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
        converter: "float",
    },
    EstimateExecutions: {
        key: "EstimatedNumberOfExecutions",
        order: 10,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
        converter: "float",
    },
    Object: { key: "ObjectShort", order: 12, tooltip: "long" },
    IndexKind: { key: "IndexKind", order: 203 },
    Argument: { key: "OperationArgumentShort", order: 12 },
    ActualRebinds: {
        key: "ActualRebinds",
        order: 111,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualRewinds: {
        key: "ActualRewinds",
        order: 112,
        tooltip: "yes",
        better: BetterValue.HigherNumber,
    },
    ActualLocallyAggregatedRows: { key: "ActualLocallyAggregatedRows", order: 221, tooltip: "yes" },
    ActualElapsedms: {
        key: "ActualElapsedms",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualCPUms: {
        key: "ActualCPUms",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualScans: {
        key: "ActualScans",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualLogicalReads: {
        key: "ActualLogicalReads",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualPhysicalReads: {
        key: "ActualPhysicalReads",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualPageServerReads: {
        key: "ActualPageServerReads",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualReadAheads: {
        key: "ActualReadAheads",
        order: 221,
        tooltip: "yes",
        better: BetterValue.HigherNumber,
    },
    ActualPageServerReadAheads: {
        key: "ActualPageServerReadAheads",
        order: 221,
        tooltip: "yes",
        better: BetterValue.HigherNumber,
    },
    ActualLobLogicalReads: {
        key: "ActualLobLogicalReads",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualLobPhysicalReads: {
        key: "ActualLobPhysicalReads",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualLobPageServerReads: {
        key: "ActualLobPageServerReads",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualLobReadAheads: {
        key: "ActualLobReadAheads",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualLobPageServerReadAheads: {
        key: "ActualLobPageServerReadAheads",
        order: 221,
        tooltip: "yes",
        better: BetterValue.HigherNumber,
    },
    ActualIOStatistics: {
        key: "ActualIOStatistics",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualTimeStatistics: {
        key: "ActualTimeStatistics",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    ActualMemoryGrantStats: {
        key: "ActualMemoryGrantStats",
        order: 221,
        better: BetterValue.HigherNumber,
    },
    HpcRowCount: { key: "HpcRowCount", order: 221, tooltip: "yes" },
    HpcKernelElapsedUs: {
        key: "HpcKernelElapsedUs",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    HpcHostToDeviceBytes: {
        key: "HpcHostToDeviceBytes",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    HpcDeviceToHostBytes: {
        key: "HpcDeviceToHostBytes",
        order: 221,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    InputMemoryGrant: { key: "InputMemoryGrant", order: 221, better: BetterValue.LowerNumber },
    OutputMemoryGrant: { key: "OutputMemoryGrant", order: 221, better: BetterValue.LowerNumber },
    UsedMemoryGrant: { key: "UsedMemoryGrant", order: 221, better: BetterValue.LowerNumber },
    IsGraphDBTransitiveClosure: { key: "IsGraphDBTransitiveClosure", order: 2, tooltip: "yes" },
    IsInterleavedExecuted: { key: "IsInterleavedExecuted", order: 2, tooltip: "yes" },
    IsAdaptive: { key: "IsAdaptive", order: 2, tooltip: "yes" },
    AdaptiveThresholdRows: {
        key: "AdaptiveThresholdRows",
        order: 2,
        tooltip: "yes",
        converter: "float",
    },
    EstimatedJoinType: { key: "EstimatedJoinType", order: 2, tooltip: "yes" },
    ActualJoinType: { key: "ActualJoinType", order: 2, tooltip: "yes" },
    EstimateRows: {
        key: "EstimatedNumberOfRowsPerExecution",
        order: 100,
        tooltip: "yes",
        converter: "float",
    },
    StatementEstRows: {
        key: "EstimatedNumberOfRowsPerExecution",
        order: 100,
        tooltip: "yes",
        converter: "float",
    },
    EstimateRowsAllExecs: {
        key: "EstimatedNumberOfRowsForAllExecutions",
        order: 100,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
        converter: "float",
    },
    StatementEstRowsAllExecs: {
        key: "EstimatedNumberOfRowsForAllExecutions",
        order: 100,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
        converter: "float",
    },
    EstimatedRowsRead: {
        key: "EstimatedRowsRead",
        order: 100,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
        converter: "float",
    },
    EstimateRebinds: {
        key: "EstimatedRebinds",
        order: 101,
        better: BetterValue.LowerNumber,
        converter: "float",
    },
    EstimateRewinds: {
        key: "EstimatedRewinds",
        order: 102,
        better: BetterValue.HigherNumber,
        converter: "float",
    },
    DefinedValues: { key: "DefinedValues", order: 200 },
    OutputList: { key: "OutputList", order: 201, tooltip: "long" },
    Warnings: { key: "Warnings", order: 202, tooltip: "long" },
    Parallel: { key: "Parallel", order: 203, better: BetterValue.True },
    StatementSetOptions: { key: "SetOptions", order: 204 },
    StatementOptmLevel: { key: "OptimizationLevel", order: 205 },
    StatementOptmEarlyAbortReason: { key: "StatementOptmEarlyAbortReason", order: 206 },
    MemoryFractions: { key: "MemoryFractions", order: 211, better: BetterValue.LowerNumber },
    Input: { key: "MemoryFractionsInput", order: 211, converter: "float" },
    Output: { key: "MemoryFractionsOutput", order: 212, converter: "float" },
    RemoteDestination: { key: "RemoteDestination", order: 203, tooltip: "long" },
    RemoteObject: { key: "RemoteObject", order: 203, tooltip: "long" },
    RemoteSource: { key: "RemoteSource", order: 203, tooltip: "long" },
    RemoteQuery: { key: "RemoteQuery", order: 203, tooltip: "long" },
    UsedUDXColumns: { key: "UsedUdxColumns", order: 203 },
    UDXName: { key: "UdxName", order: 204, tooltip: "yes" },
    InnerSideJoinColumns: { key: "InnerSideJoinColumns", order: 203, tooltip: "long" },
    OuterSideJoinColumns: { key: "OuterSideJoinColumns", order: 204, tooltip: "long" },
    Residual: { key: "Residual", order: 205 },
    PassThru: { key: "PassThru", order: 206, tooltip: "long" },
    ManyToMany: { key: "ManyToMany", order: 207, tooltip: "yes" },
    PartitionColumns: { key: "PartitionColumns", order: 203, tooltip: "long" },
    OrderBy: { key: "OrderBy", order: 204, tooltip: "long" },
    HashKeys: { key: "HashKeys", order: 205, tooltip: "long" },
    ProbeColumn: { key: "ProbeColumn", order: 206, tooltip: "yes" },
    PartitioningType: { key: "PartitioningType", order: 207, tooltip: "yes" },
    GroupBy: { key: "GroupBy", order: 203, tooltip: "long" },
    GroupingSets: { key: "GroupingSets", order: 203, tooltip: "long" },
    RollupInfo: { key: "RollupInfo", order: 200 },
    HighestLevel: { key: "HighestLevel", order: 6 },
    RollupLevel: { key: "RollupLevel", order: 6 },
    Level: { key: "Level", order: 6 },
    SegmentColumn: { key: "SegmentColumn", order: 203, tooltip: "yes" },
    HashKeysBuild: { key: "HashKeysBuild", order: 203 },
    HashKeysProbe: { key: "HashKeysProbe", order: 203, tooltip: "long" },
    BuildResidual: { key: "BuildResidual", order: 203, tooltip: "long" },
    ProbeResidual: { key: "ProbeResidual", order: 203, tooltip: "long" },
    SetPredicate: { key: "SetPredicate", order: 203, tooltip: "long" },
    RankColumns: { key: "RankColumns", order: 203 },
    ActionColumn: { key: "ActionColumn", order: 203, tooltip: "yes" },
    OriginalActionColumn: { key: "OriginalActionColumn", order: 203, tooltip: "yes" },
    Rows: { key: "Rows", order: 203 },
    Partitioned: { key: "Partitioned", order: 150, tooltip: "yes" },
    PartitionsAccessed: { key: "PartitionsAccessed", order: 156, better: BetterValue.LowerNumber },
    PartitionCount: {
        key: "PartitionCount",
        order: 152,
        tooltip: "yes",
        better: BetterValue.LowerNumber,
    },
    TieColumns: { key: "TieColumns", order: 203, tooltip: "long" },
    IsPercent: { key: "IsPercent", order: 203, tooltip: "yes" },
    WithTies: { key: "WithTies", order: 203 },
    TopExpression: { key: "TopExpression", order: 203, tooltip: "long" },
    Distinct: { key: "Distinct", order: 203 },
    OuterReferences: { key: "OuterReferences", order: 205, tooltip: "long" },
    PartitionId: { key: "PartitionId", order: 203, tooltip: "yes" },
    Ordered: { key: "Ordered", order: 203, tooltip: "yes" },
    ScanDirection: { key: "ScanDirection", order: 203 },
    SeekPredicate: { key: "SeekPredicate", order: 203, tooltip: "long" },
    SeekPredicateNew: { key: "SeekPredicate", order: 203, tooltip: "long" },
    SeekPredicatePart: { key: "SeekPredicate", order: 203, tooltip: "long" },
    SeekPredicates: { key: "SeekPredicates", order: 205, tooltip: "long" },
    ForcedIndex: { key: "ForcedIndex", order: 203 },
    Values: { key: "Values", order: 5, tooltip: "long" },
    ColumnsWithNoStatistics: { key: "ColumnsWithNoStatistics", order: 203 },
    NoJoinPredicate: { key: "NoJoinPredicate", order: 203 },
    SpillToTempDb: { key: "SpillToTempDb", order: 203 },
    StartupExpression: { key: "StartupExpression", order: 203 },
    Query: { key: "Query", order: 203 },
    Stack: { key: "Stack", order: 203 },
    RowCount: { key: "RowCount", order: 203, tooltip: "yes" },
    Optimized: { key: "Optimized", order: 6, better: BetterValue.True },
    WithPrefetch: { key: "WithPrefetch", order: 6 },
    Prefix: { key: "Prefix", order: 6 },
    StartRange: { key: "StartRange", order: 7 },
    EndRange: { key: "EndRange", order: 8 },
    RangeColumns: { key: "RangeColumns", order: 6 },
    RangeExpressions: { key: "RangeExpressions", order: 6 },
    ScanType: { key: "ScanType", order: 6 },
    ColumnReference: { key: "ColumnReference", order: 6 },
    Server: { key: "ObjectServer", order: 6 },
    Database: { key: "ObjectDatabase", order: 6 },
    Index: { key: "ObjectIndex", order: 6 },
    Schema: { key: "ObjectSchema", order: 6 },
    Table: { key: "ObjectTable", order: 6 },
    Alias: { key: "ObjectAlias", order: 6 },
    Column: { key: "ObjectColumn", order: 6 },
    ComputedColumn: { key: "ObjectComputedColumn", order: 6 },
    ParameterDataType: { key: "ParameterDataType", order: 6 },
    ParameterCompiledValue: { key: "ParameterCompiledValue", order: 6 },
    ParameterRuntimeValue: { key: "ParameterRuntimeValue", order: 6 },
    CursorPlan: { key: "CursorPlan", order: 6 },
    Operation: { key: "CursorOperation", order: 6 },
    CursorName: { key: "CursorName", order: 6 },
    CursorActualType: { key: "CursorActualType", order: 6 },
    CursorRequestedType: { key: "CursorRequestedType", order: 6 },
    CursorConcurrency: { key: "CursorConcurrency", order: 6 },
    ForwardOnly: { key: "ForwardOnly", order: 6 },
    QueryPlan: { key: "QueryPlan", order: 6 },
    OperationType: { key: "OperationType", order: 6 },
    NodeId: { key: "NodeId", order: 300, tooltip: "yes", better: BetterValue.None },
    PrimaryNodeId: { key: "PrimaryNodeId", order: 301, tooltip: "yes" },
    ForeignKeyReferencesCount: { key: "ForeignKeyReferencesCount", order: 302, tooltip: "yes" },
    NoMatchingIndexCount: { key: "NoMatchingIndexCount", order: 303, tooltip: "yes" },
    PartialMatchingIndexCount: { key: "PartialMatchingIndexCount", order: 304, tooltip: "yes" },
    WhereJoinColumns: { key: "WhereJoinColumns", order: 6, tooltip: "long" },
    ProcName: { key: "ProcName", order: 6, tooltip: "long" },
    InternalInfo: { key: "InternalInfo", order: 400 },
    RemoteDataAccess: { key: "RemoteDataAccess", order: 220, tooltip: "yes" },
    CloneAccessScope: { key: "CloneAccessScope", order: 220 },
    Remoting: { key: "Remoting", order: 220, tooltip: "yes" },
    Activation: { key: "Activation", order: 201 },
    BrickRouting: { key: "BrickRouting", order: 201 },
    FragmentIdColumn: { key: "FragmentIdColumn", order: 201 },
    CardinalityEstimationModelVersion: {},
    CompileCPU: { better: BetterValue.LowerNumber },
    CompileMemory: { better: BetterValue.LowerNumber },
    CompileTime: { better: BetterValue.LowerNumber },
    NonParallelPlanReason: {},
    QueryHash: {},
    QueryPlanHash: {},
    RetrievedFromCache: {},
    SecurityPolicyApplied: {},
    NoExpandHint: {},
    TableCardinality: {},
    EstimatedAvailableMemoryGrant: { better: BetterValue.HigherNumber },
    SerialRequiredMemory: { better: BetterValue.LowerNumber },
    SerialDesiredMemory: { better: BetterValue.LowerNumber },
    RequiredMemory: { better: BetterValue.LowerNumber },
    DesiredMemory: { better: BetterValue.LowerNumber },
    RequestedMemory: { better: BetterValue.LowerNumber },
    GrantWaitTime: { better: BetterValue.LowerNumber },
    GrantedMemory: { better: BetterValue.LowerNumber },
    MaxUsedMemory: { better: BetterValue.LowerNumber },
    MaxQueryMemory: { better: BetterValue.LowerNumber },
    WaitTimeMs: { better: BetterValue.LowerNumber },
    WaitCount: { better: BetterValue.LowerNumber },
    CpuTime: { better: BetterValue.LowerNumber },
    ElapsedTime: { better: BetterValue.LowerNumber },
    PhysicalOperationKind: { browsable: false },
    EstimatedTotalSubtreeCost: { browsable: false },
    StatementSubTreeCost: { browsable: false },
    TotalSubtreeCost: { browsable: false },
    Parent: { browsable: false },
    StatementId: { browsable: false },
    StatementCompId: { browsable: false },
    RunTimeInformation: { browsable: false },
    StatementType: { browsable: false },
    RunTimePartitionSummary: { browsable: false },
    SkeletonNode: { browsable: false },
    SkeletonHasMatch: { browsable: false },
};

const INT32_MAX = 2147483647;

// ---------------------------------------------------------------------------------------------
// PropertyValue
// ---------------------------------------------------------------------------------------------

/** A property of a node, an edge or a wrapper: PropertyValue.cs. */
export class PropertyValue {
    private displayNameOverride: string | undefined;

    constructor(
        /** Name the bag finds it by (PropertyDescriptor.Name). */
        readonly name: string,
        public value: unknown,
        private readonly template?: Template,
    ) {}

    get displayName(): string {
        if (this.displayNameOverride !== undefined) return this.displayNameOverride;
        if (this.template?.key) return SR[this.template.key];
        return this.name;
    }

    /** SetDisplayNameAndDescription (only the name is shown). */
    setDisplayName(displayName: string) {
        this.displayNameOverride = displayName;
    }

    get displayOrder(): number {
        return this.template?.order ?? INT32_MAX;
    }

    get showInTooltip(): boolean {
        return this.template?.tooltip !== undefined;
    }

    get isLongString(): boolean {
        return this.template?.tooltip === "long";
    }

    get betterValue(): BetterValue {
        return this.template?.better ?? BetterValue.None;
    }

    get isBrowsable(): boolean {
        return this.template?.browsable !== false;
    }

    /** Converter.ConvertToString(Value): the template's TypeConverter, else the value type's one. */
    get displayValue(): string {
        return convertToString(this.value, this.template?.converter);
    }
}

/** PropertyDescriptorCollection: an ordered bag; finding by name returns the first match. */
export class PropertyBag {
    readonly items: PropertyValue[] = [];

    add(property: PropertyValue | null) {
        if (property) this.items.push(property);
    }

    find(name: string): PropertyValue | undefined {
        return this.items.find((p) => p.name === name);
    }

    /** this[name] getter of Node, Edge and ExpandableObjectWrapper. */
    get(name: string): unknown {
        return this.find(name)?.value ?? null;
    }

    get count(): number {
        return this.items.length;
    }
}

/** PropertyFactory.CreateProperty(string, object). */
export function createNamedProperty(name: string, value: unknown): PropertyValue {
    const template = Object.prototype.hasOwnProperty.call(TEMPLATES, name)
        ? TEMPLATES[name]
        : undefined;
    return new PropertyValue(name, value, template);
}

function templateOf(name: string): Template | undefined {
    return Object.prototype.hasOwnProperty.call(TEMPLATES, name) ? TEMPLATES[name] : undefined;
}

/** A property as reflection describes it: what ParseProperties and CreateProperty look at. */
export interface PropertyInfo {
    name: string;
    /** Declared CLR type. */
    type: string;
    ignore?: boolean;
    /** [XmlElement] names and types, for the name of a choice group's value. */
    elements?: string[][];
}

/** PropertyFactory.CreateProperty(PropertyDescriptor, object). */
export function createProperty(property: PropertyInfo, value: unknown): PropertyValue | null {
    // A choice group's value: its runtime type finds its element name.
    const choiceType =
        property.name === "Items" || property.name === "Item" ? clrTypeName(value) : undefined;

    if (canConvertFrom(property.type)) value = convertFrom(value);
    if (value === null || value === undefined) return null;

    const template = templateOf(property.name);
    if (template) return new PropertyValue(property.name, value, template);

    let propertyName = property.name;
    for (const [elementName, elementType] of property.elements ?? []) {
        if (!elementName) continue;
        if (choiceType === undefined || choiceType === elementType) {
            propertyName = elementName;
            const named = templateOf(propertyName);
            if (named) return new PropertyValue(propertyName, value, named);
        }
    }
    return new PropertyValue(propertyName, value);
}

// ---------------------------------------------------------------------------------------------
// Type converters (Attributes.cs) and the default converters of .NET types
// ---------------------------------------------------------------------------------------------

const SIZE_FORMATS = [
    "SizeInBytesFormat",
    "SizeInKiloBytesFormat",
    "SizeInMegaBytesFormat",
    "SizeInGigaBytesFormat",
    "SizeInTeraBytesFormat",
];

function convertToString(value: unknown, converter: Template["converter"]): string {
    if (value === null || value === undefined) return "";
    if (converter && value instanceof ClrNumber) {
        if (converter === "float") return formatFixed(value.value, 7);
        // DataSizeTypeConverter: no more than 4 digits, in B, KB, MB…; KBSizeTypeConverter starts at KB.
        let size = value.value;
        let index = converter === "kbSize" ? 1 : 0;
        while (index < SIZE_FORMATS.length - 1) {
            if (roundHalfEven(size) < 10000) break;
            size /= 1024;
            index++;
        }
        return format(SR[SIZE_FORMATS[index]], new ClrNumber("ulong", roundHalfEven(size)));
    }
    if (value instanceof ClrDateTime) return formatDateTimeShort(value);
    if (value instanceof ClrNumber && value.type === "double") return formatDouble(value.value);
    return clrToString(value);
}

/** dataType the page gets: the runtime type of a property value. */
export function dataTypeOf(value: unknown): number {
    if (value instanceof ClrNumber) return 0;
    if (typeof value === "boolean") return 2;
    return 1;
}

// ---------------------------------------------------------------------------------------------
// ObjectParser, ExpandableObjectWrapper, ExpandableArrayWrapper
// ---------------------------------------------------------------------------------------------

/** MergeColumns is a class of MergeTypeParser.cs, not of the schema. */
const MERGE_COLUMNS_MEMBERS: PropertyInfo[] = [
    { name: "InnerSideJoinColumns", type: "ColumnReferenceType[]" },
    { name: "OuterSideJoinColumns", type: "ColumnReferenceType[]" },
];

/** TypeDescriptor.GetProperties(item) of an object read from the plan. */
export function propertiesOf(item: SchemaObject): (ReflectedMember | PropertyInfo)[] {
    return item.className === "MergeColumns"
        ? MERGE_COLUMNS_MEMBERS
        : reflectedMembers(item.className);
}

/** TypeCode.Object: classes, arrays and object (not strings, numbers, enums, DateTime). */
export function isObjectTypeCode(type: string): boolean {
    if (type.endsWith("[]")) return true;
    return (
        !["string", "bool", "int", "ulong", "double", "System.DateTime"].includes(type) &&
        !isEnum(type)
    );
}

/**
 * ObjectParser.ParseProperties: one property per non-null, specified property of `item`, skipping
 * what `shouldSkip` says is a child item; each value of a choice group becomes its own property.
 */
export function parseProperties(
    item: SchemaObject,
    target: PropertyBag,
    shouldSkip: (property: PropertyInfo) => boolean = () => false,
) {
    const all = propertiesOf(item);
    for (const property of all) {
        if (property.ignore) continue;
        if (
            all.some((p) => p.name === property.name + "Specified") &&
            item.values.get(property.name + "Specified") === false
        ) {
            continue;
        }
        const value = item.values.get(property.name);
        if (value === null || value === undefined) continue;
        if (isObjectTypeCode(property.type) && shouldSkip(property)) continue;
        if ((property.name === "Items" || property.name === "Item") && value instanceof ClrArray) {
            for (const element of value.items) target.add(createProperty(property, element));
        } else {
            target.add(createProperty(property, value));
        }
    }
}

/** ExpandableObjectWrapper: a nested property whose value is a list of properties. */
export class ObjectWrapper {
    readonly properties = new PropertyBag();
    displayName: string;

    constructor(item?: SchemaObject | null, displayName?: string) {
        if (item) parseProperties(item, this.properties);
        // GetDefaultDisplayName: a schema object's ToString() is its type name, which gives "".
        this.displayName = displayName ?? "";
    }

    get(name: string): unknown {
        return this.properties.get(name);
    }

    /** this[name] setter: overwrites the first property of that name, or adds one. */
    set(name: string, value: unknown) {
        const existing = this.properties.find(name);
        if (existing) existing.value = value;
        else this.properties.add(new PropertyValue(name, value));
    }

    toString(): string {
        return this.displayName;
    }
}

/** ExpandableArrayWrapper: properties "[1]", "[2]"… for the convertible items of a collection. */
export class ArrayWrapper extends ObjectWrapper {
    constructor(collection: unknown[]) {
        super();
        const parts: string[] = [];
        let index = 0;
        for (const item of collection) {
            if (!canConvertFrom(clrTypeName(item))) continue;
            const converted = convertFrom(item);
            if (converted === null || converted === undefined) continue;
            this.set(`[${++index}]`, converted);
            parts.push(clrToString(converted));
        }
        // StringBuilder appends a separator only once something non-empty was written.
        let text = "";
        for (const part of parts) {
            if (text.length > 0) text += LIST_SEPARATOR + " ";
            text += part;
        }
        this.displayName = text;
    }
}

// ---------------------------------------------------------------------------------------------
// RunTimeCounters
// ---------------------------------------------------------------------------------------------

/** Per-thread counters of an actual plan; shows their total (or their maximum, for times). */
export class RunTimeCounters {
    private readonly counters: { thread: number; value: number }[] = [];
    totalCounters = 0;
    maxCounter = 0;

    constructor(
        readonly displayTotalCounters = true,
        /** MemGrantRunTimeCounters: thread 0's grant is not counted when there are several threads. */
        private readonly memoryGrant = false,
    ) {}

    addCounter(thread: number, value: number) {
        this.counters.push({ thread, value });
        this.totalCounters += value;
        if (value > this.maxCounter) this.maxCounter = value;
    }

    get numOfCounters(): number {
        return this.counters.length;
    }

    toString(): string {
        if (this.memoryGrant) {
            let value = this.totalCounters;
            if (this.counters.length > 1) {
                const thread0 = this.counters.find((c) => c.thread === 0);
                if (thread0) value -= thread0.value;
            }
            return String(value);
        }
        return String(this.displayTotalCounters ? this.totalCounters : this.maxCounter);
    }
}

// ---------------------------------------------------------------------------------------------
// ObjectWrapperTypeConverter
// ---------------------------------------------------------------------------------------------

/** Types that have a Convert method (exact runtime type match, as the C# dictionary does). */
const CONVERTERS: Record<string, (item: never) => unknown> = {
    ColumnReferenceType: convertColumnReference,
    GroupingSetReferenceType: (item: SchemaObject) =>
        new ObjectWrapper(item, (item.values.get("Value") as string) ?? ""),
    ObjectType: convertObject,
    SingleColumnReferenceType: (item: SchemaObject) =>
        convertColumnReference(item.values.get("ColumnReference") as SchemaObject),
    "DefinedValuesListTypeDefinedValue[]": convertDefinedValues,
    SetOptionsType: convertToWrapperObject,
    RollupLevelType: (item: SchemaObject) =>
        new ObjectWrapper(item, clrToString(item.values.get("Level"))),
    WarningsType: convertWarnings,
    MemoryFractionsType: convertToWrapperObject,
    "ScalarType[][]": convertScalarRows,
    ScalarType: convertScalar,
    ScalarExpressionType: (item: SchemaObject) => {
        const scalar = item.values.get("ScalarOperator") as SchemaObject | null;
        return scalar ? (scalar.values.get("ScalarString") as string | null) : "";
    },
    CompareType: convertCompare,
    OrderByTypeOrderByColumn: (item: SchemaObject) => {
        const wrapper = new ObjectWrapper(item);
        wrapper.displayName = `${clrToString(wrapper.get("ColumnReference"))} ${item.values.get("Ascending") ? SR.Ascending : SR.Descending}`;
        return wrapper;
    },
    ScanRangeType: convertScanRange,
    SeekPredicateType: (item: SchemaObject) => {
        const wrapper = new ObjectWrapper(item);
        wrapper.displayName = displayNameFromProperties(wrapper, [
            "Prefix",
            "StartRange",
            "EndRange",
        ]);
        return wrapper;
    },
    SeekPredicatesType: convertSeekPredicates,
    SeekPredicateNewType: convertSeekPredicateNew,
    SeekPredicatePartType: (item: SchemaObject) =>
        mergedArrayWrapper((item.values.get("Items") as ClrArray).items),
    MergeColumns: (item: SchemaObject) => {
        const wrapper = new ObjectWrapper(item);
        const inner = wrapper.get("InnerSideJoinColumns");
        const outer = wrapper.get("OuterSideJoinColumns");
        if (inner !== null && outer !== null)
            wrapper.displayName = `(${clrToString(inner)}) = (${clrToString(outer)})`;
        return wrapper;
    },
    BaseStmtInfoTypeStatementOptmEarlyAbortReason: (item: ClrEnum) =>
        ({
            TimeOut: SR.TimeOut,
            MemoryLimitExceeded: SR.MemoryLimitExceeded,
            GoodEnoughPlanFound: SR.GoodEnoughPlanFound,
        })[item.member] ?? item.member,
    CloneAccessScopeType: convertCloneAccessScope,
    InternalInfoType: convertInternalInfo,
    "System.Xml.XmlElement": (item: ClrXmlElement) => convertXmlElement(item),
    "System.Xml.XmlAttribute": (item: ClrXmlAttribute) => item.attribute.value,
};

/** CanConvertFrom: TypeCode.Object, an array, or a type with a Convert method. */
export function canConvertFrom(type: string): boolean {
    return isObjectTypeCode(type) || type in CONVERTERS;
}

/** ConvertFrom: the Convert method of the value's runtime type, else a generic wrapper. */
export function convertFrom(value: unknown): unknown {
    const converter = CONVERTERS[clrTypeName(value)];
    return converter ? converter(value as never) : convertToObjectWrapper(value);
}

function convertToObjectWrapper(item: unknown): unknown {
    if (item instanceof ClrArray) {
        return item.items.length === 1 ? convertFrom(item.items[0]) : new ArrayWrapper(item.items);
    }
    return new ObjectWrapper(item instanceof SchemaObject ? item : null);
}

function convertToWrapperObject(item: SchemaObject): ObjectWrapper {
    const wrapper = new ObjectWrapper(item);
    wrapper.displayName = displayNameFromProperties(wrapper);
    return wrapper;
}

/** MergeString: the non-empty items joined with `separator`. */
export function mergeString(separator: string, ...items: unknown[]): string {
    let text = "";
    for (const item of items) {
        if (item === null || item === undefined) continue;
        const itemText = clrToString(item);
        if (itemText.length > 0) {
            if (text.length > 0) text += separator;
            text += itemText;
        }
    }
    return text;
}

function convertColumnReference(item: SchemaObject): ObjectWrapper {
    const v = item.values;
    return new ObjectWrapper(
        item,
        mergeString(".", v.get("Database"), v.get("Schema"), v.get("Table"), v.get("Column")),
    );
}

function convertObject(item: SchemaObject): ObjectWrapper {
    const v = item.values;
    let displayName = mergeString(
        ".",
        v.get("Server"),
        v.get("Database"),
        v.get("Schema"),
        v.get("Table"),
        v.get("Index"),
    );
    displayName = mergeString(" ", displayName, v.get("Alias"));
    if (v.get("CloneAccessScopeSpecified") === true) {
        displayName = mergeString(
            " ",
            displayName,
            convertCloneAccessScope(v.get("CloneAccessScope") as ClrEnum),
        );
    }
    return new ObjectWrapper(item, displayName);
}

function convertCloneAccessScope(item: ClrEnum): string {
    const names: Record<string, string> = {
        Primary: SR.PrimaryClones,
        Secondary: SR.SecondaryClones,
        Both: SR.BothClones,
        Either: SR.EitherClones,
        ExactMatch: SR.ExactMatchClones,
    };
    return names[item.member] ?? item.member;
}

function convertDefinedValues(definedValues: ClrArray): ObjectWrapper {
    // Each DefinedValue's Item becomes a property name, its Items the property value.
    const wrapper = new ObjectWrapper();
    let text = "";
    for (const definedValue of definedValues.items as SchemaObject[]) {
        const first = definedValue.values.get("Item");
        if (first === null || first === undefined) continue;
        const name = clrToString(convertFrom(first));
        if (name.length === 0) continue;
        if (wrapper.get(name) !== null) continue;
        if (text.length > 0) text += LIST_SEPARATOR + " ";
        const items = definedValue.values.get("Items") as ClrArray | null;
        if (!items || items.items.length === 0) {
            text += name;
            wrapper.set(name, "");
            continue;
        }
        const wrappedValue = convertToObjectWrapper(items);
        text +=
            items.items.length > 1
                ? `[${name}] = (${clrToString(wrappedValue)})`
                : `[${name}] = ${clrToString(wrappedValue)}`;
        wrapper.set(name, wrappedValue);
    }
    wrapper.displayName = text;
    return wrapper;
}

function convertWarnings(item: SchemaObject): ObjectWrapper {
    const wrapper = new ObjectWrapper(item);
    const separator = LIST_SEPARATOR + " ";
    let displayName = "";
    const list = (name: string) =>
        wrapper.properties.items
            .filter((p) => p.name === name)
            .map((p) => p.value as ObjectWrapper);
    const value = (w: ObjectWrapper, name: string) => clrToString(w.properties.find(name)!.value);

    if (wrapper.get("SpillOccurred") !== null)
        displayName = mergeString(separator, displayName, SR.SpillOccurredDisplayString);
    if (wrapper.get("ColumnsWithNoStatistics") !== null) {
        const columns = wrapper.get("ColumnsWithNoStatistics") as ObjectWrapper;
        displayName = format(
            SR.NameValuePair,
            SR.ColumnsWithNoStatistics,
            value(columns, "ColumnReference"),
        );
    }
    if (wrapper.get("NoJoinPredicate") === true)
        displayName = mergeString(separator, displayName, SR.NoJoinPredicate);
    if (wrapper.get("SpillToTempDb") !== null) {
        for (const spill of list("SpillToTempDb")) {
            const level = value(spill, "SpillLevel");
            const threads = spill.properties.find("SpilledThreadCount");
            const text = threads
                ? format(SR.SpillToTempDb, level, clrToString(threads.value))
                : format(SR.SpillToTempDbOld, level);
            displayName = mergeString(separator, displayName, text);
        }
    }
    for (const [name, template] of [
        ["HashSpillDetails", SR.HashSpillDetails],
        ["SortSpillDetails", SR.SortSpillDetails],
    ]) {
        if (wrapper.get(name) === null) continue;
        for (const spill of list(name)) {
            const text = format(
                template,
                value(spill, "WritesToTempDb"),
                value(spill, "ReadsFromTempDb"),
                value(spill, "GrantedMemoryKb"),
                value(spill, "UsedMemoryKb"),
            );
            displayName = mergeString(separator, displayName, text);
        }
    }
    if (wrapper.get("Wait") !== null) {
        const perType = new Map<string, number>();
        for (const wait of list("Wait")) {
            const time = Number.parseInt(value(wait, "WaitTime"), 10);
            const type = value(wait, "WaitType");
            perType.set(type, (perType.get(type) ?? 0) + time);
        }
        for (const [type, time] of perType) {
            displayName = mergeString(separator, displayName, format(SR.Wait, String(time), type));
        }
    }
    if (wrapper.get("PlanAffectingConvert") !== null) {
        for (const convert of list("PlanAffectingConvert")) {
            const text = format(
                SR.PlanAffectingConvert,
                value(convert, "Expression"),
                value(convert, "ConvertIssue"),
            );
            displayName = mergeString(separator, displayName, text);
        }
    }
    if (wrapper.get("MemoryGrantWarning") !== null) {
        for (const grant of list("MemoryGrantWarning")) {
            const kind = grant.properties.find("GrantWarningKind");
            const requested = grant.properties.find("RequestedMemory");
            const granted = grant.properties.find("GrantedMemory");
            const used = grant.properties.find("MaxUsedMemory");
            if (kind && granted && requested && used) {
                const text = format(
                    SR.MemoryGrantWarning,
                    clrToString(kind.value),
                    clrToString(requested.value),
                    clrToString(granted.value),
                    clrToString(used.value),
                );
                displayName = mergeString(separator, displayName, text);
            }
        }
    }
    // FullUpdateForOnlineIndexBuild is added twice, as in the C#.
    if (wrapper.get("FullUpdateForOnlineIndexBuild") !== null) {
        displayName = mergeString(separator, displayName, SR.FullUpdateForOnlineIndexBuild);
    }
    if (wrapper.get("FullUpdateForOnlineIndexBuild") !== null) {
        displayName = mergeString(separator, displayName, SR.FullUpdateForOnlineIndexBuild);
    }
    wrapper.displayName = displayName;
    return wrapper;
}

function convertScalarRows(rows: ClrArray): ObjectWrapper {
    const wrapper = new ArrayWrapper(rows.items);
    const separator = LIST_SEPARATOR + " ";
    wrapper.displayName = (rows.items as ClrArray[])
        .map(
            (row) =>
                `(${row.items.map((scalar) => String(convertScalar(scalar as SchemaObject))).join(separator)})`,
        )
        .join(separator);
    return wrapper;
}

function convertScalar(item: SchemaObject): ObjectWrapper {
    const wrapper = new ObjectWrapper(item);
    const scalarString = item.values.get("ScalarString") as string | null;
    wrapper.displayName = scalarString
        ? `${SR.ScalarOperator}(${scalarString})`
        : SR.ScalarOperator;
    return wrapper;
}

function convertCompare(item: SchemaObject): ObjectWrapper {
    const wrapper = new ObjectWrapper(item);
    const scalarOperator = wrapper.get("ScalarOperator");
    const compareOp = clrToString(item.values.get("CompareOp"));
    // The condition is inverted in the C# (the operand is only shown when there is none).
    wrapper.displayName = scalarOperator !== null ? compareOp : `${compareOp}()`;
    return wrapper;
}

function convertScanRange(item: SchemaObject): ObjectWrapper {
    const wrapper = new ObjectWrapper(item);
    const rangeColumn = wrapper.get("RangeColumns");
    const rangeExpressions = wrapper.get("RangeExpressions");
    if (rangeColumn !== null && rangeExpressions !== null) {
        const scanType = (item.values.get("ScanType") as ClrEnum).member;
        const operators: Record<string, string> = {
            EQ: "=",
            GE: ">=",
            GT: ">",
            LE: "<=",
            LT: "<",
            NE: "<>",
        };
        const compareOperator = operators[scanType] ?? "";
        wrapper.displayName =
            compareOperator.length > 0
                ? `${clrToString(rangeColumn)} ${compareOperator} ${clrToString(rangeExpressions)}`
                : `${scanType}(${mergeString(",", rangeColumn, rangeExpressions)})`;
    }
    return wrapper;
}

/** An array wrapper whose display name, with several items, lists "[i] value" pairs. */
function mergedArrayWrapper(items: unknown[]): ObjectWrapper {
    const wrapper = new ArrayWrapper(items);
    const properties = wrapper.properties.items;
    if (properties.length > 1) {
        wrapper.displayName = properties
            .map((p) => `${p.displayName} ${clrToString(p.value)}`)
            .join(LIST_SEPARATOR + " ");
    }
    return wrapper;
}

function convertSeekPredicates(item: SchemaObject): ObjectWrapper {
    const items = (item.values.get("Items") as ClrArray).items;
    if (
        items.length > 0 &&
        items[0] instanceof SchemaObject &&
        items[0].className === "SeekPredicateNewType"
    ) {
        return mergedArrayWrapper(items);
    }
    return new ArrayWrapper(items);
}

function convertSeekPredicateNew(item: SchemaObject): ObjectWrapper {
    const seekKeys = item.values.get("SeekKeys") as ClrArray | null;
    const wrapper = new ArrayWrapper(seekKeys?.items ?? []);
    wrapper.displayName = wrapper.properties.items
        .map((p, i) => `${SR.SeekKeys}[${i + 1}]: ${clrToString(p.value)}`)
        .join(LIST_SEPARATOR + " ");
    return wrapper;
}

/** MakeDisplayNameFromObjectNamesAndValues: "Name: value" pairs of all, or the named, properties. */
function displayNameFromProperties(wrapper: ObjectWrapper, names?: string[]): string {
    const properties = names
        ? names
              .map((n) => wrapper.properties.find(n))
              .filter((p): p is PropertyValue => p !== undefined)
        : wrapper.properties.items;
    let text = "";
    for (const property of properties) {
        if (property.value === null || property.value === undefined) continue;
        if (text.length > 0) text += LIST_SEPARATOR + " ";
        text += format(SR.NameValuePair, property.displayName, clrToString(property.value));
    }
    return text;
}

function convertInternalInfo(item: SchemaObject): ObjectWrapper {
    const wrapper = new ObjectWrapper();
    let xml = "<InternalInfo";
    let content = "";
    for (const attribute of ((item.values.get("AnyAttr") as ClrArray | null)?.items ??
        []) as ClrXmlAttribute[]) {
        wrapper.set(attribute.attribute.name, attribute.attribute.value);
        xml += ` ${attribute.attribute.name}="${escapeAttribute(attribute.attribute.value)}"`;
    }
    for (const element of ((item.values.get("Any") as ClrArray | null)?.items ??
        []) as ClrXmlElement[]) {
        const converted = convertXmlElement(element);
        wrapper.set(element.element.name, converted);
        content += converted.displayName;
    }
    wrapper.displayName = xml + (content ? `>${content}</InternalInfo>` : " />");
    return wrapper;
}

function convertXmlElement(item: ClrXmlElement): ObjectWrapper {
    const wrapper = new ObjectWrapper();
    const element = item.element;
    let xml = `<${element.name}`;
    let content = "";
    for (const attribute of element.attributes) {
        wrapper.set(attribute.name, attribute.value);
        xml += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`;
    }
    for (const child of element.children) {
        const converted = convertXmlElement(new ClrXmlElement(child));
        wrapper.set(child.name, converted);
        content += converted.displayName;
    }
    wrapper.displayName = xml + (content ? `>${content}</${element.name}>` : " />");
    return wrapper;
}

function escapeAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
