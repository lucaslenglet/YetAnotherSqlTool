/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql: plan comparison removed; the plan document is the one of the
// driver it comes from (`ExecutionPlanSupport`).

import * as ep from "../sharedInterfaces/executionPlan";
import * as vscode from "vscode";
import type { ExecutionPlanSupport } from "../drivers/types";
import { ApiStatus } from "../sharedInterfaces/webview";
import { WebviewPanelController } from "./webviewPanelController";
import {
    createExecutionPlanGraphs,
    getPlanGraphFileType,
    OpenQueryEditor,
    saveExecutionPlan,
    showPlanXml,
    showQuery,
    updateTotalCost,
} from "./sharedExecutionPlanUtils";
import { ExecutionPlanService } from "../services/executionPlanService";

export class ExecutionPlanWebviewController extends WebviewPanelController<
    ep.ExecutionPlanWebviewState,
    ep.ExecutionPlanReducers
> {
    constructor(
        context: vscode.ExtensionContext,
        public executionPlanService: ExecutionPlanService, // public for testing purposes
        public openQueryEditor: OpenQueryEditor,
        public planSupport: ExecutionPlanSupport,
        public executionPlanContents: string,
        xmlPlanFileName: string,
    ) {
        super(
            context,
            "executionPlan",
            "executionPlan",
            {
                executionPlanState: {
                    loadState: ApiStatus.Loading,
                    executionPlanGraphs: [],
                    totalCost: 0,
                },
            },
            {
                title: `${xmlPlanFileName}`, // Sets the webview title
                viewColumn: vscode.ViewColumn.Active, // Sets the view column of the webview
                iconPath: {
                    dark: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "executionPlan_dark.svg",
                    ),
                    light: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "executionPlan_light.svg",
                    ),
                },
            },
        );
        void this.initialize();
    }

    private async initialize() {
        this.state.executionPlanState.loadState = ApiStatus.Loading;
        this.updateState();
        this.registerRpcHandlers();
    }

    private registerRpcHandlers() {
        this.registerReducer("getExecutionPlan", async (state, _payload) => {
            return createExecutionPlanGraphs(
                state,
                this.executionPlanService,
                [this.executionPlanContents],
                getPlanGraphFileType(this.planSupport),
            );
        });
        this.registerReducer("saveExecutionPlan", async (state, payload) => {
            return saveExecutionPlan(state, payload, this.planSupport);
        });
        this.registerReducer("showPlanXml", async (state, payload) => {
            return showPlanXml(state, payload, this.planSupport);
        });
        this.registerReducer("showQuery", async (state, payload) => {
            return showQuery(state, payload, this.openQueryEditor);
        });
        this.registerReducer("updateTotalCost", async (state, payload) => {
            return updateTotalCost(state, payload);
        });
    }
}
