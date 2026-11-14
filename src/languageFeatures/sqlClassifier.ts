/**
 * Tells what each piece of a SQL script is, for highlighting: keyword, data type, built-in
 * function, identifier... with the vocabulary of one engine (`SqlLanguage`) and its lexer.
 *
 * Engine-neutral. There is no parser: the tokens of the shared lexer are classified with the
 * vocabulary, and with a few cheap and reliable hints from their neighbors:
 *   - a word next to "." is a name (t.name, dbo.TOP), whatever it is elsewhere;
 *   - a built-in function is a word of `functions` followed by "(" (LEFT( vs LEFT JOIN);
 *   - a data type is recognized where a type is expected: after "::", AS in CAST(...),
 *     RETURNS, TYPE, a variable (DECLARE @x INT), a column name in a column or parameter list
 *     (CREATE TABLE t (name TEXT)), or before "(<number>" (VARCHAR(20)). Elsewhere a type name
 *     is a keyword when it is one, and a name otherwise (SELECT date FROM t);
 *   - the batch separator (GO) is a keyword only alone on its line;
 *   - the body of a dollar-quoted string after AS or DO ($$ ... $$) is SQL, classified again.
 */

import type { SqlLanguage, SqlToken } from "../drivers/types";

export type SqlTokenKind =
    | "comment"
    | "string"
    | "number"
    | "operator"
    | "keyword"
    | "type"
    | "function"
    | "variable"
    | "identifier"
    /** The $$ or $tag$ around a code body. */
    | "dollarQuote";

export interface ClassifiedToken {
    kind: SqlTokenKind;
    /** 0-based offsets in the script; `end` is exclusive. */
    start: number;
    end: number;
}

export interface SqlClassifierEngine {
    tokenize(script: string): SqlToken[];
    readonly language: SqlLanguage;
}

/** Classifies a whole script. Punctuation gets no token; the result is sorted by offset. */
export function classifySql(script: string, engine: SqlClassifierEngine): ClassifiedToken[] {
    const result: ClassifiedToken[] = [];
    new Classifier(script, 0, engine, result, 0).run();
    return result;
}

/** Dollar bodies inside dollar bodies are classified down to this depth, strings below. */
const MAX_BODY_DEPTH = 4;
/** Words before the first "(" after them that open a column or parameter list. */
const LIST_OWNERS_AFTER_CREATE = new Set(["FUNCTION", "PROCEDURE", "PROC"]);
const TABLE_PREFIXES = new Set(["CREATE", "TEMP", "TEMPORARY", "UNLOGGED", "RETURNS"]);
/** First words of a list element that is not a column: table constraints, LIKE other_table. */
const NOT_A_COLUMN = new Set(
    "CONSTRAINT PRIMARY FOREIGN UNIQUE CHECK EXCLUDE INDEX LIKE PERIOD".split(" "),
);
const PARAMETER_MODES = new Set(["IN", "OUT", "INOUT", "VARIADIC"]);
/** Languages whose dollar-quoted bodies are SQL. */
const SQL_BODY_LANGUAGES = new Set(["SQL", "PLPGSQL"]);
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

interface Frame {
    /** Opened by a built-in function: AS in it introduces a type (CAST(x AS INT)). */
    call: boolean;
    /** A column or parameter list. */
    list: boolean;
    /** In a list, the next token starts an element. */
    elementStart: boolean;
}

class Classifier {
    private readonly tokens: SqlToken[];
    /** Indexes in `tokens` of the tokens that are not comments. */
    private readonly significant: number[] = [];
    private readonly upper: (string | undefined)[];
    private readonly frames: Frame[] = [];
    private readonly multiWordTypes: Map<string, string[][]>;
    private typeExpected = false;
    /** The next name is a column name, followed by its type (ADD COLUMN name type). */
    private columnNameExpected = false;
    /** The next "(" after a name opens a column or parameter list. */
    private listExpected = false;
    /** Index in `significant` of tokens already classified ahead (multi-word types). */
    private classifiedUntil = -1;

    constructor(
        private readonly script: string,
        private readonly base: number,
        private readonly engine: SqlClassifierEngine,
        private readonly out: ClassifiedToken[],
        private readonly depth: number,
    ) {
        this.tokens = engine.tokenize(script);
        this.upper = this.tokens.map((token) =>
            token.type === "word" || token.type === "variable"
                ? script.slice(token.start, token.end).toUpperCase()
                : undefined,
        );
        this.tokens.forEach((token, index) => {
            if (token.type !== "lineComment" && token.type !== "blockComment") {
                this.significant.push(index);
            }
        });
        this.multiWordTypes = multiWordTypesOf(engine.language);
    }

