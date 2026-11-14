/**
 * Picks the statement "Execute Current Statement" runs, the way sqltoolsservice's
 * ParseStatementAtPosition does once a script is parsed into batches and statements.
 */

import type { TextPosition, TextRange } from "../drivers/types";

/** A statement as offsets in the script; `end` is exclusive. */
export interface StatementSpan {
    start: number;
    end: number;
}

/** Offsets of the first character of every line ("\n" ends a line; a "\r" before it stays on it). */
export function lineStarts(script: string): number[] {
    const starts = [0];
    for (let i = script.indexOf("\n"); i !== -1; i = script.indexOf("\n", i + 1)) {
        starts.push(i + 1);
    }
    return starts;
}

export function offsetToPosition(starts: readonly number[], offset: number): TextPosition {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= offset) low = middle;
        else high = middle - 1;
    }
    return { line: low, column: offset - starts[low] };
}

/**
 * The statement at `position` among the statements of the batch containing it:
 *  - a statement whose lines include the cursor line and that the cursor is inside of (or at
 *    the very end of) is the one;
 *  - otherwise, when exactly one statement touches the cursor line (the cursor is before or
 *    after it on that line), that statement;
 *  - otherwise none.
 */
export function pickStatementAt(
    script: string,
    statements: readonly StatementSpan[],
    position: TextPosition,
): TextRange | undefined {
    const starts = lineStarts(script);
    let lineStatement: TextRange | undefined;
    let lineHasSingleStatement: boolean | undefined;
    for (const span of statements) {
        const range = {
            start: offsetToPosition(starts, span.start),
            end: offsetToPosition(starts, span.end),
        };
        if (range.start.line > position.line || range.end.line < position.line) {
            continue;
        }
        const endsBeforeCursor =
            range.end.line === position.line && range.end.column < position.column;
        const startsAfterCursor =
            range.start.line === position.line && range.start.column > position.column;
        if (endsBeforeCursor || startsAfterCursor) {
            if (lineHasSingleStatement === undefined) {
                lineHasSingleStatement = true;
                lineStatement = range;
            } else {
                lineHasSingleStatement = false;
            }
            continue;
        }
        return range;
    }
    return lineHasSingleStatement ? lineStatement : undefined;
}
