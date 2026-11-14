import { tokenize, type SqlDialect, type SqlToken } from "../../sql/lexer";
import { pickStatementAt, type StatementSpan } from "../../sql/statementAt";
import type { TextPosition, TextRange } from "../types";

/** PostgreSQL's lexical rules (https://www.postgresql.org/docs/current/sql-syntax-lexical.html). */
export const pgDialect: SqlDialect = {
    stringQuotes: "'",
    stringPrefixes: [
        { prefix: "E", backslashEscapes: true },
        { prefix: "U&" },
        { prefix: "B" },
        { prefix: "X" },
        { prefix: "N" },
    ],
    identifierQuotes: { '"': '"' },
    lineComments: ["--"],
    nestedBlockComments: true,
    dollarQuotes: true,
    wordStart: /[A-Za-z_\u0080-￿]/,
    wordPart: /[A-Za-z0-9_$\u0080-￿]/,
    variables: [/\$\d+/y],
    number: /(?:0[xX][0-9A-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/y,
    // Casts, assignment and named arguments; comparison and text; JSON, arrays, ranges,
    // geometry and full-text search; then the single characters.
    operators:
        ":: := => <= >= <> != || ~~ ~~* !~~ !~~* ~* !~ !~* ^@ -> ->> #> #>> #- @> <@ ?| ?& @? @@ @@@ && << >> &< &> <<| |>> &<| |&> -|- <-> <<= >>= |/ ||/ ~= + - * / % ^ < > = ~ ! @ # & | ? : `".split(
            " ",
        ),
};

export function tokenizePg(script: string): SqlToken[] {
    return tokenize(script, pgDialect);
}

/**
 * Statements of a script: separated by top-level semicolons, like `splitStatements` of
 * splitter.ts which runs them. A statement spans from its first token that is not a comment
 * to its semicolon included. Fragments holding only comments are not statements.
 */
export function pgStatementSpans(script: string, tokens: readonly SqlToken[]): StatementSpan[] {
    const spans: StatementSpan[] = [];
    let start: number | undefined;
    let end = 0;
    for (const token of tokens) {
        if (token.type === "lineComment" || token.type === "blockComment") {
            continue;
        }
        const isSemicolon = token.type === "punctuation" && script[token.start] === ";";
        if (isSemicolon && start === undefined) {
            // A semicolon alone (";;") ends no statement.
            continue;
        }
        start ??= token.start;
        end = token.end;
        if (isSemicolon) {
            spans.push({ start, end });
            start = undefined;
        }
    }
    if (start !== undefined) {
        spans.push({ start, end });
    }
    return spans;
}

export function getPgStatementAt(script: string, position: TextPosition): TextRange | undefined {
    return pickStatementAt(script, pgStatementSpans(script, tokenizePg(script)), position);
}
