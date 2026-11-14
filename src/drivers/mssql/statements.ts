/**
 * T-SQL lexical rules, and the statements of a batch for "Execute Current Statement".
 *
 * sqltoolsservice parses the script with Microsoft's T-SQL parser (ScriptDom) and runs the
 * statement of the parse tree under the cursor. There is no T-SQL parser here, and T-SQL does
 * not require semicolons ("SELECT 1\nSELECT 2" is two statements), so the statements are found
 * by a heuristic over the tokens: a small state machine driven by the keyword tables below.
 * When it cannot tell, it keeps the larger statement: running two statements is better than
 * running half of one.
 */

import { tokenize, type SqlDialect, type SqlToken } from "../../sql/lexer";
import { pickStatementAt, type StatementSpan } from "../../sql/statementAt";
import type { TextPosition, TextRange } from "../types";
import { splitBatches } from "./batches";

/** T-SQL's lexical rules. */
export const mssqlDialect: SqlDialect = {
    stringQuotes: "'",
    stringPrefixes: [{ prefix: "N" }],
    identifierQuotes: { '"': '"', "[": "]" },
    lineComments: ["--"],
    nestedBlockComments: true,
    // #temp, ##global, $action / $partition.
    wordStart: /[A-Za-z_#$\u0080-￿]/,
    wordPart: /[A-Za-z0-9_#$@\u0080-￿]/,
    variables: [/@@?[A-Za-z0-9_#$@\u0080-￿]+/y],
    // Binary (0x...), money ($12.50) and decimal literals.
    number: /(?:0[xX][0-9A-Fa-f]*|\$[+-]?(?:\d+\.?\d*|\.\d+)|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y,
    operators: "+= -= *= /= %= &= |= ^= <= >= <> != !< !> :: = < > + - * / % & | ^ ~ ! :".split(
        " ",
    ),
};

export function tokenizeMssql(script: string): SqlToken[] {
    return tokenize(script, mssqlDialect);
}

// ---------------------------------------------------------------------------------------------
// Keyword tables
// ---------------------------------------------------------------------------------------------

const words = (list: string): ReadonlySet<string> => new Set(list.trim().split(/\s+/));

/** Keywords a statement can start with (when the context does not say otherwise). */
const STARTERS = words(`
    ALTER BACKUP BEGIN BREAK BULK CHECKPOINT CLOSE COMMIT CONTINUE CREATE DBCC DEALLOCATE
    DECLARE DELETE DENY DISABLE DROP ENABLE END EXEC EXECUTE FETCH GOTO GRANT IF INSERT KILL
    MERGE OPEN PRINT RAISERROR READTEXT RECONFIGURE RESTORE RETURN REVERT REVOKE ROLLBACK
    SAVE SELECT SEND SET SETUSER SHUTDOWN THROW TRUNCATE UPDATE UPDATETEXT USE WAITFOR WHILE
    WITH WRITETEXT
`);

/** Starters that are ordinary words unless the next word is one of these. */
const STARTER_REQUIRES_NEXT: Record<string, readonly string[]> = {
    // ENABLE / DISABLE TRIGGER; END CONVERSATION; SEND ON CONVERSATION.
    ENABLE: ["TRIGGER"],
    DISABLE: ["TRIGGER"],
    END: ["CONVERSATION"],
    SEND: ["ON"],
};

/** A keyword right after one of these words is part of the same statement. */
const CONTINUING_PREVIOUS_WORDS = words(`
    AFTER AND AS BULK EXCEPT FOR INSTEAD INTERSECT NOT OF OR THEN UNION WITH
`);

/** BEGIN followed by one of these is a statement, not the start of a BEGIN...END block. */
const BEGIN_STATEMENTS = words("TRAN TRANSACTION DISTRIBUTED DIALOG CONVERSATION");

/** CREATE / ALTER of these objects take the rest of the batch (their body has statements). */
const CREATE_REST_OF_BATCH = words(`
    PROC PROCEDURE FUNCTION TRIGGER VIEW SCHEMA DEFAULT RULE
`);
const ALTER_REST_OF_BATCH = words("PROC PROCEDURE FUNCTION TRIGGER VIEW");

/** Object types written before IF EXISTS: DROP TABLE IF EXISTS, DROP COLUMN IF EXISTS. */
const IF_EXISTS_OBJECT_TYPES = words(`
    AGGREGATE ASSEMBLY COLUMN CONSTRAINT DATABASE DEFAULT FUNCTION INDEX POLICY PROC
    PROCEDURE ROLE RULE SCHEMA SEQUENCE SYNONYM TABLE TRIGGER TYPE USER VIEW
`);

/** After ALTER ..., "DROP <one of these>" is a new DROP statement; otherwise it drops a column or constraint. */
const DROP_STATEMENT_OBJECT_TYPES = words(`
    AGGREGATE APPLICATION ASSEMBLY ASYMMETRIC AVAILABILITY BROKER CERTIFICATE CONTRACT
    CREDENTIAL DATABASE DEFAULT ENDPOINT EVENT EXTERNAL FULLTEXT FUNCTION INDEX LOGIN MASTER
    MESSAGE PARTITION PROC PROCEDURE QUEUE RESOURCE ROLE ROUTE RULE SCHEMA SEARCH SECURITY
    SEQUENCE SERVER SERVICE SIGNATURE SPATIAL STATISTICS SYMMETRIC SYNONYM TABLE TRIGGER
    TYPE USER VIEW WORKLOAD XML
`);

/** An operator after a keyword makes it a column name (`SET open = 1`), not a statement. */
const ASSIGNMENT_OR_COMPARISON = words(`
    = += -= *= /= %= &= |= ^= < > <= >= <> != !< !>
`);

// ---------------------------------------------------------------------------------------------
// Continuation rules: does a starter keyword continue the statement being read?
// ---------------------------------------------------------------------------------------------

interface Token {
    type: SqlToken["type"];
    start: number;
    end: number;
    /** Upper-case text: keywords compare equal whatever their case. */
    text: string;
}

/** The simple statement being read (the innermost one, inside IF / WHILE). */
interface Clause {
    /** Its first keyword ("SELECT", "INSERT", "WITH" for a CTE...), "BLOCK" for BEGIN...END, "TRY_END" after END TRY, "OTHER". */
    kind: string;
    /** INSERT: its rows source (VALUES, SELECT, EXEC) was seen. */
    hasSource?: boolean;
    /** CTE: the statement after the common table expressions was seen. */
    hasMainStatement?: boolean;
    /** UPDATE (also after MERGE's THEN): waiting for its SET. */
    needsSet?: boolean;
    /** GRANT / DENY / REVOKE: TO or FROM <principal> was seen. */
    hasPrincipal?: boolean;
    /** ALTER: a SET was seen. */
    hasSet?: boolean;
}

interface RuleContext {
    keyword: string;
    clause: Clause;
    previous?: Token;
    beforePrevious?: Token;
    next?: Token;
    afterNext?: Token;
}

interface ContinuationRule {
    /** Kinds of clause the rule applies to; undefined for any. */
    kinds?: readonly string[];
    /** Keywords the rule applies to; undefined for any starter. */
    keywords?: readonly string[];
    when?: (c: RuleContext) => boolean;
    /** Changes to the clause when the rule applies. */
    apply?: (c: RuleContext) => void;
}

const isWord = (token: Token | undefined, ...words: string[]) =>
    token?.type === "word" && words.includes(token.text);

/** Tried in order; the first that applies says the keyword continues the statement. */
const CONTINUATION_RULES: readonly ContinuationRule[] = [
    // UNION ALL SELECT.
    {
        keywords: ["SELECT"],
        when: (c) => isWord(c.previous, "ALL") && isWord(c.beforePrevious, "UNION"),
    },
    // MERGE ... WHEN MATCHED THEN UPDATE SET.
    {
        keywords: ["UPDATE"],
        when: (c) => isWord(c.previous, "THEN"),
        apply: (c) => (c.clause.needsSet = true),
    },
    // UNION SELECT, CURSOR FOR SELECT, FOR UPDATE, WITH ROLLBACK IMMEDIATE, CREATE OR ALTER...
    { when: (c) => c.previous?.type === "word" && CONTINUING_PREVIOUS_WORDS.has(c.previous.text) },
    // Foreign keys: ON DELETE CASCADE, ON UPDATE NO ACTION / SET NULL (but SET NOCOUNT ON, then UPDATE t).
    {
        keywords: ["DELETE", "UPDATE"],
        when: (c) => isWord(c.previous, "ON") && isWord(c.next, "CASCADE", "NO", "SET"),
    },
    // OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY (but OFFSET 10 ROWS, then FETCH NEXT FROM cursor).
    {
        keywords: ["FETCH"],
        when: (c) => isWord(c.previous, "ROW", "ROWS") && !isWord(c.afterNext, "FROM"),
    },
    // DROP TABLE IF EXISTS, ALTER TABLE ... DROP COLUMN IF EXISTS.
    {
        keywords: ["IF"],
        when: (c) =>
            isWord(c.next, "EXISTS") &&
            c.previous?.type === "word" &&
            IF_EXISTS_OBJECT_TYPES.has(c.previous.text),
    },
    // INSERT ... SELECT / EXEC / VALUES.
    {
        kinds: ["INSERT"],
        keywords: ["SELECT", "EXEC", "EXECUTE", "WITH"],
        when: (c) => !c.clause.hasSource,
        apply: (c) => (c.clause.hasSource = true),
    },
    // WITH cte AS (...) SELECT / INSERT / UPDATE / DELETE / MERGE: the CTE becomes that statement.
    {
        kinds: ["WITH"],
        keywords: ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"],
        when: (c) => !c.clause.hasMainStatement,
        apply: (c) =>
            Object.assign(c.clause, newClause(c.keyword, c.next), { hasMainStatement: true }),
    },
    // UPDATE t SET.
    {
        keywords: ["SET"],
        when: (c) => !!c.clause.needsSet,
        apply: (c) => (c.clause.needsSet = false),
    },
    // GRANT SELECT, INSERT, EXECUTE ON ... TO ...: everything before the principal.
    { kinds: ["GRANT", "DENY", "REVOKE"], when: (c) => !c.clause.hasPrincipal },
    // ALTER DATABASE x SET ..., ALTER TABLE t SET (...).
    {
        kinds: ["ALTER"],
        keywords: ["SET"],
        when: (c) => !c.clause.hasSet || c.next?.text === "(",
        apply: (c) => (c.clause.hasSet = true),
    },
    // ALTER TABLE t ALTER COLUMN.
    { kinds: ["ALTER"], keywords: ["ALTER"], when: (c) => isWord(c.next, "COLUMN") },
    // ALTER TABLE t DROP [COLUMN | CONSTRAINT] x.
    {
        kinds: ["ALTER"],
        keywords: ["DROP"],
        when: (c) => !(c.next?.type === "word" && DROP_STATEMENT_OBJECT_TYPES.has(c.next.text)),
    },
    // ALTER TABLE t ENABLE / DISABLE TRIGGER.
    { kinds: ["ALTER"], keywords: ["ENABLE", "DISABLE"] },
];

function newClause(keyword: string, next: Token | undefined): Clause {
    const clause: Clause = { kind: keyword };
    if (keyword === "UPDATE") {
        clause.needsSet = !isWord(next, "STATISTICS");
    }
    return clause;
}

/** What reading a word inside a clause tells about it. */
function observe(clause: Clause, word: string): void {
    if (clause.kind === "INSERT" && (word === "VALUES" || word === "DEFAULT")) {
        clause.hasSource = true;
    } else if (
        (clause.kind === "GRANT" || clause.kind === "DENY" || clause.kind === "REVOKE") &&
        (word === "TO" || word === "FROM")
    ) {
        clause.hasPrincipal = true;
    }
}

// ---------------------------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------------------------

/** IF / WHILE, whose body is the next statement (or block), and an ELSE for IF. */
interface Frame {
    kind: "IF" | "WHILE";
    /** cond: reading the condition; body: reading the body; afterBody: an ELSE may follow; elseStart: right after ELSE; elseBody. */
    phase: "cond" | "body" | "afterBody" | "elseStart" | "elseBody";
}

type BlockKind = "BLOCK" | "TRY" | "CATCH" | "CASE";

interface Statement {
    first: number;
    last: number;
    frames: Frame[];
    clause: Clause | undefined;
    /** Complete: only a semicolon can still be added to it. */
    done: boolean;
    /** CREATE PROCEDURE and the like: everything up to the end of the batch. */
    restOfBatch: boolean;
}

/** Statements of one batch (no GO inside), as offsets in `text`. */
export function mssqlStatementSpans(text: string): StatementSpan[] {
    const tokens: Token[] = tokenizeMssql(text)
        .filter((t) => t.type !== "lineComment" && t.type !== "blockComment")
        .map((t) => ({ ...t, text: text.slice(t.start, t.end).toUpperCase() }));
    const spans: StatementSpan[] = [];
    const blocks: BlockKind[] = [];
    let depth = 0;
    let current: Statement | undefined;

    const isSemicolon = (i: number) => tokens[i].text === ";" && tokens[i].type === "punctuation";

    const isBlockBegin = (i: number) =>
        isWord(tokens[i], "BEGIN") &&
        !(tokens[i + 1]?.type === "word" && BEGIN_STATEMENTS.has(tokens[i + 1].text));

    /** WITH name [(columns)] AS ( : a common table expression. */
    const isCteAt = (i: number): boolean => {
        let j = i + 1;
        if (tokens[j]?.type !== "word" && tokens[j]?.type !== "quotedIdentifier") return false;
        j++;
        if (tokens[j]?.text === "(") {
            let level = 0;
            for (; j < tokens.length; j++) {
                if (tokens[j].text === "(") level++;
                else if (tokens[j].text === ")" && --level === 0) break;
            }
            j++;
        }
        return isWord(tokens[j], "AS") && tokens[j + 1]?.text === "(";
    };

    const isStarter = (i: number): boolean => {
        const token = tokens[i];
        if (token.type !== "word" || !STARTERS.has(token.text)) return false;
        const previous = tokens[i - 1];
        const next = tokens[i + 1];
        if (
            previous &&
            (previous.type === "operator" ||
                (previous.type === "punctuation" && previous.text !== ")" && previous.text !== ";"))
        ) {
            return false; // a name: t.update, a, open, @x = select...
        }
        if (
            next?.text === "." ||
            (next?.type === "operator" && ASSIGNMENT_OR_COMPARISON.has(next.text))
        ) {
            return false;
        }
        const required = STARTER_REQUIRES_NEXT[token.text];
        if (required && !(next?.type === "word" && required.includes(next.text))) return false;
        if (token.text === "UPDATE" && next?.text === "(") return false; // IF UPDATE(column)
        if (token.text === "WITH") return isWord(next, "XMLNAMESPACES") || isCteAt(i);
        return true;
    };

    const continues = (i: number, clause: Clause): boolean => {
        const context: RuleContext = {
            keyword: tokens[i].text,
            clause,
            previous: tokens[i - 1],
            beforePrevious: tokens[i - 2],
            next: tokens[i + 1],
            afterNext: tokens[i + 2],
        };
        const rule = CONTINUATION_RULES.find(
            (r) =>
                (!r.kinds || r.kinds.includes(clause.kind)) &&
                (!r.keywords || r.keywords.includes(context.keyword)) &&
                (!r.when || r.when(context)),
        );
        rule?.apply?.(context);
        return !!rule;
    };

    const closeStatement = () => {
        if (current) {
            spans.push({ start: tokens[current.first].start, end: tokens[current.last].end });
        }
        current = undefined;
    };

    /** The innermost statement ended: the IF / WHILE around it may end too. */
    const finishClause = (statement: Statement) => {
        statement.clause = undefined;
        for (;;) {
            const frame = statement.frames.at(-1);
            if (!frame) {
                statement.done = true;
                return;
            }
            if (frame.kind === "IF" && frame.phase === "body") {
                frame.phase = "afterBody";
                return;
            }
            statement.frames.pop();
        }
    };

    /**
     * Reads a token that does not split anything: parentheses, CASE...END and BEGIN...END
     * nesting. Returns the index of the last token it consumed.
     */
    const absorb = (i: number, statement: Statement): number => {
        const token = tokens[i];
        let last = i;
        if (token.text === "(" && token.type === "punctuation") {
            depth++;
        } else if (token.text === ")" && token.type === "punctuation") {
            depth = Math.max(0, depth - 1);
        } else if (isWord(token, "CASE")) {
            blocks.push("CASE");
        } else if (isBlockBegin(i)) {
            const next = tokens[i + 1];
            if (isWord(next, "TRY") || isWord(next, "CATCH")) {
                blocks.push(next.text as BlockKind);
                last = i + 1;
            } else {
                blocks.push("BLOCK");
            }
        } else if (
            isWord(token, "END") &&
            !isWord(tokens[i + 1], "CONVERSATION") &&
            blocks.length > 0
        ) {
            const closed = blocks.pop()!;
            if ((closed === "TRY" || closed === "CATCH") && isWord(tokens[i + 1], closed)) {
                last = i + 1;
            }
            if (blocks.length === 0 && depth === 0 && statement.clause?.kind === "BLOCK") {
                if (closed === "TRY") {
                    statement.clause.kind = "TRY_END"; // BEGIN CATCH must follow
                } else if (closed !== "CASE") {
                    finishClause(statement);
                }
            }
        } else if (
            token.type === "word" &&
            statement.clause &&
            depth === 0 &&
            blocks.length === 0
        ) {
            observe(statement.clause, token.text);
        }
        statement.last = last;
        return last;
    };

    /** Starts the innermost statement (a body of IF / WHILE, or a whole statement) at `i`. */
    const startClause = (i: number, statement: Statement): number => {
        const frame = statement.frames.at(-1);
        if (frame?.phase === "cond") frame.phase = "body";
        else if (frame?.phase === "elseStart") frame.phase = "elseBody";

        const token = tokens[i];
        const next = tokens[i + 1];
        if (isWord(token, "IF", "WHILE") && isStarter(i)) {
            statement.frames.push({ kind: token.text as Frame["kind"], phase: "cond" });
            statement.clause = undefined;
            statement.last = i;
            return i;
        }
        if (isBlockBegin(i)) {
            statement.clause = { kind: "BLOCK" };
            return absorb(i, statement);
        }
        const keyword = isStarter(i) ? token.text : "OTHER";
        statement.clause = newClause(keyword, next);
        if (
            (keyword === "CREATE" && CREATE_REST_OF_BATCH.has(objectTypeAfterCreate(i))) ||
            (keyword === "ALTER" && next?.type === "word" && ALTER_REST_OF_BATCH.has(next.text))
        ) {
            statement.restOfBatch = true;
        }
        const last = absorb(i, statement);
        // A label ("retry:") is a statement of its own.
        if (
            keyword === "OTHER" &&
            token.type === "word" &&
            next?.text === ":" &&
            next.type === "operator"
        ) {
            statement.last = i + 1;
            finishClause(statement);
            return i + 1;
        }
        return last;
    };

    /** CREATE [OR ALTER] <object type>. */
    const objectTypeAfterCreate = (i: number): string => {
        let j = i + 1;
        if (isWord(tokens[j], "OR") && isWord(tokens[j + 1], "ALTER")) j += 2;
        return tokens[j]?.type === "word" ? tokens[j].text : "";
    };

    const startStatement = (i: number): number => {
        current = {
            first: i,
            last: i,
            frames: [],
            clause: undefined,
            done: false,
            restOfBatch: false,
        };
        return startClause(i, current);
    };

    /** Reads token `i` and returns the index of the last token consumed. */
    const step = (i: number): number => {
        const token = tokens[i];
        if (!current) {
            return isSemicolon(i) ? i : startStatement(i);
        }
        const statement = current;
        if (statement.restOfBatch || depth > 0 || blocks.length > 0) {
            return absorb(i, statement);
        }

        const frame = statement.frames.at(-1);
        const awaitingElse =
            !statement.clause && frame?.kind === "IF" && frame.phase === "afterBody";
        if (statement.done || awaitingElse) {
            if (isSemicolon(i)) {
                // Its own semicolon; another one after it ends nothing.
                if (!isSemicolon(statement.last)) statement.last = i;
                return i;
            }
            if (awaitingElse && isWord(token, "ELSE")) {
                frame!.phase = "elseStart";
                statement.last = i;
                return i;
            }
            closeStatement();
            return startStatement(i);
        }

        const clause = statement.clause;
        if (!clause) {
            // Reading the condition of IF / WHILE, or right after ELSE.
            if (isSemicolon(i)) {
                statement.last = i;
                statement.frames = [];
                statement.done = true;
                return i;
            }
            if (frame?.phase === "elseStart" || isStarter(i) || isBlockBegin(i)) {
                return startClause(i, statement);
            }
            return absorb(i, statement);
        }

        if (clause.kind === "TRY_END") {
            if (isBlockBegin(i) && isWord(tokens[i + 1], "CATCH")) {
                clause.kind = "BLOCK";
                return absorb(i, statement);
            }
            finishClause(statement);
            return step(i);
        }
        if (isSemicolon(i)) {
            statement.last = i;
            finishClause(statement);
            return i;
        }
        if (isWord(token, "ELSE") && statement.frames.length > 0) {
            finishClause(statement);
            return step(i);
        }
        if (isStarter(i)) {
            if (continues(i, clause)) {
                return absorb(i, statement);
            }
            finishClause(statement);
            return step(i);
        }
        return absorb(i, statement);
    };

    for (let i = 0; i < tokens.length; i++) {
        i = step(i);
    }
    closeStatement();
    return spans;
}

/** Range of the statement at `position` in a script made of GO-separated batches. */
export function getMssqlStatementAt(script: string, position: TextPosition): TextRange | undefined {
    const batch = splitBatches(script).find(
        (b) =>
            b.startLine <= position.line && position.line < b.startLine + b.text.split("\n").length,
    );
    if (!batch) {
        return undefined;
    }
    const range = pickStatementAt(batch.text, mssqlStatementSpans(batch.text), {
        line: position.line - batch.startLine,
        column: position.column,
    });
    return (
        range && {
            start: { line: range.start.line + batch.startLine, column: range.start.column },
            end: { line: range.end.line + batch.startLine, column: range.end.column },
        }
    );
}
