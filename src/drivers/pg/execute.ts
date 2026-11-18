/**
 * Runs a PostgreSQL script: splits it into statements and runs them one after the
 * other on the same session, streaming rows with a cursor.
 */

import type { Client } from "pg";
import Cursor from "pg-cursor";
import {
    QUERY_CANCELED_MESSAGE,
    type Batch,
    type CellValue,
    type ColumnInfo,
    type ExecuteEvent,
    type ExecuteEventHandler,
    type ValueKind,
} from "../types";
import { loadTypeNames } from "./catalog";
import { rawTextTypes } from "./clients";
import { offsetToPosition, splitStatements, type StatementSpan } from "./splitter";

export const ROWS_PER_CHUNK = 500;
/** SQLSTATE of "canceling statement": raised by pg_cancel_backend and by statement_timeout. */
export const QUERY_CANCELED = "57014";

export interface ExecutionSession {
    client: Client;
    /** oid -> type name; refilled in place when types are created. */
    typeNames: Map<number, string>;
    /** Cancels the statement running on `client` (from another connection). */
    cancel(): Promise<void>;
}

/** Runs one statement of a script. "failed" means the rest of the script must not run. */
export type StatementRunner = (
    session: ExecutionSession,
    statement: StatementSpan,
    script: string,
    emit: ExecuteEventHandler,
    getCommandTag: () => string,
    wasCanceled: () => boolean,
) => Promise<"done" | "failed">;

/** `runner` replaces how each statement runs (execution plans); the rest is the same loop. */
export async function executeScript(
    session: ExecutionSession,
    batch: Batch,
    onEvent: ExecuteEventHandler,
    signal: AbortSignal,
    runner: StatementRunner = runStatement,
): Promise<void> {
    let canceled = false;
    const onAbort = () => {
        canceled = true;
        session.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort);

    // The tag of the last finished command ("INSERT 0 3", "CREATE TABLE"...) only comes as a raw protocol message.
    let lastCommandTag = "";
    const connection = (session.client as any).connection;
    const onCommandComplete = (message: { text: string }) => {
        lastCommandTag = message.text;
    };
    const onNotice = (notice: NoticeLike) => void onEvent(noticeMessage(notice));
    connection.on("commandComplete", onCommandComplete);
    session.client.on("notice", onNotice);

    try {
        for (const statement of splitStatements(batch.text)) {
            if (signal.aborted) {
                onEvent(canceledMessage());
                return;
            }
            const outcome = await runner(
                session,
                statement,
                batch.text,
                onEvent,
                () => lastCommandTag,
                () => canceled,
            );
            if (outcome === "failed") return;
        }
        if (signal.aborted) onEvent(canceledMessage());
    } finally {
        signal.removeEventListener("abort", onAbort);
        connection.off("commandComplete", onCommandComplete);
        session.client.off("notice", onNotice);
    }
}

export const runStatement: StatementRunner = async (
    session,
    statement,
    script,
    emit,
    getCommandTag,
    wasCanceled,
) => {
    const cursor: any = session.client.query(
        new Cursor(statement.text, [], { rowMode: "array", types: rawTextTypes }),
    );
    // Errors reach us through read(); this keeps Node from treating them as unhandled.
    cursor.on("error", () => undefined);

    let resultSetOpen = false;
    let rowCount = 0;
    try {
        while (true) {
            const rows: (string | null)[][] = await cursor.read(ROWS_PER_CHUNK);
            const fields: PgField[] = cursor._result.fields;
            if (!resultSetOpen && fields.length > 0) {
                emit({
                    type: "resultSetStart",
                    columns: fields.map((f) => columnInfo(f, session.typeNames)),
                });
                resultSetOpen = true;
            }
            rowCount += rows.length;
            // Waiting here is the backpressure: the server holds the next rows until we ask (the
            // portal is suspended between two reads).
            if (rows.length > 0) await emit({ type: "rows", rows: rows.map(toCells) });
            if (rows.length < ROWS_PER_CHUNK) break;
            if (wasCanceled()) {
                // Between two reads no statement runs, so the server cancel did nothing: stop here.
                await closeCursor(cursor);
                emit({ type: "resultSetEnd", rowCount });
                emit(canceledMessage());
                return "failed";
            }
        }
        if (resultSetOpen) emit({ type: "resultSetEnd", rowCount });
        // For a streamed SELECT the server tag only counts the last chunk.
        const tag =
            resultSetOpen && /^SELECT \d+$/.test(getCommandTag())
                ? `SELECT ${rowCount}`
                : getCommandTag();
        emit({ type: "message", text: tag, isError: false, rowsAffected: rowsAffectedOf(tag) });
        if (/^(CREATE|ALTER|DROP)\b/.test(tag)) await refreshTypeNames(session);
        return "done";
    } catch (error) {
        if (resultSetOpen) emit({ type: "resultSetEnd", rowCount });
        if (!isServerError(error)) throw error;
        if (error.code === QUERY_CANCELED && wasCanceled()) {
            emit(canceledMessage());
        } else {
            emit(errorMessage(error, statement, script));
        }
        return "failed";
    }
};

