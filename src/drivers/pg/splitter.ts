/** One SQL statement of a script, with its position so errors can be mapped back to the script. */
export interface StatementSpan {
    /** Statement text without the trailing semicolon and without surrounding whitespace. */
    text: string;
    /** 0-based character offset of `text` in the script. */
    start: number;
}

const isIdentifierChar = (c: string | undefined): boolean =>
    c !== undefined && /[A-Za-z0-9_$\u0080-￿]/.test(c);
const isTagStartChar = (c: string | undefined): boolean =>
    c !== undefined && /[A-Za-z_\u0080-￿]/.test(c);
const isTagChar = (c: string | undefined): boolean =>
    c !== undefined && /[A-Za-z0-9_\u0080-￿]/.test(c);

/** Returns the index just after the closing quote of a '...' or "..." literal opened at `i`. */
function skipQuoted(script: string, i: number, quote: string, backslashEscapes: boolean): number {
    let pos = i + 1;
    while (pos < script.length) {
        const c = script[pos];
        if (backslashEscapes && c === "\\") {
            pos += 2;
        } else if (c === quote) {
            // A doubled quote is an escaped quote, not the end.
            if (script[pos + 1] === quote) {
                pos += 2;
            } else {
                return pos + 1;
            }
        } else {
            pos++;
        }
    }
    return script.length;
}

/** Returns the index of the line break ending a -- comment. */
function skipLineComment(script: string, i: number): number {
    const end = script.indexOf("\n", i);
    return end === -1 ? script.length : end;
}

/** Returns the index just after a block comment; PostgreSQL block comments nest. */
function skipBlockComment(script: string, i: number): number {
    let depth = 0;
    let pos = i;
    while (pos < script.length) {
        if (script.startsWith("/*", pos)) {
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

/** If a dollar-quote tag ($$ or $tag$) starts at `i`, returns it, otherwise undefined. */
function readDollarTag(script: string, i: number): string | undefined {
    // "a$b$" is an identifier, and "$1" is a parameter: neither opens a dollar quote.
    if (isIdentifierChar(script[i - 1])) return undefined;
    let pos = i + 1;
    if (isTagStartChar(script[pos])) {
        while (isTagChar(script[pos])) pos++;
    }
    return script[pos] === "$" ? script.slice(i, pos + 1) : undefined;
}

/** True when the quote at `i` opens an E'...' string (backslash is an escape character there). */
function isEscapeStringStart(script: string, i: number): boolean {
    const prefix = script[i - 1];
    return (prefix === "E" || prefix === "e") && !isIdentifierChar(script[i - 2]);
}

/** Splits a PostgreSQL script on top-level semicolons. Comment-only fragments are dropped. */
export function splitStatements(script: string): StatementSpan[] {
    const statements: StatementSpan[] = [];
    let statementStart = 0;
    let hasContent = false;
    let i = 0;

    const endStatement = (end: number) => {
        if (hasContent) {
            const raw = script.slice(statementStart, end);
            const leading = raw.length - raw.trimStart().length;
            statements.push({ text: raw.trim(), start: statementStart + leading });
        }
        statementStart = end + 1;
        hasContent = false;
    };

    while (i < script.length) {
        const c = script[i];
        const next = script[i + 1];
        if (c === "-" && next === "-") {
            i = skipLineComment(script, i);
        } else if (c === "/" && next === "*") {
            i = skipBlockComment(script, i);
        } else if (c === "'") {
            hasContent = true;
            i = skipQuoted(script, i, "'", isEscapeStringStart(script, i));
        } else if (c === '"') {
            hasContent = true;
            i = skipQuoted(script, i, '"', false);
        } else if (c === "$") {
            hasContent = true;
            const tag = readDollarTag(script, i);
            if (tag) {
                const close = script.indexOf(tag, i + tag.length);
                i = close === -1 ? script.length : close + tag.length;
            } else {
                i++;
            }
        } else if (c === ";") {
            endStatement(i);
            i++;
        } else {
            if (!/\s/.test(c)) hasContent = true;
            i++;
        }
    }
    endStatement(script.length);
    return statements;
}

/** Converts a 0-based character offset of the script into a 0-based line and column. */
export function offsetToPosition(script: string, offset: number): { line: number; column: number } {
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < offset && i < script.length; i++) {
        if (script[i] === "\n") {
            line++;
            lineStart = i + 1;
        }
    }
    return { line, column: offset - lineStart };
}
