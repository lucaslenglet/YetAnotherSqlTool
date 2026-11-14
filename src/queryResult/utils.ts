/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql: execution plan, grid mode switch and telemetry removed.
// Requests about rows, copy and selection go to the QueryManager instead of
// sqltoolsservice.

import * as Constants from "../constants/constants";
import * as vscode from "vscode";
import * as qr from "../sharedInterfaces/queryResult";
import { QueryResultWebviewPanelController } from "./queryResultWebviewPanelController";
import { QueryResultWebviewController } from "./queryResultWebViewController";
import store, { QueryResultSingletonStore } from "./singletonStore";
import { formatXml } from "../utils/utils";

export const MAX_VIEW_COLUMN = 9;

export function getNewResultPaneViewColumn(uri: string): vscode.ViewColumn {
    const config = vscode.workspace.getConfiguration(
        Constants.extensionConfigSectionName,
        vscode.Uri.parse(uri),
    );
    const splitPaneSelection = config.get<string>(Constants.configSplitPaneSelection);

    switch (splitPaneSelection) {
        case "current":
            return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        case "end": {
            const maxViewColumn = vscode.window.visibleTextEditors.reduce((max, editor) => {
                return editor.viewColumn && editor.viewColumn > max ? editor.viewColumn : max;
            }, 0);
            return Math.min(maxViewColumn + 1, MAX_VIEW_COLUMN) as vscode.ViewColumn;
        }
        case "next":
        default: {
            const currentEditor = vscode.window.visibleTextEditors.find((editor) => {
                return editor.document.uri.toString() === uri && editor.viewColumn !== undefined;
            });
            if (!currentEditor) {
                return vscode.ViewColumn.One;
            }
            return Math.min(
                (currentEditor.viewColumn ?? 1) + 1,
                MAX_VIEW_COLUMN,
            ) as vscode.ViewColumn;
        }
    }
}