    public run(): void {
        let position = 0;
        for (let index = 0; index < this.tokens.length; index++) {
            const token = this.tokens[index];
            if (token.type === "lineComment" || token.type === "blockComment") {
                this.emit("comment", token.start, token.end);
                continue;
            }
            const at = position++;
            if (at <= this.classifiedUntil) {
                continue;
            }
            this.classify(at);
        }
    }

    private classify(at: number): void {
        const token = this.tokenAt(at)!;
        const text = this.upper[this.significant[at]];
        const frame = this.frames[this.frames.length - 1];

        if (token.type === "punctuation") {
            this.punctuation(at, frame);
            return;
        }
        const typeExpected = this.typeExpected;
        this.typeExpected = false;
        const atElementStart = frame?.list && frame.elementStart;
        if (frame) frame.elementStart = false;

        switch (token.type) {
            case "string":
                this.string(at, token);
                return;
            case "number":
                this.emit("number", token.start, token.end);
                return;
            case "operator":
                this.emit("operator", token.start, token.end);
                if (this.textOf(token) === "::") this.typeExpected = true;
                return;
            case "variable":
                if (this.engine.language.functions.has(text!)) {
                    this.emit("function", token.start, token.end);
                } else {
                    this.emit("variable", token.start, token.end);
                    // DECLARE @x INT, CREATE PROCEDURE p @x INT.
                    this.typeExpected = true;
                }
                return;
            case "quotedIdentifier":
                this.emit("identifier", token.start, token.end);
                this.afterName(atElementStart);
                return;
            case "word":
                this.word(at, token, text!, typeExpected, atElementStart);
                return;
        }
    }

    private word(
        at: number,
        token: SqlToken,
        text: string,
        typeExpected: boolean,
        atElementStart: boolean | undefined,
    ): void {
        const { language } = this.engine;
        const next = this.tokenAt(at + 1);
        const nextText = next && this.textOf(next);
        const previous = this.tokenAt(at - 1);

        if (
            atElementStart &&
            PARAMETER_MODES.has(text) &&
            (next?.type === "word" || next?.type === "quotedIdentifier")
        ) {
            this.emit("keyword", token.start, token.end);
            this.frames[this.frames.length - 1].elementStart = true;
            return;
        }
        if (atElementStart && !language.reservedKeywords.has(text) && !NOT_A_COLUMN.has(text)) {
            // An unnamed parameter: f(INT, TEXT).
            const unnamed =
                this.isTypeAt(at) &&
                (nextText === "," ||
                    nextText === ")" ||
                    nextText === "(" ||
                    nextText === "[" ||
                    this.typeLength(at) > 1);
            if (!unnamed) {
                this.emit("identifier", token.start, token.end);
                this.typeExpected = true;
                return;
            }
            typeExpected = true;
        }

        if (
            this.columnNameExpected &&
            !language.reservedKeywords.has(text) &&
            !NOT_A_COLUMN.has(text) &&
            text !== "COLUMN" &&
            text !== "IF"
        ) {
            this.columnNameExpected = false;
            this.emit("identifier", token.start, token.end);
            this.typeExpected = true;
            return;
        }

        const qualified =
            (previous?.type === "punctuation" && this.textOf(previous) === ".") ||
            (next?.type === "punctuation" && nextText === ".");
        if (qualified) {
            this.emit("identifier", token.start, token.end);
            this.afterName(false);
            return;
        }

        if (typeExpected || (this.isTypeAt(at) && this.sizedAt(at + 1))) {
            const length = this.typeLength(at);
            if (length > 0) {
                for (let i = 0; i < length; i++) {
                    const part = this.tokenAt(at + i)!;
                    if (part.type === "word") this.emit("type", part.start, part.end);
                    else this.classifySimple(part);
                }
                this.classifiedUntil = at + length - 1;
                return;
            }
        }

        if (language.batchSeparatorLine && this.isAloneOnLine(at, language.batchSeparatorLine)) {
            this.emit("keyword", token.start, token.end);
            return;
        }

        if (nextText === "(" && next?.type === "punctuation" && language.functions.has(text)) {
            this.emit("function", token.start, token.end);
            this.pendingCall = true;
            return;
        }

        if (language.constants.has(text) || language.keywords.has(text)) {
            this.emit("keyword", token.start, token.end);
            this.afterKeyword(at, text);
            return;
        }

        this.emit("identifier", token.start, token.end);
        this.afterName(false);
    }