// ---------------------------------------------------------------------------
// Columns and cells
// ---------------------------------------------------------------------------

export interface PgField {
    name: string;
    dataTypeID: number;
}

const NUMBER_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);
const DATETIME_OIDS = new Set([1082, 1083, 1114, 1184, 1266]);
const BOOLEAN_OID = 16;
const BYTEA_OID = 17;
const JSON_OIDS = new Set([114, 3802]);
const XML_OID = 142;

function kindOf(oid: number): ValueKind {
    if (NUMBER_OIDS.has(oid)) return "number";
    if (oid === BOOLEAN_OID) return "boolean";
    if (DATETIME_OIDS.has(oid)) return "datetime";
    if (oid === BYTEA_OID) return "binary";
    if (JSON_OIDS.has(oid)) return "json";
    if (oid === XML_OID) return "xml";
    return "string";
}

export function columnInfo(field: PgField, typeNames: Map<number, string>): ColumnInfo {
    const oid = field.dataTypeID;
    return {
        columnName: field.name,
        dataTypeName: typeNames.get(oid) ?? "unknown",
        kind: kindOf(oid),
        isJson: JSON_OIDS.has(oid),
        isXml: oid === XML_OID,
        isBytes: oid === BYTEA_OID,
    };
}

export function toCells(row: (string | null)[]): CellValue[] {
    return row.map((value) =>
        value === null
            ? { displayValue: "NULL", isNull: true }
            : { displayValue: value, isNull: false },
    );
}

export async function refreshTypeNames(session: ExecutionSession): Promise<void> {
    try {
        const names = await loadTypeNames(session.client);
        session.typeNames.clear();
        names.forEach((name, oid) => session.typeNames.set(oid, name));
    } catch {
        // Keep the old names: type names are cosmetic.
    }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Commands whose tag ends with the number of rows they changed. */
const ROW_COUNT_COMMANDS = ["INSERT", "UPDATE", "DELETE", "MERGE", "COPY"];

function rowsAffectedOf(tag: string): number | undefined {
    const [command] = tag.split(" ");
    if (!ROW_COUNT_COMMANDS.includes(command)) return undefined;
    const count = Number(tag.split(" ").pop());
    return Number.isNaN(count) ? undefined : count;
}

/** Closes a cursor left before its end; the session stays usable even if that fails. */
async function closeCursor(cursor: { close(): Promise<void> }): Promise<void> {
    try {
        await cursor.close();
    } catch {
        // The canceled statement may already have closed the portal.
    }
}

export const canceledMessage = (): ExecuteEvent => ({
    type: "message",
    text: QUERY_CANCELED_MESSAGE,
    isError: true,
});

interface NoticeLike {
    severity?: string;
    message?: string;
    detail?: string;
    hint?: string;
    where?: string;
}

/** Formats like psql: "NOTICE:  text", then DETAIL / HINT lines (and CONTEXT for errors). */
export function formatServerText(severity: string, notice: NoticeLike): string {
    const lines = [`${severity}:  ${notice.message}`];
    if (notice.detail) lines.push(`DETAIL:  ${notice.detail}`);
    if (notice.hint) lines.push(`HINT:  ${notice.hint}`);
    if (notice.where && severity === "ERROR") lines.push(`CONTEXT:  ${notice.where}`);
    return lines.join("\n");
}

function noticeMessage(notice: NoticeLike): ExecuteEvent {
    return {
        type: "message",
        text: formatServerText(notice.severity ?? "NOTICE", notice),
        isError: false,
    };
}

export interface ServerError extends NoticeLike {
    code: string;
    /** 1-based character offset in the statement, as a string. */
    position?: string;
    internalQuery?: string;
}

export function isServerError(error: unknown): error is ServerError {
    const e = error as ServerError;
    return typeof e?.code === "string" && typeof e?.severity === "string";
}

function errorMessage(error: ServerError, statement: StatementSpan, script: string): ExecuteEvent {
    const event: ExecuteEvent = {
        type: "message",
        text: formatServerText("ERROR", error),
        isError: true,
    };
    // The position refers to the statement text, unless the error comes from inside a function.
    if (error.position && !error.internalQuery) {
        event.position = offsetToPosition(script, statement.start + Number(error.position) - 1);
    }
    return event;
}
