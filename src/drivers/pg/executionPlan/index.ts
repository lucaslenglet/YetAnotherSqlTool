import type { ExecutionPlanSupport } from "../../types";
import { parsePgPlan } from "./parse";

/** `Driver.executionPlan` of PostgreSQL. */
export const pgExecutionPlan: ExecutionPlanSupport = {
    fileExtension: "json",
    documentLanguage: "json",
    parse: parsePgPlan,
};

export { executeScriptForPlan } from "./executeForPlan";
export { majorVersion } from "./explain";