    /** Set by a built-in function name: the "(" after it opens a call. */
    private pendingCall = false;

    private punctuation(at: number, frame: Frame | undefined): void {
        const text = this.textOf(this.tokenAt(at)!);
        const pendingCall = this.pendingCall;
        this.pendingCall = false;
        this.typeExpected = false;
        if (text === "(") {
            const previous = this.tokenAt(at - 1);
            const list =
                this.listExpected &&
                (previous?.type === "word" || previous?.type === "quotedIdentifier");
            if (list) this.listExpected = false;
            this.frames.push({ call: pendingCall, list, elementStart: list });
        } else if (text === ")") {
            this.frames.pop();
        } else if (text === "," && frame?.list) {
            frame.elementStart = true;
        } else if (text === ";") {
            this.frames.length = 0;
            this.listExpected = false;
            this.columnNameExpected = false;
        }
    }

    /** What a keyword tells about the tokens after it. */
    private afterKeyword(at: number, text: string): void {
        const previous = this.upperAt(at - 1);
        const frame = this.frames[this.frames.length - 1];
        switch (text) {
            case "AS":
                if (frame?.call) this.typeExpected = true;
                else if (this.listExpected) this.listExpected = false; // CREATE TABLE t AS SELECT
                break;
            case "RETURNS":
            case "TYPE":
                this.typeExpected = true;
                break;
            case "TABLE":
                if (
                    (previous && TABLE_PREFIXES.has(previous)) ||
                    this.tokenAt(at - 1)?.type === "variable"
                ) {
                    this.listExpected = true;
                }
                break;
            case "COLUMN":
                if (previous === "ADD" || previous === "ALTER") this.columnNameExpected = true;
                break;
            case "ADD": {
                // ALTER TABLE [schema.]name ADD name type.
                const next = this.upperAt(at + 1);
                const nextToken = this.tokenAt(at + 1);
                if (
                    this.afterTableName(at) &&
                    (nextToken?.type === "word" || nextToken?.type === "quotedIdentifier") &&
                    next !== "COLUMN" &&
                    !(next && NOT_A_COLUMN.has(next))
                ) {
                    this.columnNameExpected = true;
                }
                break;
            }
            case "SELECT":
                this.listExpected = false;
                break;
            default:
                if (
                    LIST_OWNERS_AFTER_CREATE.has(text) &&
                    (previous === "CREATE" || previous === "REPLACE" || previous === "ALTER")
                ) {
                    this.listExpected = true;
                }
        }
    }

    /** The tokens before `at` are TABLE [IF EXISTS] [ONLY] and a (qualified) name. */
    private afterTableName(at: number): boolean {
        for (let i = at - 1; i >= at - 8; i--) {
            const token = this.tokenAt(i);
            if (this.upperAt(i) === "TABLE") return i < at - 1;
            const isName = token?.type === "word" || token?.type === "quotedIdentifier";
            if (!isName && !(token?.type === "punctuation" && this.textOf(token) === ".")) {
                return false;
            }
        }
        return false;
    }

    /** A name at the start of a list element is a column or parameter name: its type follows. */
    private afterName(atElementStart: boolean | undefined): void {
        if (atElementStart) {
            this.typeExpected = true;
        } else if (this.columnNameExpected) {
            this.columnNameExpected = false;
            this.typeExpected = true;
        }
    }

    private string(at: number, token: SqlToken): void {
        const text = this.script.slice(token.start, token.end);
        const tag = DOLLAR_TAG.exec(text)?.[0];
        if (!tag || this.depth >= MAX_BODY_DEPTH || !this.isCodeBody(at)) {
            this.emit("string", token.start, token.end);
            return;
        }
        const closed = text.length >= 2 * tag.length && text.endsWith(tag);
        const bodyStart = token.start + tag.length;
        const bodyEnd = closed ? token.end - tag.length : token.end;
        this.emit("dollarQuote", token.start, bodyStart);
        new Classifier(
            this.script.slice(bodyStart, bodyEnd),
            this.base + bodyStart,
            this.engine,
            this.out,
            this.depth + 1,
        ).run();
        if (closed) this.emit("dollarQuote", bodyEnd, token.end);
    }

    /** AS $$...$$ of CREATE FUNCTION / PROCEDURE, or DO [LANGUAGE x] $$...$$, in a SQL language. */
    private isCodeBody(at: number): boolean {
        const previous = this.upperAt(at - 1);
        const afterDo =
            previous === "DO" ||
            (this.upperAt(at - 2) === "LANGUAGE" && this.upperAt(at - 3) === "DO");
        if (previous !== "AS" && !afterDo) return false;
        const language = this.statementLanguage(at);
        return language === undefined || SQL_BODY_LANGUAGES.has(language);
    }

