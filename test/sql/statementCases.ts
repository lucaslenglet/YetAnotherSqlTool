// Helpers for the "statement at the cursor" tests: scripts are written with a "|" cursor marker.

import type { TextPosition, TextRange } from "../../src/drivers/types";
import { lineStarts, offsetToPosition } from "../../src/sql/statementAt";

/** A script with a cursor: "SELECT 1\nSEL|ECT 2" (the first "|" is the cursor). */
export function withCursor(marked: string): { script: string; position: TextPosition } {
    const offset = marked.indexOf("|");
    if (offset === -1) {
        throw new Error(`No cursor in ${JSON.stringify(marked)}`);
    }
    const script = marked.slice(0, offset) + marked.slice(offset + 1);
    return { script, position: offsetToPosition(lineStarts(script), offset) };
}

export function textOf(script: string, range: TextRange | undefined): string | undefined {
    if (!range) return undefined;
    const starts = lineStarts(script);
    return script.slice(
        starts[range.start.line] + range.start.column,
        starts[range.end.line] + range.end.column,
    );
}

/** Text of the statement at the cursor of a marked script, or undefined when there is none. */
export function statementAt(
    getStatementAt: (script: string, position: TextPosition) => TextRange | undefined,
    marked: string,
): string | undefined {
    const { script, position } = withCursor(marked);
    return textOf(script, getStatementAt(script, position));
}
