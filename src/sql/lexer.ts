/**
 * SQL lexer shared by every engine.
 *
 * One scanning loop, driven by a `SqlDialect` that describes what differs between engines
 * (identifier quotes, comments, string prefixes, dollar quoting, variables, operators...).
 * It runs on text being typed: it never throws, and an unterminated string, comment or quoted
 * identifier simply extends to the end of the script.
 *
 * Consumers: statement detection ("Execute Current Statement"), and later semantic highlighting
 * and autocompletion, which need the exact offsets of every token.
 */

export type SqlTokenType =
    | "lineComment"
    | "blockComment"
    /** '...', N'...', E'...' (PostgreSQL), $$...$$ / $tag$...$tag$ (PostgreSQL). */
    | "string"
    /** "..." and, for SQL Server, [...]. */
    | "quotedIdentifier"
    /** Unquoted identifier or keyword: the lexer does not tell them apart. */
    | "word"
    /** @name, @@name (SQL Server); $1 (PostgreSQL positional parameter). */
    | "variable"
    | "number"
    /** One token per operator, multi-character ones included (<=, <>, ::, ||, ->>). */
    | "operator"
    /** ( ) , ; . */
    | "punctuation";

export interface SqlToken {
    type: SqlTokenType;
    /** 0-based offsets in the script (UTF-16 code units); `end` is exclusive. */
    start: number;
    end: number;
}

/** A string literal prefix written right before the opening quote: N'...', E'...', X'...'. */
export interface StringPrefix {
    /** Matched case-insensitively, e.g. "N", "E", "U&". */
    prefix: string;
    /** True when a backslash escapes the next character inside the string (PostgreSQL E'...'). */
    backslashEscapes?: boolean;
}

/** What differs between engines. Adding an engine means writing one of these, not a new loop. */
export interface SqlDialect {
    /** Characters that open a string literal (a doubled quote inside is an escaped quote). */
    stringQuotes: string;
    /** True when a backslash escapes the next character in every string (MySQL). */
    backslashEscapes?: boolean;
    stringPrefixes: StringPrefix[];
    /** Opening -> closing character of quoted identifiers ('"' -> '"', '[' -> ']', '`' -> '`'). */
    identifierQuotes: Record<string, string>;
    /** Line comment openers: "--", and "#" for MySQL. */
    lineComments: string[];
    /** True when block comments nest: /* /* *\/ *\/ (SQL Server, PostgreSQL). */
    nestedBlockComments: boolean;
    /** True for PostgreSQL's $$...$$ and $tag$...$tag$ strings. */
    dollarQuotes?: boolean;
    /** Tests one character that may start an unquoted word. */
    wordStart: RegExp;
    /** Tests one character that may continue an unquoted word. */
    wordPart: RegExp;
    /** Sticky (`y`) patterns of variables and parameters, tried in order. */
    variables: RegExp[];
    /** Sticky (`y`) pattern of a numeric literal. */
    number: RegExp;
    /** Multi-character and single-character operators; the longest match wins. */
    operators: string[];
}

const PUNCTUATION = "(),;.";
const WHITESPACE = /\s/;

/** Splits a script into tokens. Whitespace produces no token; every other character belongs to exactly one. */
export function tokenize(script: string, dialect: SqlDialect): SqlToken[] {
    const operators = sortedOperators(dialect);
    const tokens: SqlToken[] = [];
    const length = script.length;
    let i = 0;

    const push = (type: SqlTokenType, end: number) => {
        tokens.push({ type, start: i, end });
        i = end;
    };

    while (i < length) {
        const c = script[i];
        if (WHITESPACE.test(c)) {
            i++;
            continue;
        }

        if (dialect.lineComments.some((opener) => script.startsWith(opener, i))) {
            push("lineComment", lineEnd(script, i));
            continue;
        }
        if (c === "/" && script[i + 1] === "*") {
            push("blockComment", blockCommentEnd(script, i, dialect.nestedBlockComments));
            continue;
        }

        const prefix = stringPrefixAt(script, i, dialect);
        if (prefix) {
            const quoteAt = i + prefix.prefix.length;
            const escapes = !!(prefix.backslashEscapes || dialect.backslashEscapes);
            push("string", quotedEnd(script, quoteAt, script[quoteAt], escapes));
            continue;
        }
        if (isQuote(dialect, c)) {
            push("string", quotedEnd(script, i, c, !!dialect.backslashEscapes));
            continue;
        }
        if (dialect.dollarQuotes && c === "$") {
            const tag = dollarTagAt(script, i);
            if (tag) {
                const close = script.indexOf(tag, i + tag.length);
                push("string", close === -1 ? length : close + tag.length);
                continue;
            }
        }
        const closingQuote = dialect.identifierQuotes[c];
        if (closingQuote) {
            push("quotedIdentifier", quotedEnd(script, i, closingQuote, false));
            continue;
        }

        const variableEnd = stickyMatchEnd(dialect.variables, script, i);
        if (variableEnd !== undefined) {
            push("variable", variableEnd);
            continue;
        }
        const numberEnd = stickyMatchEnd([dialect.number], script, i);
        if (numberEnd !== undefined) {
            push("number", numberEnd);
            continue;
        }
        if (dialect.wordStart.test(c)) {
            let end = i + 1;
            while (end < length && dialect.wordPart.test(script[end])) end++;
            push("word", end);
            continue;
        }
        if (PUNCTUATION.includes(c)) {
            push("punctuation", i + 1);
            continue;
        }
        const operator = operators.find((op) => script.startsWith(op, i));
        // An unknown character still gets a token of its own.
        push("operator", i + (operator?.length ?? 1));
    }
    return tokens;
}