    /** The LANGUAGE named in the statement around `at`, looking a bounded number of tokens away. */
    private statementLanguage(at: number): string | undefined {
        for (const step of [-1, 1]) {
            for (let i = at + step, n = 0; n < 200; i += step, n++) {
                const token = this.tokenAt(i);
                if (!token || (token.type === "punctuation" && this.textOf(token) === ";")) break;
                if (this.upperAt(i) === "LANGUAGE") {
                    const name = this.tokenAt(i + 1);
                    if (!name) return undefined;
                    return this.textOf(name)
                        .replace(/^['"]|['"]$/g, "")
                        .toUpperCase();
                }
            }
        }
        return undefined;
    }

    /** Number of tokens of the data type starting at `at` (words and size parentheses); 0 if none. */
    private typeLength(at: number): number {
        const head = this.upperAt(at);
        if (!head) return 0;
        for (const tail of this.multiWordTypes.get(head) ?? []) {
            let i = at + 1;
            // TIME(3) WITH TIME ZONE.
            if (this.sizedAt(i)) i = this.afterParentheses(i);
            let matched = true;
            for (const word of tail) {
                if (this.upperAt(i) !== word) {
                    matched = false;
                    break;
                }
                i++;
            }
            if (matched) return i - at;
        }
        return this.engine.language.dataTypes.has(head) ? 1 : 0;
    }

    private isTypeAt(at: number): boolean {
        return this.typeLength(at) > 0;
    }

    /** "(" followed by a number or MAX: the size of a type, VARCHAR(20) or NVARCHAR(MAX). */
    private sizedAt(at: number): boolean {
        const open = this.tokenAt(at);
        const inside = this.tokenAt(at + 1);
        return (
            open?.type === "punctuation" &&
            this.textOf(open) === "(" &&
            (inside?.type === "number" || this.upperAt(at + 1) === "MAX")
        );
    }

    private afterParentheses(at: number): number {
        // A size has at most two numbers: (p, s). Bounded, so that unclosed text stays linear.
        let i = at;
        while (i < at + 6 && this.tokenAt(i) && this.textOf(this.tokenAt(i)!) !== ")") i++;
        return i + 1;
    }

    /** The token at `at` is the only one on its line, besides a number and comments (GO 3 -- x). */
    private isAloneOnLine(at: number, pattern: RegExp): boolean {
        const token = this.tokenAt(at)!;
        // Only the gap since the previous token is searched: linear on very long lines.
        const previous = this.tokenAt(at - 1);
        if (previous && !this.script.slice(previous.end, token.start).includes("\n")) {
            return false;
        }
        const lineStart = this.script.lastIndexOf("\n", token.start - 1) + 1;
        let lineEnd = this.script.indexOf("\n", token.end);
        if (lineEnd === -1) lineEnd = this.script.length;
        return pattern.test(this.script.slice(lineStart, lineEnd).replace(/\r$/, ""));
    }

    /** Tokens that are part of a multi-word type but not words (the parentheses of TIME(3) ...). */
    private classifySimple(token: SqlToken): void {
        if (token.type === "number") this.emit("number", token.start, token.end);
    }

    private tokenAt(at: number): SqlToken | undefined {
        return at >= 0 && at < this.significant.length
            ? this.tokens[this.significant[at]]
            : undefined;
    }

    private upperAt(at: number): string | undefined {
        return at >= 0 && at < this.significant.length
            ? this.upper[this.significant[at]]
            : undefined;
    }

    private textOf(token: SqlToken): string {
        return this.script.slice(token.start, token.end);
    }

    private emit(kind: SqlTokenKind, start: number, end: number): void {
        this.out.push({ kind, start: this.base + start, end: this.base + end });
    }
}

const multiWordCache = new WeakMap<SqlLanguage, Map<string, string[][]>>();

/** Data types of several words, by first word, longest first. */
function multiWordTypesOf(language: SqlLanguage): Map<string, string[][]> {
    let map = multiWordCache.get(language);
    if (!map) {
        map = new Map();
        for (const type of language.dataTypes) {
            const [head, ...tail] = type.split(" ");
            if (tail.length) map.set(head, [...(map.get(head) ?? []), tail]);
        }
        for (const tails of map.values()) tails.sort((a, b) => b.length - a.length);
        multiWordCache.set(language, map);
    }
    return map;
}
