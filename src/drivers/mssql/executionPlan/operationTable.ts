/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Port of sqltoolsservice's ShowPlan/Operation.cs and OperationTable.cs: the operators, statements
 * and cursor types, with their display name, description and icon (the node's `type`).
 */

import { enumXmlValue } from "./deserialize";
import { SR } from "./showplanStrings.generated";

export class Operation {
    constructor(
        readonly name: string | null,
        private readonly displayNameKey: string | null,
        private readonly descriptionKey: string | null = null,
        readonly image: string | null = null,
    ) {}

    /** The SR string of the key (null for a key that has none), else the name. */
    get displayName(): string | null {
        if (this.displayNameKey !== null) {
            const text = Object.prototype.hasOwnProperty.call(SR, this.displayNameKey)
                ? SR[this.displayNameKey]
                : null;
            if (text !== null) return text;
        }
        return this.name;
    }

    get description(): string | null {
        return this.descriptionKey !== null ? SR[this.descriptionKey] : null;
    }

    static createUnknown(operationDisplayName: string, iconName: string): Operation {
        return new Operation(operationDisplayName, null, null, iconName);
    }

    static readonly unknown = new Operation("", "Unknown", "UnknownDescription", "Result_32x.ico");
}

/** [name, display name key, description key, image]. */
type OperationEntry = [string, string | null, string | null, string | null] | [string, string];

const PHYSICAL: OperationEntry[] = [
    ["AdaptiveJoin", "AdaptiveJoin", "AdaptiveJoinDescription", "adaptiveJoin"],
    ["Assert", "Assert", "AssertDescription", "assert"],
    ["Bitmap", "Bitmap", "BitmapDescription", "bitmap"],
    [
        "ClusteredIndexDelete",
        "ClusteredIndexDelete",
        "ClusteredIndexDeleteDescription",
        "clusteredIndexDelete",
    ],
    [
        "ClusteredIndexInsert",
        "ClusteredIndexInsert",
        "ClusteredIndexInsertDescription",
        "clusteredIndexInsert",
    ],
    [
        "ClusteredIndexScan",
        "ClusteredIndexScan",
        "ClusteredIndexScanDescription",
        "clusteredIndexScan",
    ],
    [
        "ClusteredIndexSeek",
        "ClusteredIndexSeek",
        "ClusteredIndexSeekDescription",
        "clusteredIndexSeek",
    ],
    [
        "ClusteredIndexUpdate",
        "ClusteredIndexUpdate",
        "ClusteredIndexUpdateDescription",
        "clusteredIndexUpdate",
    ],
    [
        "ClusteredIndexMerge",
        "ClusteredIndexMerge",
        "ClusteredIndexMergeDescription",
        "clusteredIndexMerge",
    ],
    ["ClusteredUpdate", "ClusteredUpdate", "ClusteredUpdateDescription", "clusteredUpdate"],
    ["Collapse", "Collapse", "CollapseDescription", "collapse"],
    ["ComputeScalar", "ComputeScalar", "ComputeScalarDescription", "computeScalar"],
    ["Concatenation", "Concatenation", "ConcatenationDescription", "concatenation"],
    ["ConstantScan", "ConstantScan", "ConstantScanDescription", "constantScan"],
    ["DeletedScan", "DeletedScan", "DeletedScanDescription", "deletedScan"],
    ["Filter", "Filter", "FilterDescription", "filter"],
    ["HashMatch", "HashMatch", "HashMatchDescription", "hashMatch"],
    ["IndexDelete", "IndexDelete", "IndexDeleteDescription", "indexDelete"],
    ["IndexInsert", "IndexInsert", "IndexInsertDescription", "indexInsert"],
    ["IndexScan", "IndexScan", "IndexScanDescription", "indexScan"],
    [
        "ColumnstoreIndexDelete",
        "ColumnstoreIndexDelete",
        "ColumnstoreIndexDeleteDescription",
        "columnstoreIndexDelete",
    ],
    [
        "ColumnstoreIndexInsert",
        "ColumnstoreIndexInsert",
        "ColumnstoreIndexInsertDescription",
        "columnstoreIndexInsert",
    ],
    [
        "ColumnstoreIndexMerge",
        "ColumnstoreIndexMerge",
        "ColumnstoreIndexMergeDescription",
        "columnstoreIndexMerge",
    ],
    [
        "ColumnstoreIndexScan",
        "ColumnstoreIndexScan",
        "ColumnstoreIndexScanDescription",
        "columnstoreIndexScan",
    ],
    [
        "ColumnstoreIndexUpdate",
        "ColumnstoreIndexUpdate",
        "ColumnstoreIndexUpdateDescription",
        "columnstoreIndexUpdate",
    ],
    ["IndexSeek", "IndexSeek", "IndexSeekDescription", "indexSeek"],
    ["IndexSpool", "IndexSpool", "IndexSpoolDescription", "indexSpool"],
    ["IndexUpdate", "IndexUpdate", "IndexUpdateDescription", "indexUpdate"],
    ["InsertedScan", "InsertedScan", "InsertedScanDescription", "insertedScan"],
    ["LogRowScan", "LogRowScan", "LogRowScanDescription", "logRowScan"],
    ["MergeInterval", "MergeInterval", "MergeIntervalDescription", "mergeInterval"],
    ["MergeJoin", "MergeJoin", "MergeJoinDescription", "mergeJoin"],
    ["NestedLoops", "NestedLoops", "NestedLoopsDescription", "nestedLoops"],
    ["Parallelism", "Parallelism", "ParallelismDescription", "parallelism"],
    [
        "ParameterTableScan",
        "ParameterTableScan",
        "ParameterTableScanDescription",
        "parameterTableScan",
    ],
    ["Print", "Print", "PrintDescription", "print"],
    ["Put", "Put", "PutDescription", "put"],
    ["Rank", "Rank", "RankDescription", "rank"],
    [
        "ForeignKeyReferencesCheck",
        "ForeignKeyReferencesCheck",
        "ForeignKeyReferencesCheckDescription",
        "foreignKeyReferencesCheck",
    ],
    ["RemoteDelete", "RemoteDelete", "RemoteDeleteDescription", "remoteDelete"],
    ["RemoteIndexScan", "RemoteIndexScan", "RemoteIndexScanDescription", "remoteIndexScan"],
    ["RemoteIndexSeek", "RemoteIndexSeek", "RemoteIndexSeekDescription", "remoteIndexSeek"],
    ["RemoteInsert", "RemoteInsert", "RemoteInsertDescription", "remoteInsert"],
    ["RemoteQuery", "RemoteQuery", "RemoteQueryDescription", "remoteQuery"],
    ["RemoteScan", "RemoteScan", "RemoteScanDescription", "remoteScan"],
    ["RemoteUpdate", "RemoteUpdate", "RemoteUpdateDescription", "remoteUpdate"],
    ["RIDLookup", "RIDLookup", "RIDLookupDescription", "ridLookup"],
    ["RowCountSpool", "RowCountSpool", "RowCountSpoolDescription", "rowCountSpool"],
    ["Segment", "Segment", "SegmentDescription", "segment"],
    ["Sequence", "Sequence", "SequenceDescription", "sequence"],
    ["SequenceProject", "SequenceProject", "SequenceProjectDescription", "sequenceProject"],
    ["Sort", "Sort", "SortDescription", "sort"],
    ["Split", "Split", "SplitDescription", "split"],
    ["StreamAggregate", "StreamAggregate", "StreamAggregateDescription", "streamAggregate"],
    ["Switch", "Switch", "SwitchDescription", "switchStatement"],
    [
        "Tablevaluedfunction",
        "TableValueFunction",
        "TableValueFunctionDescription",
        "tableValuedFunction",
    ],
    ["TableDelete", "TableDelete", "TableDeleteDescription", "tableDelete"],
    ["TableInsert", "TableInsert", "TableInsertDescription", "tableInsert"],
    ["TableScan", "TableScan", "TableScanDescription", "tableScan"],
    ["TableSpool", "TableSpool", "TableSpoolDescription", "tableSpool"],
    ["TableUpdate", "TableUpdate", "TableUpdateDescription", "tableUpdate"],
    ["TableMerge", "TableMerge", "TableMergeDescription", "tableMerge"],
    ["TFP", "TFP", "TFPDescription", "tfp"],
    ["Top", "Top", "TopDescription", "top"],
    ["UDX", "UDX", "UDXDescription", "udx"],
    [
        "BatchHashTableBuild",
        "BatchHashTableBuild",
        "BatchHashTableBuildDescription",
        "batchHashTableBuild",
    ],
    ["WindowSpool", "Window", "WindowDescription", "windowSpool"],
    ["WindowAggregate", "WindowAggregate", "WindowAggregateDescription", "windowAggregate"],
    ["FetchQuery", "FetchQuery", "FetchQueryDescription", "fetchQuery"],
    ["PopulateQuery", "PopulationQuery", "PopulationQueryDescription", "populateQuery"],
    ["RefreshQuery", "RefreshQuery", "RefreshQueryDescription", "refreshQuery"],
    ["Result", "Result", "ResultDescription", "result"],
    ["Aggregate", "Aggregate", "AggregateDescription", "aggregate"],
    ["Assign", "Assign", "AssignDescription", "assign"],
    [
        "ArithmeticExpression",
        "ArithmeticExpression",
        "ArithmeticExpressionDescription",
        "arithmeticExpression",
    ],
    ["BookmarkLookup", "BookmarkLookup", "BookmarkLookupDescription", "bookmarkLookup"],
    ["Convert", "Convert", "ConvertDescription", "convert"],
    ["Declare", "Declare", "DeclareDescription", "declare"],
    ["Delete", "Delete", "DeleteDescription", "deleteOperator"],
    ["Dynamic", "Dynamic", "DynamicDescription", "dynamic"],
    ["HashMatchRoot", "HashMatchRoot", "HashMatchRootDescription", "hashMatchRoot"],
    ["HashMatchTeam", "HashMatchTeam", "HashMatchTeamDescription", "hashMatchTeam"],
    ["If", "If", "IfDescription", "ifOperator"],
    ["Insert", "Insert", "InsertDescription", "insert"],
    ["Intrinsic", "Intrinsic", "IntrinsicDescription", "intrinsic"],
    ["Keyset", "Keyset", "KeysetDescription", "keyset"],
    ["Locate", "Locate", "LocateDescription", "locate"],
    ["PopulationQuery", "PopulationQuery", "PopulationQueryDescription", "populationQuery"],
    ["SetFunction", "SetFunction", "SetFunctionDescription", "setFunction"],
    ["Snapshot", "Snapshot", "SnapshotDescription", "snapshot"],
    ["Spool", "Spool", "SpoolDescription", "spool"],
    ["TSQL", "SQL", "SQLDescription", "tsql"],
    ["Update", "Update", "UpdateDescription", "update"],
    ["KeyLookup", "KeyLookup", "KeyLookupDescription", "keyLookup"],
    ["Apply", "Apply", "ApplyDescription", "apply"],
    ["Broadcast", "Broadcast", "BroadcastDescription", "broadcast"],
    [
        "ComputeToControlNode",
        "ComputeToControlNode",
        "ComputeToControlNodeDescription",
        "computeToControlNode",
    ],
    ["ConstTableGet", "ConstTableGet", "ConstTableGetDescription", "constTableGet"],
    [
        "ControlToComputeNodes",
        "ControlToComputeNodes",
        "ControlToComputeNodesDescription",
        "controlToComputeNodes",
    ],
    ["ExternalBroadcast", "ExternalBroadcast", "ExternalBroadcastDescription", "externalBroadcast"],
    ["ExternalExport", "ExternalExport", "ExternalExportDescription", "externalExport"],
    [
        "ExternalLocalStreaming",
        "ExternalLocalStreaming",
        "ExternalLocalStreamingDescription",
        "externalLocalStreaming",
    ],
    [
        "ExternalRoundRobin",
        "ExternalRoundRobin",
        "ExternalRoundRobinDescription",
        "externalRoundRobin",
    ],
    ["ExternalShuffle", "ExternalShuffle", "ExternalShuffleDescription", "externalShuffle"],
    ["Get", "Get", "GetDescription", "get"],
    ["GbApply", "GbApply", "GbApplyDescription", "groupByApply"],
    ["GbAgg", "GbAgg", "GbAggDescription", "groupByAggregate"],
    ["Join", "Join", "JoinDescription", "join"],
    ["LocalCube", "LocalCube", "LocalCubeDescription", "localCube"],
    ["Project", "Project", "ProjectDescription", "project"],
    ["Shuffle", "Shuffle", "ShuffleDescription", "shuffle"],
    [
        "SingleSourceRoundRobin",
        "SingleSourceRoundRobin",
        "SingleSourceRoundRobinDescription",
        "singleSourceRoundRobin",
    ],
    [
        "SingleSourceShuffle",
        "SingleSourceShuffle",
        "SingleSourceShuffleDescription",
        "singleSourceShuffle",
    ],
    ["Trim", "Trim", "TrimDescription", "trim"],
    ["Union", "Union", "UnionDescription", "union"],
    ["UnionAll", "UnionAll", "UnionAllDescription", "unionAll"],
];
const LOGICAL: OperationEntry[] = [
    ["Aggregate", "LogicalOpAggregate"],
    ["AntiDiff", "LogicalOpAntiDiff"],
    ["Assert", "LogicalOpAssert"],
    ["BitmapCreate", "LogicalOpBitmapCreate"],
    ["ClusteredIndexScan", "LogicalOpClusteredIndexScan"],
    ["ClusteredIndexSeek", "LogicalOpClusteredIndexSeek"],
    ["ClusteredUpdate", "LogicalOpClusteredUpdate"],
    ["Collapse", "LogicalOpCollapse"],
    ["ComputeScalar", "LogicalOpComputeScalar"],
    ["Concatenation", "LogicalOpConcatenation"],
    ["ConstantScan", "LogicalOpConstantScan"],
    ["CrossJoin", "LogicalOpCrossJoin"],
    ["Delete", "LogicalOpDelete"],
    ["DeletedScan", "LogicalOpDeletedScan"],
    ["DistinctSort", "LogicalOpDistinctSort"],
    ["Distinct", "LogicalOpDistinct"],
    [
        "DistributeStreams",
        "LogicalOpDistributeStreams",
        "DistributeStreamsDescription",
        "parallelismDistribute",
    ],
    ["EagerSpool", "LogicalOpEagerSpool"],
    ["Filter", "LogicalOpFilter"],
    ["FlowDistinct", "LogicalOpFlowDistinct"],
    ["FullOuterJoin", "LogicalOpFullOuterJoin"],
    ["GatherStreams", "LogicalOpGatherStreams", "GatherStreamsDescription", "parallelism"],
    ["IndexScan", "LogicalOpIndexScan"],
    ["IndexSeek", "LogicalOpIndexSeek"],
    ["InnerApply", "LogicalOpInnerApply"],
    ["InnerJoin", "LogicalOpInnerJoin"],
    ["Insert", "LogicalOpInsert"],
    ["InsertedScan", "LogicalOpInsertedScan"],
    ["IntersectAll", "LogicalOpIntersectAll"],
    ["Intersect", "LogicalOpIntersect"],
    ["KeyLookup", "LogicalKeyLookup"],
    ["LazySpool", "LogicalOpLazySpool"],
    ["LeftAntiSemiApply", "LogicalOpLeftAntiSemiApply"],
    ["LeftAntiSemiJoin", "LogicalOpLeftAntiSemiJoin"],
    ["LeftDiffAll", "LogicalOpLeftDiffAll"],
    ["LeftDiff", "LogicalOpLeftDiff"],
    ["LeftOuterApply", "LogicalOpLeftOuterApply"],
    ["LeftOuterJoin", "LogicalOpLeftOuterJoin"],
    ["LeftSemiApply", "LogicalOpLeftSemiApply"],
    ["LeftSemiJoin", "LogicalOpLeftSemiJoin"],
    ["LogRowScan", "LogicalOpLogRowScan"],
    ["MergeInterval", "LogicalOpMergeInterval"],
    ["ParameterTableScan", "LogicalOpParameterTableScan"],
    ["PartialAggregate", "LogicalOpPartialAggregate"],
    ["Print", "LogicalOpPrint"],
    ["Put", "LogicalOpPut"],
    ["Rank", "LogicalOpRank"],
    ["ForeignKeyReferencesCheck", "LogicalOpForeignKeyReferencesCheck"],
    ["RemoteDelete", "LogicalOpRemoteDelete"],
    ["RemoteIndexScan", "LogicalOpRemoteIndexScan"],
    ["RemoteIndexSeek", "LogicalOpRemoteIndexSeek"],
    ["RemoteInsert", "LogicalOpRemoteInsert"],
    ["RemoteQuery", "LogicalOpRemoteQuery"],
    ["RemoteScan", "LogicalOpRemoteScan"],
    ["RemoteUpdate", "LogicalOpRemoteUpdate"],
    [
        "RepartitionStreams",
        "LogicalOpRepartitionStreams",
        "RepartitionStreamsDescription",
        "parallelismRepartition",
    ],
    ["RIDLookup", "LogicalOpRIDLookup"],
    ["RightAntiSemiJoin", "LogicalOpRightAntiSemiJoin"],
    ["RightDiffAll", "LogicalOpRightDiffAll"],
    ["RightDiff", "LogicalOpRightDiff"],
    ["RightOuterJoin", "LogicalOpRightOuterJoin"],
    ["RightSemiJoin", "LogicalOpRightSemiJoin"],
    ["Segment", "LogicalOpSegment"],
    ["Sequence", "LogicalOpSequence"],
    ["Sort", "LogicalOpSort"],
    ["Split", "LogicalOpSplit"],
    ["Switch", "LogicalOpSwitch"],
    ["Tablevaluedfunction", "LogicalOpTableValuedFunction"],
    ["TableScan", "LogicalOpTableScan"],
    ["Top", "LogicalOpTop"],
    ["TopNSort", "LogicalOpTopNSort"],
    ["UDX", "LogicalOpUDX"],
    ["Union", "LogicalOpUnion"],
    ["Update", "LogicalOpUpdate"],
    ["Merge", "LogicalOpMerge"],
    ["MergeStats", "LogicalOpMergeStats"],
    ["LocalStats", "LogicalOpLocalStats"],
    ["BatchHashTableBuild", "LogicalOpBatchHashTableBuild"],
    ["WindowSpool", "LogicalOpWindow"],
];
const STATEMENT: OperationEntry[] = [
    ["SELECT", null, null, "result"],
    ["COND", null, null, "ifOperator"],
];
const CURSOR: OperationEntry[] = [
    ["Dynamic", "Dynamic", "DynamicDescription", "dynamic"],
    ["FastForward", "FastForward", "FastForwardDescription", "cursorCatchAll"],
    ["Keyset", "Keyset", "KeysetDescription", "keyset"],
    ["SnapShot", "Snapshot", "SnapshotDescription", "snapshot"],
];

const dictionary = (list: OperationEntry[]) =>
    new Map(
        list.map(([name, key, description, image]) => [
            name,
            new Operation(name, key, description ?? null, image ?? null),
        ]),
    );

const physicalOperations = dictionary(PHYSICAL);
const logicalOperations = dictionary(LOGICAL);
const statements = dictionary(STATEMENT);
const cursorTypes = dictionary(CURSOR);

export function getStatement(statementTypeName: string): Operation {
    return (
        statements.get(statementTypeName) ??
        Operation.createUnknown(statementTypeName, "languageConstructCatchAll")
    );
}

export function getCursorType(cursorTypeName: string): Operation {
    return (
        cursorTypes.get(cursorTypeName) ??
        Operation.createUnknown(enumXmlValue("CursorType", cursorTypeName), "cursorCatchAll")
    );
}

export function getPhysicalOperation(operationType: string): Operation {
    return (
        physicalOperations.get(operationType) ??
        Operation.createUnknown(enumXmlValue("PhysicalOpType", operationType), "iteratorCatchAll")
    );
}

export function getLogicalOperation(operationType: string): Operation {
    // An unknown logical operation keeps the physical operation's description and icon.
    return (
        logicalOperations.get(operationType) ??
        new Operation(null, enumXmlValue("LogicalOpType", operationType))
    );
}

export function getUdf(): Operation {
    return new Operation(null, "Udf", null, "languageConstructCatchAll");
}

export function getStoredProc(): Operation {
    return new Operation(null, "StoredProc", null, "languageConstructCatchAll");
}
