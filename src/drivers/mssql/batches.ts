import type { Batch } from "../types";

type LexicalMode = "code" | "string" | "quotedIdentifier" | "bracketIdentifier" | "blockComment";

/** What the scanner is inside of at a given point of the script. Carried from one line to the next. */
interface LexicalState {
    mode: LexicalMode;
    /** T-SQL block comments can be nested. */
    commentDepth: number;
}

// A line holding only GO, with an optional repeat count and an optional trailing "-- comment".
export const GO_LINE = /^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i;

/**
 * Splits a script into batches on "GO" lines, like SSMS. GO is only a separator when it is alone on
 * a line and that line does not start inside a string, a quoted identifier or a block comment.
 * "GO 3" repeats the batch 3 times. Batches containing only whitespace are dropped.
 */
export function splitBatches(script: string): Batch[] {
    const batches: Batch[] = [];
    const lines = script.split("\n"); // a trailing "\r" stays on its line, so the batch text keeps its line endings
    let state: LexicalState = { mode: "code", commentDepth: 0 };
    let batchLines: string[] = [];
    let batchStartLine = 0;

    const finishBatch = (repeatCount: number) => {
        const text = batchLines.join("\n");
        if (text.trim() !== "") {
            for (let i = 0; i < repeatCount; i++) batches.push({ text, startLine: batchStartLine });
        }
        batchLines = [];
    };

    lines.forEach((line, lineIndex) => {
        const goMatch = state.mode === "code" ? GO_LINE.exec(line.replace(/\r$/, "")) : null;
        if (goMatch) {
            finishBatch(goMatch[1] === undefined ? 1 : Number(goMatch[1]));
            batchStartLine = lineIndex + 1;
            return;
        }
        batchLines.push(line);
        state = scanLine(line, state);
    });
    finishBatch(1);
    return batches;
}

/** Moves through one line and returns the state at its end. */
function scanLine(line: string, initial: LexicalState): LexicalState {
    let { mode, commentDepth } = initial;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const next = line[i + 1];
        switch (mode) {
            case "code":
                if (char === "'") mode = "string";
                else if (char === '"') mode = "quotedIdentifier";
                else if (char === "[") mode = "bracketIdentifier";
                else if (char === "-" && next === "-")
                    return { mode, commentDepth }; // rest of the line is a comment
                else if (char === "/" && next === "*") {
                    mode = "blockComment";
                    commentDepth = 1;
                    i++;
                }
                break;
            case "string":
                if (char === "'") {
                    if (next === "'")
                        i++; // escaped quote
                    else mode = "code";
                }
                break;
            case "quotedIdentifier":
                if (char === '"') {
                    if (next === '"') i++;
                    else mode = "code";
                }
                break;
            case "bracketIdentifier":
                if (char === "]") {
                    if (next === "]") i++;
                    else mode = "code";
                }
                break;
            case "blockComment":
                if (char === "/" && next === "*") {
                    commentDepth++;
                    i++;
                } else if (char === "*" && next === "/") {
                    commentDepth--;
                    i++;
                    if (commentDepth === 0) mode = "code";
                }
                break;
        }
    }
    return { mode, commentDepth };
}