/** Index of the token containing `offset`, or of the last token before it; -1 when none is. */
export function tokenIndexAt(tokens: readonly SqlToken[], offset: number): number {
    let low = 0;
    let high = tokens.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (tokens[middle].start <= offset) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

const operatorCache = new WeakMap<SqlDialect, string[]>();

function sortedOperators(dialect: SqlDialect): string[] {
    let sorted = operatorCache.get(dialect);
    if (!sorted) {
        sorted = [...dialect.operators].sort((a, b) => b.length - a.length);
        operatorCache.set(dialect, sorted);
    }
    return sorted;
}

/** End of a line comment: its line break (and a "\r" before it) is not part of it. */
function lineEnd(script: string, i: number): number {
    const newline = script.indexOf("\n", i);
    if (newline === -1) return script.length;
    return script[newline - 1] === "\r" ? newline - 1 : newline;
}

function blockCommentEnd(script: string, i: number, nested: boolean): number {
    let depth = 0;
    let pos = i;
    while (pos < script.length) {
        if (script.startsWith("/*", pos) && (nested || depth === 0)) {
            depth++;
            pos += 2;
        } else if (script.startsWith("*/", pos)) {
            depth--;
            pos += 2;
            if (depth === 0) return pos;
        } else {
            pos++;
        }
    }
    return script.length;
}

/** End of a literal opened at `i` and closed by `close`; a doubled closing character is escaped. */
function quotedEnd(script: string, i: number, close: string, backslashEscapes: boolean): number {
    let pos = i + 1;
    while (pos < script.length) {
        const c = script[pos];
        if (backslashEscapes && c === "\\") {
            pos += 2;
        } else if (c === close) {
            if (script[pos + 1] !== close) return pos + 1;
            pos += 2;
        } else {
            pos++;
        }
    }
    return script.length;
}

const isQuote = (dialect: SqlDialect, c: string | undefined) =>
    c !== undefined && dialect.stringQuotes.includes(c);

function stringPrefixAt(script: string, i: number, dialect: SqlDialect): StringPrefix | undefined {
    return dialect.stringPrefixes.find(
        ({ prefix }) =>
            isQuote(dialect, script[i + prefix.length]) &&
            script.slice(i, i + prefix.length).toUpperCase() === prefix.toUpperCase(),
    );
}

const TAG_START = /[A-Za-z_\u0080-￿]/;
const TAG_PART = /[A-Za-z0-9_\u0080-￿]/;

/** The $$ or $tag$ opening a dollar-quoted string at `i`, if there is one. */
function dollarTagAt(script: string, i: number): string | undefined {
    let pos = i + 1;
    if (TAG_START.test(script[pos] ?? "")) {
        while (TAG_PART.test(script[pos] ?? "")) pos++;
    }
    return script[pos] === "$" ? script.slice(i, pos + 1) : undefined;
}

function stickyMatchEnd(patterns: RegExp[], script: string, i: number): number | undefined {
    for (const pattern of patterns) {
        pattern.lastIndex = i;
        const match = pattern.exec(script);
        if (match && match[0].length > 0) {
            return i + match[0].length;
        }
    }
    return undefined;
}
