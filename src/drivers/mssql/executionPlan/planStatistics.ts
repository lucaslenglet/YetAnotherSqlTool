/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Port of vscode-mssql's queryResult/liveExecutionPlanStatistics.ts, addExecutionPlanStatistics,
 * for a finished plan (isLive = false): vscode-mssql's ExecutionPlanService runs it on every graph
 * sqltoolsservice returns, and the page shows its counters ("3 of 3 (100%)", elapsed times) on
 * the operators of an actual plan. The running-query progress estimate is left out (live plans
 * only). It reads the XML with ./xml instead of @xmldom/xmldom.
 */

import type {
    ExecutionPlanGraph,
    ExecutionPlanNode,
} from "../../../sharedInterfaces/executionPlan";
import { parseXml, type XmlElement } from "./xml";

function children(element: XmlElement): XmlElement[] {
    return element.children;
}

function getAttribute(element: XmlElement, name: string): string | null {
    return element.attributes.find((attribute) => attribute.name === name)?.value ?? null;
}

function hasAttribute(element: XmlElement, name: string): boolean {
    return element.attributes.some((attribute) => attribute.name === name);
}

function numberAttribute(element: XmlElement, name: string): number | undefined {
    const text = getAttribute(element, name);
    if (!text?.trim()) {
        return undefined;
    }
    const value = Number(text);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Relational children, stopping at operators and nested statement/query-plan boundaries. */
function childOperators(element: XmlElement): XmlElement[] {
    return children(element).flatMap((child) => {
        if (child.localName === "RelOp") {
            return [child];
        }
        if (child.localName === "QueryPlan" || child.localName.startsWith("Stmt")) {
            return [];
        }
        return childOperators(child);
    });
}

/** Every element of the document, in document order (getElementsByTagNameNS("*", "*")). */
function allElements(root: XmlElement): XmlElement[] {
    const all: XmlElement[] = [];
    const stack = [root];
    while (stack.length) {
        const element = stack.pop()!;
        all.push(element);
        for (let i = element.children.length - 1; i >= 0; i--) stack.push(element.children[i]);
    }
    return all;
}

/**
 * Adds the run-time counters of each operator (read from the XML, which keeps the full durations
 * that sqltoolsservice's elapsedTimeInMs loses) to graphs (each read with its own graphFileContent). An
 * estimated plan, and statement shapes the counters cannot be matched with, are left alone.
 */
export function addExecutionPlanStatistics(graphs: ExecutionPlanGraph[]): ExecutionPlanGraph[] {
    // Graphs of one document share its parsed XML; each graph is matched with its own document.
    const documents = new Map<string, XmlElement>();
    return graphs.map((graph) => {
        const xml = graph.graphFile?.graphFileContent;
        if (!xml) {
            return graph;
        }
        try {
            let document = documents.get(xml);
            if (!document) {
                document = parseXml(xml);
                documents.set(xml, document);
            }
            return addGraphStatistics(graph, document);
        } catch {
            return graph;
        }
    });
}

function addGraphStatistics(graph: ExecutionPlanGraph, document: XmlElement): ExecutionPlanGraph {
    // Lightweight live plans may omit StatementText entirely, even though their operator
    // counters are present. Preserve their position among statements when matching STS graphs.
    const statements = allElements(document).filter(
        (element) => element.localName.startsWith("Stmt") && hasAttribute(element, "StatementId"),
    );
    const indexedStatement = statements[graph.graphFile.planIndexInFile ?? 0];
    const matchingStatements = statements.filter(
        (element) => getAttribute(element, "StatementText") === graph.query,
    );
    const statement =
        indexedStatement &&
        (!hasAttribute(indexedStatement, "StatementText") ||
            !graph.query ||
            getAttribute(indexedStatement, "StatementText") === graph.query)
            ? indexedStatement
            : matchingStatements.length === 1
              ? matchingStatements[0]
              : undefined;
    const queryPlan =
        statement && children(statement).find((child) => child.localName === "QueryPlan");
    const operator = queryPlan && children(queryPlan).find((child) => child.localName === "RelOp");
    if (!queryPlan || !operator || graph.root.children.length !== 1) {
        return graph;
    }

    let maximumElapsed: number | undefined;
    let hasRuntimeCounters = false;
    const annotate = (node: ExecutionPlanNode, relOp: XmlElement): ExecutionPlanNode => {
        const operators = childOperators(relOp);
        if (operators.length !== node.children.length) {
            throw new Error("Live plan operator topology differs from its graph");
        }
        const estimatedPerExecution = numberAttribute(relOp, "EstimateRows");
        const executions =
            1 +
            (numberAttribute(relOp, "EstimateRebinds") ?? 0) +
            (numberAttribute(relOp, "EstimateRewinds") ?? 0);
        const estimatedTotal =
            estimatedPerExecution === undefined ? undefined : estimatedPerExecution * executions;
        const estimatedRows =
            estimatedTotal !== undefined && Number.isFinite(estimatedTotal)
                ? estimatedTotal
                : undefined;
        const runtime = children(relOp).find((child) => child.localName === "RunTimeInformation");
        const counters = runtime
            ? children(runtime).filter((child) => child.localName === "RunTimeCountersPerThread")
            : [];
        let actualRows: bigint | undefined;
        let elapsedTimeInMs: number | undefined;
        for (const counter of counters) {
            const rows = getAttribute(counter, "ActualRows");
            if (rows && /^\d+$/.test(rows)) {
                actualRows = (actualRows ?? 0n) + BigInt(rows);
            }
            const elapsed = numberAttribute(counter, "ActualElapsedms");
            if (elapsed !== undefined) {
                elapsedTimeInMs = Math.max(elapsedTimeInMs ?? 0, elapsed);
            }
        }
        hasRuntimeCounters ||= actualRows !== undefined || elapsedTimeInMs !== undefined;
        if (elapsedTimeInMs !== undefined) {
            maximumElapsed = Math.max(maximumElapsed ?? 0, elapsedTimeInMs);
        }
        const annotatedChildren = node.children.map((child, index) =>
            annotate(child, operators[index]),
        );
        return {
            ...node,
            liveQueryStatistics: {
                actualRows: actualRows?.toString(),
                estimatedRows,
                elapsedTimeInMs,
            },
            children: annotatedChildren,
        };
    };
    const rootOperator = annotate(graph.root.children[0], operator);
    // An estimated plan has optimizer rows but no execution counters. Keep its usual labels.
    if (!hasRuntimeCounters) {
        return graph;
    }
    const timeStats = children(queryPlan).find((child) => child.localName === "QueryTimeStats");
    const queryElapsed = timeStats && numberAttribute(timeStats, "ElapsedTime");
    const elapsedTimeInMs =
        queryElapsed === undefined && maximumElapsed === undefined
            ? undefined
            : Math.max(queryElapsed ?? 0, maximumElapsed ?? 0);
    return {
        ...graph,
        root: {
            ...graph.root,
            liveQueryStatistics: { elapsedTimeInMs },
            children: [rootOperator],
        },
        liveQueryStatistics: {
            // A finished plan has no progress estimate (live plans only).
            estimatedProgress: undefined,
            elapsedTimeInMs,
        },
    };
}
