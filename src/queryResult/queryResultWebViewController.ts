/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql: execution plans, live query statistics, the legacy
// grid switch and telemetry removed. The results of the active editor are shown
// in the "Query Results" view of the bottom panel, or in their own editor tab.

import * as vscode from "vscode";
import * as qr from "../sharedInterfaces/queryResult";
import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import { WebviewViewController } from "../controllers/webviewViewController";
import { QueryResultWebviewPanelController } from "./queryResultWebviewPanelController";
import {
    getNewResultPaneViewColumn,
    getInMemoryGridDataProcessingThreshold,
    messageToString,
    registerCommonRequestHandlers,
} from "./utils";
import { getUriKey } from "../utils/utils";
import type { QueryManager } from "../queries/queryManager";

export const QUERY_RESULT_VIEW_ID = "yastQueryResult";
export const QUERY_RESULT_WEBVIEW_SOURCE = "queryResult";

export class QueryResultWebviewController extends WebviewViewController<
    qr.QueryResultWebviewState,
    qr.QueryResultReducers
> {
    private _queryResultStateMap: Map<string, qr.QueryResultWebviewState> = new Map<
        string,
        qr.QueryResultWebviewState
    >();
    private _queryResultWebviewPanelControllerMap: Map<string, QueryResultWebviewPanelController> =
        new Map<string, QueryResultWebviewPanelController>();
    private _queryManager: QueryManager;

    constructor(context: vscode.ExtensionContext) {
        super(context, QUERY_RESULT_WEBVIEW_SOURCE, QUERY_RESULT_VIEW_ID, {
            resultSetSummaries: {},
            messages: [],
            tabStates: {
                resultPaneTab: qr.QueryResultPaneTabs.Messages,
            },
            fontSettings: {},
            gridSettings: {},
            autoSizeColumnsMode: qr.ResultsGridAutoSizeStyle.HeadersAndData,
            isExecuting: false,
            executionElapsedMilliseconds: undefined,
            rowsAffected: undefined,
        });

        registerCommonRequestHandlers(this);
        this.onRequest(qr.OpenInNewTabRequest.type, async (message) => {
            void this.createPanelController(message.uri);
        });
        this.onRequest(qr.GetWebviewLocationRequest.type, async () => {
            return qr.QueryResultWebviewLocation.Panel;
        });

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                let stateChanged = false;
                if (
                    e.affectsConfiguration(`${Constants.extensionName}.resultsFontFamily`) ||
                    e.affectsConfiguration(`${Constants.extensionName}.resultsFontSize`)
                ) {
                    for (const state of this._queryResultStateMap.values()) {
                        state.fontSettings = this.getFontSettings();
                    }
                    stateChanged = true;
                }
                if (
                    e.affectsConfiguration(
                        `${Constants.extensionName}.${Constants.configAutoColumnSizingMode}`,
                    )
                ) {
                    for (const state of this._queryResultStateMap.values()) {
                        state.autoSizeColumnsMode = this.getAutoSizeColumnsConfig();
                    }
                    stateChanged = true;
                }
                if (e.affectsConfiguration(Constants.configInMemoryDataProcessingThreshold)) {
                    for (const state of this._queryResultStateMap.values()) {
                        state.inMemoryDataProcessingThreshold =
                            getInMemoryGridDataProcessingThreshold();
                    }
                    stateChanged = true;
                }
                if (e.affectsConfiguration(`${Constants.extensionName}.resultsGrid`)) {
                    for (const state of this._queryResultStateMap.values()) {
                        state.gridSettings = this.getGridSettingsConfig();
                    }
                    stateChanged = true;
                }
                if (stateChanged) {
                    for (const uri of this._queryResultStateMap.keys()) {
                        this.updatePanelState(uri);
                    }
                    if (this.isVisible() && this.state?.uri) {
                        const currentUri = this.state.uri;
                        if (this._queryResultStateMap.has(currentUri)) {
                            this.state = this.getQueryResultState(currentUri);
                        }
                    }
                }
            }),
        );
    }

    public set queryManager(queryManager: QueryManager) {
        this._queryManager = queryManager;
    }

    public get queryManager(): QueryManager {
        return this._queryManager;
    }

    public updateResultsOnActiveEditorChange(editor: vscode.TextEditor | undefined): void {
        const uri = getUriKey(editor?.document?.uri);
        if (uri && this._queryResultStateMap.has(uri)) {
            if (this.hasPanel(uri)) {
                const autoReveal = vscode.workspace
                    .getConfiguration()
                    .get<boolean>(Constants.configAutoRevealResultsPanel);
                const panelViewColumn =
                    this._queryResultWebviewPanelControllerMap.get(uri).viewColumn;
                if (autoReveal && editor?.viewColumn !== panelViewColumn) {
                    this.revealPanel(uri);
                }
                this.showSplashScreen();
            } else {
                this.state = this.getQueryResultState(uri);
            }
        } else if (editor) {
            // Only another editor clears the view: focusing the results view itself
            // (or any webview) leaves no active text editor and keeps them shown.
            this.showSplashScreen();
        }
    }

    private showSplashScreen() {
        this.state = {
            resultSetSummaries: {},
            messages: [],
            tabStates: undefined,
            isExecuting: false,
            executionElapsedMilliseconds: undefined,
            rowsAffected: undefined,
            fontSettings: this.getFontSettings(),
            gridSettings: this.getGridSettingsConfig(),
            autoSizeColumnsMode: this.getAutoSizeColumnsConfig(),
            inMemoryDataProcessingThreshold: getInMemoryGridDataProcessingThreshold(),
            initializationError: undefined,
        };
    }

    public async createPanelController(uri: string) {
        const viewColumn = getNewResultPaneViewColumn(uri);
        if (this._queryResultWebviewPanelControllerMap.has(uri)) {
            this._queryResultWebviewPanelControllerMap.get(uri).revealToForeground();
            return;
        }

        const controller = new QueryResultWebviewPanelController(
            this._context,
            viewColumn,
            uri,
            this._queryResultStateMap.get(uri).title,
            this,
        );
        controller.state = this.getQueryResultState(uri);
        controller.revealToForeground();
        this._queryResultWebviewPanelControllerMap.set(uri, controller);
        this.showSplashScreen();
    }

    public addQueryResultState(uri: string, title: string): void {
        const currentState: qr.QueryResultWebviewState = {
            resultSetSummaries: {},
            messages: [],
            tabStates: {
                resultPaneTab: qr.QueryResultPaneTabs.Messages,
                resultViewMode: this.getDefaultViewModeConfig(),
            },
            uri: uri,
            title: title,
            fontSettings: this.getFontSettings(),
            gridSettings: this.getGridSettingsConfig(),
            autoSizeColumnsMode: this.getAutoSizeColumnsConfig(),
            inMemoryDataProcessingThreshold: getInMemoryGridDataProcessingThreshold(),
            isExecuting: false,
            executionElapsedMilliseconds: undefined,
            rowsAffected: undefined,
        };
        this._queryResultStateMap.set(uri, currentState);
    }

    public getFontSettings(): qr.FontSettings {
        const config = vscode.workspace.getConfiguration(Constants.extensionName);
        return {
            fontSize:
                (config.get(Constants.extConfigResultKeys.ResultsFontSize) as number) ??
                (vscode.workspace.getConfiguration("editor").get("fontSize") as number),
            fontFamily: config.get(Constants.extConfigResultKeys.ResultsFontFamily) as string,
        };
    }

    public getAutoSizeColumnsConfig(): qr.ResultsGridAutoSizeStyle {
        const configValue = vscode.workspace
            .getConfiguration(Constants.extensionName)
            .get(Constants.configAutoColumnSizingMode) as
            qr.ResultsGridAutoSizeStyle | boolean | undefined;

        if (typeof configValue === "string") {
            const validModes = Object.values(qr.ResultsGridAutoSizeStyle);
            if (validModes.includes(configValue as qr.ResultsGridAutoSizeStyle)) {
                return configValue as qr.ResultsGridAutoSizeStyle;
            }
        }
        if (configValue === false) {
            return qr.ResultsGridAutoSizeStyle.Off;
        }
        return qr.ResultsGridAutoSizeStyle.HeadersAndData;
    }

    public getGridSettingsConfig(): qr.GridSettings {
        const config = vscode.workspace.getConfiguration(Constants.extensionName);
        const validGridLineModes: qr.GridLinesMode[] = ["both", "horizontal", "vertical", "none"];
        const gridLinesValue = config.get(Constants.configResultsGridShowGridLines) as string;
        const showGridLines: qr.GridLinesMode = validGridLineModes.includes(
            gridLinesValue as qr.GridLinesMode,
        )
            ? (gridLinesValue as qr.GridLinesMode)
            : "both";
        return {
            alternatingRowColors:
                (config.get(Constants.configResultsGridAlternatingRowColors) as boolean) ?? false,
            freezeFirstColumnByDefault:
                (config.get(Constants.configResultsGridFreezeFirstColumnByDefault) as boolean) ??
                false,
            showGridLines,
            rowPadding: config.get(Constants.configResultsGridRowPadding) as number | undefined,
            rightAlignNumbers:
                (config.get(Constants.configResultsGridRightAlignNumbers) as boolean) ?? false,
        };
    }

    public getDefaultViewModeConfig(): qr.QueryResultViewMode {
        const configValue = vscode.workspace
            .getConfiguration(Constants.extensionName)
            .get("defaultQueryResultsViewMode") as string;
        return (
            qr.QueryResultViewMode[configValue as keyof typeof qr.QueryResultViewMode] ??
            qr.QueryResultViewMode.Grid
        );
    }

    public setQueryResultState(uri: string, state: qr.QueryResultWebviewState) {
        this._queryResultStateMap.set(uri, state);
    }

    public updateSelectionState(
        uri: string,
        gridId: string,
        selection: qr.ISlickRange[],
        displaySelection: qr.ISlickRange[],
    ): void {
        const state = this._queryResultStateMap.get(uri);
        if (!state) {
            return;
        }
        state.selection = selection;
        state.gridSelections = {
            ...(state.gridSelections ?? {}),
            [gridId]: displaySelection,
        };
        this.pushState(uri, state);
    }

    /** Sends the stored state of `uri` to wherever its results are shown. */
    public pushState(uri: string, state: qr.QueryResultWebviewState): void {
        this._queryResultStateMap.set(uri, state);
        if (this._queryResultWebviewPanelControllerMap.has(uri)) {
            this.updatePanelState(uri);
        } else if (
            getUriKey(vscode.window.activeTextEditor?.document.uri) === uri ||
            this.state?.uri === uri
        ) {
            // Results of another editor do not replace what the view shows.
            this.state = state;
        }
    }

    public hasQueryResultState(uri: string): boolean {
        return this._queryResultStateMap.has(uri);
    }

    public deleteQueryResultState(uri: string): void {
        this._queryResultStateMap.delete(uri);
        if (this.state?.uri === uri) {
            this.showSplashScreen();
        }
    }

    public updatePanelState(uri: string): void {
        if (this._queryResultWebviewPanelControllerMap.has(uri)) {
            this._queryResultWebviewPanelControllerMap
                .get(uri)
                .updateState(this.getQueryResultState(uri));
        }
    }

    public async removePanel(uri: string): Promise<void> {
        if (this._queryResultWebviewPanelControllerMap.has(uri)) {
            this._queryResultWebviewPanelControllerMap.delete(uri);

            const documentStillOpen = vscode.workspace.textDocuments.some(
                (doc) => getUriKey(doc.uri) === uri,
            );
            if (documentStillOpen) {
                // Keep the results: they come back in the view when the editor is active.
                const activeDocumentUri = getUriKey(vscode.window.activeTextEditor?.document?.uri);
                if (activeDocumentUri === uri && this.isVisible()) {
                    this.state = this.getQueryResultState(uri);
                }
            } else {
                this._queryResultStateMap.delete(uri);
                this._queryManager?.cleanupRunner(uri);
            }
        }
    }

    public hasPanel(uri: string): boolean {
        return this._queryResultWebviewPanelControllerMap.has(uri);
    }

    public revealPanel(uri: string): void {
        if (this.hasPanel(uri)) {
            this._queryResultWebviewPanelControllerMap.get(uri).revealToForeground();
        }
    }

    public getQueryResultState(uri: string): qr.QueryResultWebviewState {
        const res = this._queryResultStateMap.get(uri);
        if (!res) {
            throw new Error(`No query result state found for uri ${uri}`);
        }
        return res;
    }

    public getContext(): vscode.ExtensionContext {
        return this._context;
    }

    public async copyAllMessagesToClipboard(uri: string): Promise<void> {
        const includeTimestamps = vscode.workspace
            .getConfiguration(
                Constants.extensionConfigSectionName,
                uri ? vscode.Uri.parse(uri) : undefined,
            )
            .get<boolean>(Constants.configMessagesCopyIncludeTimestamps, false);
        const messages = (uri ? this._queryResultStateMap.get(uri) : this.state)?.messages?.map(
            (message) => messageToString(message, includeTimestamps),
        );
        if (!messages) {
            return;
        }
        await vscode.env.clipboard.writeText(messages.join("\n"));
    }

    public showFilterDisabledMessage(): void {
        vscode.window.showInformationMessage(
            LocalizedConstants.inMemoryDataProcessingThresholdExceeded,
        );
    }
}
