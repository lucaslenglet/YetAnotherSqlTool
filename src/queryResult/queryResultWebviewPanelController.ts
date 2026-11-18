/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql: results of one editor shown in their own editor tab.

import * as vscode from "vscode";
import * as qr from "../sharedInterfaces/queryResult";
import { WebviewPanelController } from "../controllers/webviewPanelController";
import {
    QUERY_RESULT_WEBVIEW_SOURCE,
    QueryResultWebviewController,
} from "./queryResultWebViewController";
import { registerCommonRequestHandlers } from "./utils";

export class QueryResultWebviewPanelController extends WebviewPanelController<
    qr.QueryResultWebviewState,
    qr.QueryResultReducers
> {
    constructor(
        context: vscode.ExtensionContext,
        private _viewColumn: vscode.ViewColumn,
        private _uri: string,
        title: string,
        private _queryResultWebviewViewController: QueryResultWebviewController,
    ) {
        super(
            context,
            QUERY_RESULT_WEBVIEW_SOURCE,
            "yastQueryResult",
            {
                resultSetSummaries: {},
                messages: [],
                tabStates: {
                    resultPaneTab: qr.QueryResultPaneTabs.Messages,
                },
                executionPlanState: {},
                fontSettings: {},
                isExecuting: false,
            },
            {
                title: title,
                viewColumn: _viewColumn,
                preserveFocus: true,
                iconPath: {
                    dark: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "queryResultView_dark.svg",
                    ),
                    light: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "queryResultView_light.svg",
                    ),
                },
            },
        );

        registerCommonRequestHandlers(this);
        this.onRequest(qr.GetWebviewLocationRequest.type, async () => {
            return qr.QueryResultWebviewLocation.Document;
        });
        this.panel.onDidChangeViewState((params) => {
            // Remember the column so the panel is revealed where the user moved it.
            if (params.webviewPanel.viewColumn) {
                this._viewColumn = params.webviewPanel.viewColumn;
            }
        });
    }

    public override dispose(): void {
        super.dispose();
        void this._queryResultWebviewViewController.removePanel(this._uri);
    }

    public override revealToForeground() {
        this.panel.reveal(this._viewColumn, true);
    }

    public getQueryResultWebviewViewController(): QueryResultWebviewController {
        return this._queryResultWebviewViewController;
    }

    public get viewColumn(): vscode.ViewColumn {
        return this._viewColumn;
    }
}
