/**
 * Does a script change the objects autocompletion knows? Cheap and conservative: a false positive
 * only reloads the metadata, a false negative leaves it stale until "Refresh IntelliSense Cache".
 */

import type { SqlToken } from "../../drivers/types";

/** Statements that create, change or remove objects. */
const DDL_WORDS = new Set(["CREATE", "ALTER", "DROP", "RENAME", "IMPORT", "SP_RENAME"]);

export function changesSchema(script: string, tokens: readonly SqlToken[]): boolean {
    let previous = "";
    for (const token of tokens) {
        if (token.type !== "word") continue;
        const word = script.slice(token.start, token.end).toUpperCase();
        if (DDL_WORDS.has(word)) return true;
        // SELECT ... INTO new_table (T-SQL), CREATE TABLE AS's cousin.
        if (word === "INTO" && previous !== "INSERT" && previous !== "MERGE") return true;
        previous = word;
    }
    return false;
}
