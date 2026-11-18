/**
 * What `executeForPlan` sends to the server: which statements EXPLAIN applies to, and the EXPLAIN
 * options of each kind of plan. Statements are classified from the lexer's tokens, never from the
 * raw text, so comments, strings, dollar quoting and a leading parenthesis cannot fool it.
 */

import type { SqlToken } from "../../../sql/lexer";
import type { ExecutionPlanKind } from "../../types";
import { tokenizePg } from "../statements";

export type StatementClass =
    /** EXPLAIN applies to it: the statement is wrapped in EXPLAIN. */
    | {
          type: "explainable";
          /** DECLARE: EXPLAIN ANALYZE would run the query but create no cursor. */
          declare?: boolean;
          /** CREATE TABLE AS / MATERIALIZED VIEW: creates a type the session must learn about. */
          creates?: boolean;
      }
    /** Already an EXPLAIN: run as written. `analyze` tells whether it would run its statement. */
    | { type: "explain"; analyze: boolean }
    /** DDL, SET, transaction control...: EXPLAIN does not apply. `label` names it for the user. */
    | { type: "other"; label: string };

/** Statements that start with one of these words are queries or DML, which EXPLAIN accepts. */
const EXPLAINABLE_FIRST_WORDS = new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "VALUES",
    "TABLE",
    "EXECUTE",
    "DECLARE",
    "WITH",
]);

/** Words that may stand between CREATE and TABLE (CREATE TABLE AS). */
const CREATE_TABLE_MODIFIERS = new Set(["GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "UNLOGGED"]);

/** Classifies one statement (text without its trailing semicolon). */
export function classifyStatement(statement: string): StatementClass {
    const tokens = tokenizePg(statement).filter(
        (t) => t.type !== "lineComment" && t.type !== "blockComment",
    );
    const text = (t: SqlToken | undefined) => (t ? statement.slice(t.start, t.end) : "");
    // Upper-cased text of the unquoted word at index i.
    const wordAt = (i: number): string | undefined =>
        tokens[i]?.type === "word" ? text(tokens[i]).toUpperCase() : undefined;

    const first = tokens[0];
    if (!first) return { type: "other", label: "empty statement" };
    // (SELECT 1) UNION (SELECT 2): a query can start with a parenthesis.
    if (first.type === "punctuation" && text(first) === "(") return { type: "explainable" };
    const head = wordAt(0);
    if (head === undefined) return { type: "other", label: text(first) };
    if (EXPLAINABLE_FIRST_WORDS.has(head)) {
        return {
            type: "explainable",
            declare: head === "DECLARE",
            // SELECT ... INTO newtable creates a table as well.
            creates: head === "SELECT" && hasTopLevelWord(tokens, "INTO", text),
        };
    }
    if (head === "EXPLAIN") return { type: "explain", analyze: explainAnalyzes(tokens, text) };
    if (head === "CREATE" && isCreateTableAs(tokens, wordAt, text)) {
        return { type: "explainable", creates: true };
    }
    const second = wordAt(1);
    return {
        type: "other",
        label: second && /^(CREATE|ALTER|DROP)$/.test(head) ? `${head} ${second}` : head,
    };
}

/** CREATE [modifiers] TABLE ... AS query, CREATE MATERIALIZED VIEW ... AS query. */
function isCreateTableAs(
    tokens: readonly SqlToken[],
    wordAt: (i: number) => string | undefined,
    text: (t: SqlToken | undefined) => string,
): boolean {
    let i = 1;
    while (CREATE_TABLE_MODIFIERS.has(wordAt(i) ?? "")) i++;
    const kind = wordAt(i);
    if (kind === "MATERIALIZED") {
        if (wordAt(i + 1) !== "VIEW") return false;
    } else if (kind !== "TABLE") {
        return false;
    }
    // The AS that introduces the query is outside every parenthesis (column definitions, storage
    // parameters and generated columns have theirs inside).
    let depth = 0;
    for (const token of tokens.slice(i + 1)) {
        if (token.type === "punctuation") {
            const c = text(token);
            if (c === "(") depth++;
            else if (c === ")") depth--;
        } else if (depth === 0 && token.type === "word" && text(token).toUpperCase() === "AS") {
            return true;
        }
    }
    return false;
}

// Every statement kind uses the result icon: SQL Server's catch-all for INSERT and the like
// (language_construct_catch_all) is drawn as the text "T-SQL", which means nothing on PostgreSQL.
const QUERY_ICON = "result";
const WITH_BODY_WORDS = new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "VALUES",
    "TABLE",
]);

/**
 * The kind of a statement, for the root node of its plan: the name shown and the icon
 * (always the result icon). For WITH, the statement the CTEs lead
 * to. "Query" when the text is missing or the kind cannot be told.
 */
