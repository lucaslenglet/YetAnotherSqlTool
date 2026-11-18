/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from vscode-mssql: sqltoolsservice's queryExecutionPlan/getExecutionPlan request is
// replaced by the converter of the driver (`Driver.executionPlan.parse`). Plan comparison and
// live query statistics are not ported.

import type { ExecutionPlanSupport } from "../drivers/types";
import { getLogger } from "../models/logger";
import * as ep from "../sharedInterfaces/executionPlan";

const logger = getLogger("ExecutionPlanService");

export class ExecutionPlanService implements Pick<ep.ExecutionPlanService, "getExecutionPlan"> {
    /** `support` is the execution plan converter of the engine the plans come from. */
    constructor(private readonly _support: ExecutionPlanSupport) {}

    async getExecutionPlan(
        planFile: ep.ExecutionPlanGraphInfo,
    ): Promise<ep.GetExecutionPlanResult> {
        try {
            const graphs = this._support.parse(planFile.graphFileContent);
            return {
                success: true,
                errorMessage: "",
                // Every graph keeps the document it comes from: "Open XML" and "Save Plan" use it,
                // and a link to that document in the grid finds its plan by it.
                graphs: graphs.map((graph, index) => ({
                    ...graph,
                    graphFile: {
                        ...graph.graphFile,
                        ...planFile,
                        planIndexInFile: graph.graphFile?.planIndexInFile ?? index,
                    },
                })),
            };
        } catch (e) {
            logger.error("Failed to get execution plan", e);
            throw e;
        }
    }
}