export function registerCommonRequestHandlers(
    webviewController: QueryResultWebviewController | QueryResultWebviewPanelController,
) {
    const webviewViewController: QueryResultWebviewController =
        webviewController instanceof QueryResultWebviewController
            ? webviewController
            : webviewController.getQueryResultWebviewViewController();
    const queries = () => webviewViewController.queryManager;

    webviewController.onRequest(qr.CloseResultsPanelRequest.type, async () => {
        await vscode.commands.executeCommand("workbench.action.closePanel");
    });

    webviewController.onRequest(qr.HandleSelectionSummaryRequest.type, async (uri) => {
        // Click on the summary of a large selection: load it, or cancel the loading.
        queries().handleSelectionSummary(uri);
    });

    webviewController.onRequest(qr.GetRowsRequest.type, async (message) => {
        return queries().getRows(
            message.uri,
            message.batchId,
            message.resultId,
            message.rowStart,
            message.numberOfRows,
        );
    });

    webviewController.onRequest(qr.SetEditorSelectionRequest.type, async (message) => {
        if (!message.uri || !message.selectionData) {
            return;
        }
        await queries().setEditorSelection(message.uri, message.selectionData);
    });

    webviewController.onRequest(qr.SaveResultsWebviewRequest.type, async (message) => {
        await queries().saveResults(message);
    });

    webviewController.onRequest(qr.CopySelectionRequest.type, async (message) => {
        await queries().copySelection(
            message.uri,
            message.batchId,
            message.resultId,
            message.selection,
            shouldIncludeHeaders(message.includeHeaders),
        );
    });

    webviewController.onRequest(qr.CopyHeadersRequest.type, async (message) => {
        await queries().copyHeaders(
            message.uri,
            message.batchId,
            message.resultId,
            message.selection,
        );
    });

    webviewController.onRequest(qr.CopyAsCsvRequest.type, async (message) => {
        await queries().copyAs("csv", message);
    });

    webviewController.onRequest(qr.CopyAsJsonRequest.type, async (message) => {
        await queries().copyAs("json", message);
    });

    webviewController.onRequest(qr.CopyAsInClauseRequest.type, async (message) => {
        await queries().copyAs("in-clause", message);
    });

    webviewController.onRequest(qr.CopyAsInsertIntoRequest.type, async (message) => {
        await queries().copyAs("insert-into", message);
    });

    webviewController.onRequest(qr.CopyColumnNameRequest.type, async (message) => {
        await vscode.env.clipboard.writeText(message.columnName);
    });

    // Grid state kept per editor while VS Code runs: filters, widths, scroll positions...
    webviewController.onRequest(qr.GetFiltersRequest.type, async (message) => {
        return store.gridState.gridColumnFilters.get(
            QueryResultSingletonStore.generateGridKey(message.uri, message.gridId),
        );
    });

    webviewController.onRequest(qr.SetFiltersRequest.type, async (message) => {
        const key = QueryResultSingletonStore.generateGridKey(message.uri, message.gridId);
        store.gridState.gridColumnFilters.set(key, message.filters);
        // Clear scroll position when filters change
        store.gridState.gridScrollPositions.delete(key);
    });

    webviewController.onRequest(qr.SetColumnWidthsRequest.type, async (message) => {
        store.gridState.gridColumnWidths.set(
            QueryResultSingletonStore.generateGridKey(message.uri, message.gridId),
            message.columnWidths,
        );
    });

    webviewController.onRequest(qr.GetColumnWidthsRequest.type, async (message) => {
        return store.gridState.gridColumnWidths.get(
            QueryResultSingletonStore.generateGridKey(message.uri, message.gridId),
        );
    });

    webviewController.onRequest(qr.SetGridViewStateRequest.type, async (message) => {
        store.gridState.gridViewStates.set(
            QueryResultSingletonStore.generateGridKey(message.uri, message.gridId),
            message.gridViewState,
        );
    });

    webviewController.onRequest(qr.GetGridViewStateRequest.type, async (message) => {
        return store.gridState.gridViewStates.get(
            QueryResultSingletonStore.generateGridKey(message.uri, message.gridId),
        );
    });

    webviewController.onNotification(qr.SetGridScrollPositionNotification.type, async (message) => {
        store.gridState.gridScrollPositions.set(
            QueryResultSingletonStore.generateGridKey(message.uri, message.gridId),
            {
                scrollLeft: message.scrollLeft,
                scrollTop: message.scrollTop,
                scrollTopOffset: message.scrollTopOffset,
            },
        );
    });

    webviewController.onRequest(qr.GetGridScrollPositionRequest.type, async (message) => {
        return store.gridState.gridScrollPositions.get(
            QueryResultSingletonStore.generateGridKey(message.uri, message.gridId),
        );
    });

    webviewController.onNotification(
        qr.SetGridPaneScrollPositionNotification.type,
        async (message) => {
            store.gridState.resultsTabYOffsets.set(message.uri, message.scrollTop);
        },
    );

    webviewController.onRequest(qr.GetGridPaneScrollPositionRequest.type, async (message) => {
        return {
            scrollTop: store.gridState.resultsTabYOffsets.get(message.uri) || 0,
        };
    });

    webviewController.onNotification(
        qr.SetMessagesTabScrollPositionNotification.type,
        async (message) => {
            store.gridState.messagesTabYOffsets.set(message.uri, message.scrollTop);
        },
    );

    webviewController.onRequest(qr.GetMessagesTabScrollPositionRequest.type, async (message) => {
        return {
            scrollTop: store.gridState.messagesTabYOffsets.get(message.uri) || 0,
        };
    });

    webviewController.onNotification(qr.SetMaximizedGridNotification.type, async (message) => {
        store.gridState.maximizedGridIds.set(message.uri, message.gridId);
    });

    webviewController.onRequest(qr.GetMaximizedGridRequest.type, (message) => {
        return {
            gridId: store.gridState.maximizedGridIds.get(message.uri) || undefined,
        };
    });

    webviewController.onNotification(qr.SetSelectionSummaryRequest.type, async (message) => {
        webviewViewController.updateSelectionState(
            message.uri,
            message.gridId,
            message.selection,
            message.displaySelection,
        );
        queries().updateSelectionSummary(
            message.uri,
            message.batchId,
            message.resultId,
            message.selection,
        );
    });

    webviewController.registerReducer("setResultTab", async (state, payload) => {
        state.tabStates.resultPaneTab = payload.tabId;
        return state;
    });
    webviewController.registerReducer("setResultViewMode", async (state, payload) => {
        if (!state.tabStates) {
            state.tabStates = {
                resultPaneTab: qr.QueryResultPaneTabs.Results,
                resultViewMode: payload.viewMode,
            };
        } else {
            state.tabStates.resultViewMode = payload.viewMode;
        }
        return state;
    });
    webviewController.registerReducer("openFileThroughLink", async (state, payload) => {
        // XML and JSON cells open in a new untitled editor, formatted.
        let formattedText = payload.content;
        if (payload.type === "xml") {
            formattedText = formatXml(payload.content);
        } else if (payload.type === "json") {
            try {
                formattedText = JSON.stringify(JSON.parse(formattedText), undefined, 2);
            } catch {
                // Not valid JSON: show it as is.
            }
        }
        const doc = await vscode.workspace.openTextDocument({
            content: formattedText,
            language: payload.type,
        });
        await vscode.window.showTextDocument(doc);
        return state;
    });
    webviewController.onRequest(qr.ShowFilterDisabledMessageRequest.type, async () => {
        webviewViewController.showFilterDisabledMessage();
    });
}

export function recordLength(record: object): number {
    return Object.keys(record).length;
}

export function messageToString(message: qr.IMessage, includeTimestamp: boolean = false): string {
    const text =
        message.link?.text && !message.message.includes(message.link.text)
            ? `${message.message}${message.link.text}`
            : message.message;
    if (!includeTimestamp || !message.time) {
        return text;
    }
    return text
        .split(/\r?\n/)
        .map((line) => `${message.time}\t${line}`)
        .join("\n");
}

/**
 * Counts the number of result sets in the given summaries.
 */
export function countResultSets(
    resultSetSummaries: Record<number, Record<number, qr.ResultSetSummary>>,
): number {
    let count = 0;
    for (const batch of Object.values(resultSetSummaries)) {
        count += Object.keys(batch).length;
    }
    return count;
}

export function getInMemoryGridDataProcessingThreshold(): number {
    return (
        vscode.workspace
            .getConfiguration()
            .get<number>(Constants.configInMemoryDataProcessingThreshold) ?? 5000
    );
}

export function shouldIncludeHeaders(includeHeaders: boolean | undefined): boolean {
    if (includeHeaders !== undefined) {
        return includeHeaders;
    }
    return vscode.workspace.getConfiguration().get<boolean>(Constants.copyIncludeHeaders) ?? false;
}
