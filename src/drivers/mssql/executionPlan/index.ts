/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Port of sqltoolsservice's ExecutionPlan/ExecutionPlanGraphUtils.cs: showplan XML to the graphs
 * of `queryExecutionPlan/getExecutionPlan`, which Microsoft's execution plan page displays. In
 * vscode-mssql this conversion runs in sqltoolsservice (C#); the output here is meant to be the
 * same JSON for the same XML (docs/reference/mssql-execution-plans.json is the reference).
 *
 * A few fields of that JSON differ from the TypeScript interfaces of the page, which Microsoft
 * wrote: node ids are numbers, cost metric values strings, `description` and `elapsedTimeInMs`
 * can be null, `elapsedCpuTimeInMs` is never sent and a recommendation's text is in `query`, not
 * `queryText`. They are kept as sqltoolsservice sends them; the page copes with all of them.
 * sqltoolsservice also sends `topOperationsData`, which the page does not use: it is left out.
 */

import type {
    ExecutionPlanBadge,
    ExecutionPlanEdge,
    ExecutionPlanGraph,
    ExecutionPlanGraphElementProperty,
    ExecutionPlanGraphElementPropertyBetterValue,
    ExecutionPlanNode,
    ExecutionPlanRecommendations,
} from "../../../sharedInterfaces/executionPlan";
import { dataTypeOf, ObjectWrapper, type PropertyBag, type PropertyValue } from "./objectModel";
import { type Edge, type Node, parseShowPlanGraphs } from "./planParser";
import { addExecutionPlanStatistics } from "./planStatistics";
import { SR } from "./showplanStrings.generated";

/** File extension and editor language of a saved SQL Server plan. */
export const SHOWPLAN_FILE_EXTENSION = "sqlplan";

/**
 * `Driver.executionPlan.parse` of SQL Server: what the page gets in vscode-mssql, i.e.
 * sqltoolsservice's graphs (convertShowPlanXml) with the actual-plan counters vscode-mssql adds
 * (addExecutionPlanStatistics). Throws when the document is not a plan.
 */
export function parseShowPlanXml(xml: string): ExecutionPlanGraph[] {
    return addExecutionPlanStatistics(convertShowPlanXml(xml));
}

/**
 * sqltoolsservice's `queryExecutionPlan/getExecutionPlan`: one graph per statement, the same JSON
 * (docs/reference/mssql-execution-plans.json). Throws when the document is not a plan.
 */
export function convertShowPlanXml(xml: string): ExecutionPlanGraph[] {
    return parseShowPlanGraphs(xml).map((graph, index) => ({
        root: convertNode(graph.root!),
        query: graph.statement,
        graphFile: { graphFileContent: xml, graphFileType: "xml", planIndexInFile: index },
        recommendations: graph.missingIndexes.map(
            (missingIndex) =>
                ({
                    displayString: missingIndex.caption,
                    // sqltoolsservice's field is "query", where the page's interface says "queryText".
                    query: missingIndex.queryText,
                    queryWithDescription: missingIndexQueryText(
                        missingIndex.impact,
                        missingIndex.database,
                        missingIndex.queryText,
                    ),
                }) as unknown as ExecutionPlanRecommendations,
        ),
    }));
}

/** sqltoolsservice receives no file name, hence "from " followed by nothing. */
function missingIndexQueryText(impact: string, database: string, query: string): string {
    const title = SR.MissingIndexDetailsTitle.replace("{0}", "").replace("{1}", impact);
    return `${title}\r\n\r\n/*\r\nUSE ${database}\r\nGO\r\n${query}\r\nGO\r\n*/\r\n`;
}

function convertNode(node: Node): ExecutionPlanNode {
    const costMetrics: { name: string; value: string }[] = [];
    const elapsedCpuTimeInMs = node.elapsedCpuTimeInMs;
    if (elapsedCpuTimeInMs !== null)
        costMetrics.push({ name: "ElapsedCpuTime", value: String(elapsedCpuTimeInMs) });
    for (const name of [
        "EstimateRowsAllExecs",
        "EstimatedRowsRead",
        "ActualRows",
        "ActualRowsRead",
    ]) {
        const property = node.properties.find(name);
        if (property) costMetrics.push({ name, value: displayValueOf(property) });
    }

    const converted = {
        id: node.id,
        type: node.operation!.image,
        cost: node.cost,
        rowCountDisplayString: node.getRowCountDisplayString(),
        costDisplayString: node.getNodeCostDisplayString(),
        subTreeCost: node.subtreeCost,
        description: node.description,
        subtext: node.getDisplayLinesOfText(),
        relativeCost: node.relativeCost,
        properties: convertProperties(node.properties),
        children: node.children.map(convertNode),
        edges: node.edges.map(convertEdge),
        badges: badgesOf(node),
        name: node.displayName,
        elapsedTimeInMs: node.elapsedTimeInMs,
        costMetrics,
    };
    // The JSON sqltoolsservice sends (see the note at the top of the file).
    return converted as unknown as ExecutionPlanNode;
}

function badgesOf(node: Node): ExecutionPlanBadge[] {
    const badges: ExecutionPlanBadge[] = [];
    if (node.hasWarnings) {
        badges.push({ type: node.hasCriticalWarnings ? 1 : 0, tooltip: SR.WarningOverlayTooltip });
    }
    if (node.isParallel) badges.push({ type: 2, tooltip: SR.ParallelismOverlayTooltip });
    return badges;
}

function convertEdge(edge: Edge): ExecutionPlanEdge {
    return {
        rowCount: edge.rowCount,
        rowSize: edge.rowSize,
        properties: convertProperties(edge.properties),
    };
}

/** GetPropertyDisplayValue: the converted value, trimmed. */
function displayValueOf(property: PropertyValue): string {
    if (property.value === null || property.value === undefined) return "";
    return property.displayValue.trim();
}

/** GetProperties: browsable plain properties, and every nested one (browsable or not). */
function convertProperties(bag: PropertyBag): ExecutionPlanGraphElementProperty[] {
    const result: ExecutionPlanGraphElementProperty[] = [];
    for (const property of bag.items) {
        const nested = property.value instanceof ObjectWrapper ? property.value : null;
        if (!nested && !property.isBrowsable) continue;
        result.push({
            value: nested ? convertProperties(nested.properties) : property.displayValue,
            name: property.displayName,
            showInTooltip: property.showInTooltip,
            displayOrder: property.displayOrder,
            positionAtBottom: property.isLongString,
            displayValue: displayValueOf(property),
            betterValue:
                property.betterValue as number as ExecutionPlanGraphElementPropertyBetterValue,
            dataType: nested ? 3 : dataTypeOf(property.value),
        });
    }
    return result;
}
