/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql: plan comparison and telemetry removed. The plan document is the
// one of the driver (`ExecutionPlanSupport`): showplan XML saved as .sqlplan for SQL Server,
// EXPLAIN JSON for PostgreSQL, instead of always XML. SqlDocumentService.newQuery is replaced
// by an `OpenQueryEditor` function.

import { getErrorMessage, getUniqueFilePath, formatXml } from "../utils/utils";
import { homedir } from "os";
import {
    ExecutionPlanGraphInfo,
    ExecutionPlanReducers,
    ExecutionPlanWebviewState,
} from "../sharedInterfaces/executionPlan";
import { ExecutionPlanService } from "../services/executionPlanService";
import { QueryResultWebviewState } from "../sharedInterfaces/queryResult";
import * as vscode from "vscode";
import type { ExecutionPlanSupport } from "../drivers/types";
import { ApiStatus } from "../sharedInterfaces/webview";
import {
    executionPlanDocumentFileFilter,
    executionPlanFileFilter,
} from "../constants/locConstants";
import { sqlPlanLanguageId } from "../constants/constants";
import { ExecutionPlanWebviewController } from "./executionPlanWebviewController";

/**
 * Opens a new SQL editor with `content`. With `sourceUri`, the new editor connects like that
 * editor (vscode-mssql's ConnectionStrategy.CopyFromUri), else it stays disconnected.
 */
export type OpenQueryEditor = (content: string, sourceUri?: string) => Promise<void>;

export function openExecutionPlanWebview(
    context: vscode.ExtensionContext,
    executionPlanService: ExecutionPlanService,
    openQueryEditor: OpenQueryEditor,
    planSupport: ExecutionPlanSupport,
    planContents: string,
    docName: string,
) {
    const executionPlanController = new ExecutionPlanWebviewController(
        context,
        executionPlanService,
        openQueryEditor,
        planSupport,
        planContents,
        docName,
    );

    executionPlanController.revealToForeground();
}

export async function saveExecutionPlan(
    state: QueryResultWebviewState | ExecutionPlanWebviewState,
    payload: ExecutionPlanReducers["saveExecutionPlan"],
    planSupport: Pick<ExecutionPlanSupport, "fileExtension">,
) {
    let folder = vscode.Uri.file(homedir());

    // Show a save dialog to the user
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: await getUniqueFilePath(folder, `plan`, planSupport.fileExtension),
        filters: {
            // "SQL Plan Files" names .sqlplan files only (a PostgreSQL plan is a .json file).
            [planSupport.fileExtension === sqlPlanLanguageId
                ? executionPlanFileFilter
                : executionPlanDocumentFileFilter]: [`${planSupport.fileExtension}`],
        },
    });

    if (saveUri) {
        // Write the content to the new file
        void vscode.workspace.fs.writeFile(
            saveUri,
            new TextEncoder().encode(payload.sqlPlanContent),
        );
    }

    return state;
}

export async function showPlanXml(
    state: QueryResultWebviewState | ExecutionPlanWebviewState,
    payload: ExecutionPlanReducers["showPlanXml"],
    planSupport: Pick<ExecutionPlanSupport, "documentLanguage">,
) {
    const planXmlDoc = await vscode.workspace.openTextDocument({
        content: formatPlanDocument(payload.sqlPlanContent, planSupport.documentLanguage),
        language: planSupport.documentLanguage,
    });

    void vscode.window.showTextDocument(planXmlDoc);

    return state;
}

/** Indents a plan document for reading, as the grid does for an XML or JSON cell. */
function formatPlanDocument(content: string, language: string): string {
    if (language === "xml") {
        return formatXml(content);
    }
    if (language === "json") {
        try {
            return JSON.stringify(JSON.parse(content), undefined, 2);
        } catch {
            // Not valid JSON: show it as is.
        }
    }
    return content;
}

export async function showQuery(
    state: QueryResultWebviewState | ExecutionPlanWebviewState,
    payload: ExecutionPlanReducers["showQuery"],
    openQueryEditor: OpenQueryEditor,
    uri?: string,
) {
    void openQueryEditor(payload.query, uri);

    return state;
}

export async function updateTotalCost(
    state: QueryResultWebviewState | ExecutionPlanWebviewState,
    payload: ExecutionPlanReducers["updateTotalCost"],
) {
    return {
        ...state,
        executionPlanState: {
            ...state.executionPlanState,
            totalCost: (state.executionPlanState.totalCost += payload.addedCost),
        },
    };
}

/**
 * Creates the execution plan graph state from plan documents, and loads them into `state`
 * @param graphFileType the file type of the documents (".sqlplan" for showplan XML).
 */
export async function createExecutionPlanGraphs(
    state: QueryResultWebviewState | ExecutionPlanWebviewState,
    executionPlanService: ExecutionPlanService,
    xmlPlans: string[],
    graphFileType: string,
) {
    let newState = {
        ...state.executionPlanState,
    };

    for (const plan of xmlPlans) {
        const planFile: ExecutionPlanGraphInfo = {
            graphFileContent: plan,
            graphFileType: graphFileType,
        };
        try {
            newState.executionPlanGraphs = newState.executionPlanGraphs.concat(
                (await executionPlanService.getExecutionPlan(planFile)).graphs,
            );
            newState.loadState = ApiStatus.Loaded;
        } catch (e) {
            // Errors out on first instance of malformed xml
            newState.loadState = ApiStatus.Error;
            newState.errorMessage = getErrorMessage(e);
            state.executionPlanState = newState;
            return state;
        }
    }

    state.executionPlanState = newState;
    state.executionPlanState.totalCost = calculateTotalCost(state);

    return state;
}

export function calculateTotalCost(
    state: QueryResultWebviewState | ExecutionPlanWebviewState,
): number {
    if (!state.executionPlanState.executionPlanGraphs) {
        state.executionPlanState.loadState = ApiStatus.Error;
        return 0;
    }

    let sum = 0;
    for (const graph of state.executionPlanState.executionPlanGraphs) {
        sum += graph.root.cost + graph.root.subTreeCost;
    }
    return sum;
}

/** File type of the plan documents of an engine, as `ExecutionPlanGraphInfo.graphFileType`. */
export function getPlanGraphFileType(planSupport: Pick<ExecutionPlanSupport, "fileExtension">) {
    return `.${planSupport.fileExtension}`;
}