export function statementKind(statement: string): { name: string; icon: string } {
    const tokens = tokenizePg(statement).filter(
        (t) => t.type !== "lineComment" && t.type !== "blockComment",
    );
    const text = (t: SqlToken | undefined) => (t ? statement.slice(t.start, t.end) : "");
    const unknown = { name: "Query", icon: QUERY_ICON };
    const first = tokens[0];
    if (!first) return unknown;
    if (first.type === "punctuation" && text(first) === "(") {
        return { name: "SELECT", icon: QUERY_ICON };
    }
    if (first.type !== "word") return unknown;
    let head = text(first).toUpperCase();
    if (head === "WITH") {
        // WITH [RECURSIVE] name [(columns)] AS [[NOT] MATERIALIZED] (query) [, ...] statement
        const word = (i: number) =>
            tokens[i]?.type === "word" ? text(tokens[i]).toUpperCase() : "";
        const skipGroup = (i: number): number => {
            let depth = 0;
            for (; i < tokens.length; i++) {
                const t = tokens[i].type === "punctuation" ? text(tokens[i]) : "";
                if (t === "(") depth++;
                else if (t === ")" && --depth === 0) return i + 1;
            }
            return i;
        };
        let i = 1;
        if (word(i) === "RECURSIVE") i++;
        while (i < tokens.length) {
            i++; // the CTE's name, which may look like a keyword
            if (text(tokens[i]) === "(") i = skipGroup(i);
            if (word(i) !== "AS") return unknown;
            i++;
            if (word(i) === "NOT") i++;
            if (word(i) === "MATERIALIZED") i++;
            if (text(tokens[i]) !== "(") return unknown;
            i = skipGroup(i);
            if (text(tokens[i]) === ",") i++;
            else break;
        }
        if (text(tokens[i]) === "(") head = "SELECT";
        else if (WITH_BODY_WORDS.has(word(i))) head = word(i);
        else return unknown;
    }
    const cls = classifyStatement(statement);
    if (cls.type === "explainable" && cls.creates && head === "CREATE") {
        // CREATE [modifiers] TABLE ... or CREATE MATERIALIZED VIEW ...: the word before VIEW / TABLE.
        let k = 1;
        while (CREATE_TABLE_MODIFIERS.has(text(tokens[k]).toUpperCase())) k++;
        const materialized = text(tokens[k]).toUpperCase() === "MATERIALIZED";
        return {
            name: materialized ? "CREATE MATERIALIZED VIEW" : "CREATE TABLE AS",
            icon: QUERY_ICON,
        };
    }
    if (cls.type !== "explainable") return unknown;
    return {
        name: head,
        icon: QUERY_ICON,
    };
}

/** True when the word appears outside every parenthesis. */
function hasTopLevelWord(
    tokens: readonly SqlToken[],
    word: string,
    text: (t: SqlToken | undefined) => string,
): boolean {
    let depth = 0;
    for (const token of tokens) {
        const t = text(token);
        if (token.type === "punctuation") {
            if (t === "(") depth++;
            else if (t === ")") depth--;
        } else if (depth === 0 && token.type === "word" && t.toUpperCase() === word) {
            return true;
        }
    }
    return false;
}

const FALSE_VALUES = new Set(["FALSE", "OFF", "0"]);

/** True when `EXPLAIN ...` has the ANALYZE option on, in either syntax. */
function explainAnalyzes(
    tokens: readonly SqlToken[],
    text: (t: SqlToken | undefined) => string,
): boolean {
    // An option name may be a quoted identifier: EXPLAIN ("analyze") runs the statement too.
    const isAnalyze = (t: SqlToken | undefined) =>
        (t?.type === "word" || t?.type === "quotedIdentifier") && /^"?ANALY[ZS]E"?$/i.test(text(t));
    const second = tokens[1];
    // EXPLAIN [ANALYZE] [VERBOSE] statement
    if (!(second?.type === "punctuation" && text(second) === "(")) return isAnalyze(second);
    // EXPLAIN ( option [value] [, ...] ) statement
    let depth = 0;
    let occurrences = 0;
    let enabled = false;
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === "punctuation") {
            const c = text(token);
            if (c === "(") depth++;
            else if (c === ")" && --depth === 0) break;
        }
        const previous = text(tokens[i - 1]);
        // U&"\0061nalyze": a Unicode-escaped name cannot be read here, so it counts as ANALYZE.
        if (
            depth === 1 &&
            (previous === "(" || previous === ",") &&
            text(token).toUpperCase() === "U" &&
            text(tokens[i + 1]) === "&"
        ) {
            return true;
        }
        if (depth === 1 && (previous === "(" || previous === ",") && isAnalyze(token)) {
            occurrences++;
            const value = text(tokens[i + 1]);
            if (value === "" || value === "," || value === ")") enabled = true;
            else enabled = !FALSE_VALUES.has(value.replace(/^'|'$/g, "").toUpperCase());
        }
    }
    // Conservative: a repeated option (the server keeps the last one) counts as on.
    return occurrences > 1 || enabled;
}

/** Major version of a server_version string ("17.2", "12.22 (Debian...)"), undefined when unknown. */
export function majorVersion(serverVersion: string): number | undefined {
    const major = /^(\d+)/.exec(serverVersion.trim())?.[1];
    return major === undefined ? undefined : Number(major);
}

/**
 * The EXPLAIN prefix for a kind of plan. SETTINGS (12) and WAL (13, with ANALYZE) go in when the
 * connected server has them: the page shows the non-default settings of the plan and the WAL
 * volume of each node. Keep tools/pg-plan-capture.mjs in sync.
 */
export function explainPrefix(kind: ExecutionPlanKind, major: number | undefined): string {
    const options =
        kind === "estimated" ? ["FORMAT JSON", "VERBOSE"] : ["ANALYZE", "BUFFERS", "VERBOSE"];
    if (major !== undefined && major >= 12) options.push("SETTINGS");
    if (kind === "actual") {
        if (major !== undefined && major >= 13) options.push("WAL");
        options.push("FORMAT JSON");
    }
    return `EXPLAIN (${options.join(", ")}) `;
}
