/**
 * `DriverConnection.executeForPlan` for PostgreSQL: the statements of a batch run through
 * `EXPLAIN (FORMAT JSON, VERBOSE ...)`, one plan document per statement.
 *
 *   estimated: EXPLAIN only. Nothing runs; a statement EXPLAIN does not apply to is not sent.
 *   actual:    EXPLAIN ANALYZE. The statement really runs, its effects stay (no wrapping
 *              transaction, no rollback), and its rows are not returned: the plan is.
 *
 * Statements EXPLAIN does not apply to run as `execute` runs them in an actual plan. Errors and
 * cancellation are those of `execute` (the statement loop is the same, see executeScript).
 */

import type { Batch, ExecuteEventHandler, ExecutionPlanKind } from "../../types";
import {
    executeScript,
    refreshTypeNames,
    runStatement,
    type ExecutionSession,
    type StatementRunner,
} from "../execute";
import { classifyStatement, explainPrefix } from "./explain";

export function executeScriptForPlan(
    session: ExecutionSession,
    batch: Batch,
    kind: ExecutionPlanKind,
    serverMajorVersion: number | undefined,
    onEvent: ExecuteEventHandler,
    signal: AbortSignal,
): Promise<void> {
    return executeScript(session, batch, onEvent, signal, planRunner(kind, serverMajorVersion));
}

/** Key of the statement text in the plan document (the one `auto_explain` uses in its JSON logs). */
export const QUERY_TEXT_KEY = "Query Text";

function planRunner(
    kind: ExecutionPlanKind,
    serverMajorVersion: number | undefined,
): StatementRunner {
    const prefix = explainPrefix(kind, serverMajorVersion);
    return async (session, statement, script, emit, getCommandTag, wasCanceled) => {
        const statementClass = classifyStatement(statement.text);
        const asWritten = () =>
            runStatement(session, statement, script, emit, getCommandTag, wasCanceled);

        if (statementClass.type === "explain") {
            if (kind === "estimated" && statementClass.analyze) {
                emit(info("This EXPLAIN ANALYZE was not run: an estimated plan runs nothing."));
                return "done";
            }
            return asWritten();
        }
        if (statementClass.type === "other") {
            if (kind === "actual") return asWritten();
            emit(
                info(
                    `No execution plan exists for this statement (${statementClass.label}): ` +
                        "EXPLAIN does not apply to it, so it was not run.",
                ),
            );
            return "done";
        }

        // EXPLAIN ANALYZE DECLARE runs the query but creates no cursor, so a later FETCH would
        // fail: an actual plan declares the cursor as execute does.
        if (kind === "actual" && statementClass.declare) return asWritten();

        // The error position refers to the text sent: shift it back to the statement's own text.
        const explained = {
            text: prefix + statement.text,
            start: statement.start - prefix.length,
        };
        let planText = "";
        const outcome = await runStatement(
            session,
            explained,
            script,
            (event) => {
                if (event.type === "rows")
                    planText += event.rows.map((r) => r[0].displayValue).join("");
                // The tag ("EXPLAIN") says nothing to the user: replaced below.
                if (event.type === "message" && !event.isError && event.text === "EXPLAIN") return;
                return emit(event);
            },
            getCommandTag,
            wasCanceled,
        );
        if (outcome === "failed") return "failed";

        // The table or view just created has a row type the session does not know yet.
        if (kind === "actual" && statementClass.creates) await refreshTypeNames(session);
        const content = withQueryText(planText, statement.text);
        if (content === undefined) {
            // Legitimate: CREATE TABLE IF NOT EXISTS ... AS on an existing table, a statement a
            // rule rewrote to nothing. The statement went through; it just has no plan.
            emit(info("The server returned no plan for this statement."));
            return "done";
        }
        emit({ type: "executionPlan", content });
        emit(
            info(
                kind === "estimated"
                    ? "Estimated plan (EXPLAIN): the statement was not run."
                    : "Actual plan (EXPLAIN ANALYZE): the statement was run; its rows are not returned.",
            ),
        );
        return "done";
    };
}

const info = (text: string) => ({ type: "message" as const, text, isError: false });

/**
 * The EXPLAIN JSON with the statement text added under "Query Text": a self-contained document,
 * which `parse` reads later without a connection. Undefined when `planText` is not EXPLAIN JSON.
 */
function withQueryText(planText: string, statement: string): string | undefined {
    try {
        const plans: unknown = JSON.parse(planText);
        if (!Array.isArray(plans) || plans.length === 0) return undefined;
        const documents = plans.map((plan) => {
            if (typeof plan !== "object" || plan === null || !("Plan" in plan)) {
                throw new Error("not a plan");
            }
            return { [QUERY_TEXT_KEY]: statement, ...plan };
        });
        return JSON.stringify(documents, null, 2);
    } catch {
        return undefined;
    }
}
