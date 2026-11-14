/**
 * What autocompletion should offer at a cursor position, found from the tokens alone.
 *
 * sqltoolsservice parses the script with Microsoft's T-SQL parser and binds it against the catalog.
 * There is no parser here, and the text is incomplete by nature while it is typed, so this is a
 * heuristic over the tokens of the statement around the cursor: the word being typed and what is
 * written before it, the relations in scope with their aliases (FROM, JOIN, UPDATE, INSERT INTO,
 * MERGE, comma joins, subqueries with their own scope, CTEs, derived tables), and the clause the
 * cursor is in. It is engine-neutral: engine rules come in through the driver's tokenizer, statement
 * detection and reserved words.
 */

import type { SqlToken, TextPosition, TextRange } from "../../drivers/types";
import { tokenIndexAt } from "../../sql/lexer";

/** What the analysis needs from the driver (a subset of `Driver`). */
export interface ContextDriver {
    tokenize(script: string): SqlToken[];
    getStatementAt(script: string, position: TextPosition): TextRange | undefined;
    splitBatches(script: string): { text: string; startLine: number }[];
    readonly language: { readonly reservedKeywords: ReadonlySet<string> };
}

/** An identifier as written (`text`) and as named in the catalog (`name`, quotes removed). */
export interface Identifier {
    text: string;
    name: string;
    quoted: boolean;
}

export interface ScopeRelation {
    /** [name], [schema, name] or [database, schema, name] as written; empty for a derived table. */
    parts: Identifier[];
    alias?: Identifier;
    kind: "table" | "function" | "cte" | "derived";
    /** Columns known from the script (CTEs, derived tables); undefined when unknown (`*`). */
    columns?: string[];
    /** 0 for the query the cursor is in, 1 for the query around it, and so on. */
    depth: number;
}

export interface CommonTableExpression {
    name: Identifier;
    columns?: string[];
}

export type PositionKind =
    /** Inside a string or a comment, or where a new name is typed: nothing to offer. */
    | "none"
    /** Start of a statement, or after a keyword that calls for another keyword. */
    | "keyword"
    /** After a complete operand (`SELECT a |`, `FROM t |`): keywords (FROM, AS, WHERE, JOIN...). */
    | "afterOperand"
    /** Where a table, view or table function goes (FROM, JOIN, INTO, UPDATE...). */
    | "relation"
    /** After EXEC / EXECUTE / CALL. */
    | "procedure"
    /** After USE. */
    | "database"
    /** Column list of INSERT INTO t (...) and assignments of UPDATE t SET: columns of `target`. */
    | "targetColumn"
    /** Where a data type goes (CAST(x AS, ::, DECLARE @x, column definitions). */
    | "dataType"
    /** Expressions: select list, WHERE, ON, GROUP BY, ORDER BY, HAVING, VALUES, arguments... */
    | "expression";

export interface WordAtCursor {
    /** Offset where the typed word starts (its opening quote or "@" included). */
    start: number;
    /** The cursor. */
    end: number;
    /** End of the whole word when the cursor is inside it. */
    replaceEnd: number;
    /** The typed text, opening quote included. */
    text: string;
    /** Opening quote typed by the user ("[" or '"'). */
    quote?: string;
}

export interface CompletionContext {
    kind: PositionKind;
    word: WordAtCursor;
    /** Names written before the word, each followed by a dot: `db.dbo.` -> [db, dbo]. */
    qualifiers: Identifier[];
    /** Relations visible from the cursor, the cursor's own query first. */
    relations: ScopeRelation[];
    ctes: CommonTableExpression[];
    /** The relation of INSERT INTO / UPDATE / MERGE, for `targetColumn` positions. */
    target?: ScopeRelation;
    /** Variables (@name) of the batch written before the cursor, with their declared type. */
    variables: { name: string; type?: string }[];
}

interface Token extends SqlToken {
    text: string;
    /** Upper-case text: keywords compare equal whatever their case. */
    upper: string;
}

const words = (list: string): ReadonlySet<string> => new Set(list.trim().split(/\s+/));

/** After these, a relation is written (TABLE and VIEW unless they create one). */
const RELATION_INTRODUCERS = words("FROM JOIN APPLY INTO UPDATE USING MERGE TRUNCATE TABLE VIEW");
/** The subset that also brings a relation into scope. */
const SCOPE_INTRODUCERS = words("FROM JOIN APPLY INTO UPDATE USING MERGE");
const FROM_CLAUSES = words("FROM JOIN APPLY");
const PROCEDURE_INTRODUCERS = words("EXEC EXECUTE CALL");
/** After these, an expression starts. */
const EXPRESSION_INTRODUCERS = words(`
    SELECT DISTINCT WHERE ON AND OR NOT BY HAVING WHEN THEN ELSE CASE BETWEEN LIKE ILIKE
    RETURNING OUTPUT TOP LIMIT OFFSET PRINT RETURN IF WHILE ALL ANY SOME
`);
/** Keywords that end an operand: `IS NULL |` is followed by a keyword, not an expression. */
const OPERAND_KEYWORDS = words("NULL TRUE FALSE END");
/** Words after a relation that cannot be its alias, whatever the engine's reserved words. */
const NOT_ALIASES = words(`
    WHERE JOIN ON INNER LEFT RIGHT FULL CROSS OUTER NATURAL GROUP ORDER HAVING UNION EXCEPT
    INTERSECT SET VALUES SELECT USING WITH LIMIT OFFSET FETCH WINDOW RETURNING OUTPUT OPTION FOR
    INTO AS PIVOT UNPIVOT LATERAL TABLESAMPLE WHEN THEN APPLY DEFAULT EXEC EXECUTE GO
    UPDATE DELETE INSERT MERGE
`);
/** Clause keywords: they tell what a comma separates. */
const CLAUSES = words(`
    SELECT FROM JOIN APPLY WHERE ON BY HAVING SET VALUES RETURNING OUTPUT DECLARE USING INTO
    UPDATE WINDOW LIMIT OFFSET
`);
const CAST_FUNCTIONS = words("CAST TRY_CAST");
const CONVERT_FUNCTIONS = words("CONVERT TRY_CONVERT");
/** CREATE <one of these> <new name>. */
const CREATED_OBJECTS = words(`
    TABLE VIEW PROCEDURE PROC FUNCTION TRIGGER INDEX SCHEMA DATABASE TYPE SEQUENCE SYNONYM ROLE USER
    LOGIN EXTENSION
`);

const isComment = (t: SqlToken) => t.type === "lineComment" || t.type === "blockComment";
const isName = (t: Token | undefined) => t?.type === "word" || t?.type === "quotedIdentifier";
const isPunct = (t: Token | undefined, text: string) =>
    t?.type === "punctuation" && t.text === text;
const isWord = (t: Token | undefined, ...list: string[]) =>
    t?.type === "word" && list.includes(t.upper);

/** The context at `offset` of `script`. */
export function analyzeCompletionContext(
    script: string,
    offset: number,
    driver: ContextDriver,
): CompletionContext {
    const allTokens = driver.tokenize(script);
    const word = wordAtCursor(script, allTokens, offset);
    if (!word) {
        return {
            kind: "none",
            word: { start: offset, end: offset, replaceEnd: offset, text: "" },
            qualifiers: [],
            relations: [],
            ctes: [],
            variables: [],
        };
    }
    const tokens = statementTokens(script, allTokens, word.start, driver);
    const analyzer = new StatementAnalyzer(tokens, word, driver.language.reservedKeywords);
    return { ...analyzer.analyze(), variables: batchVariables(script, allTokens, offset, driver) };
}

/** The word being typed, or an empty word at the cursor; undefined inside a string or comment. */
function wordAtCursor(
    script: string,
    tokens: readonly SqlToken[],
    offset: number,
): WordAtCursor | undefined {
    const index = tokenIndexAt(tokens, offset);
    const token = tokens[index];
    const typed = token && token.start < offset && offset <= token.end ? token : undefined;
    if (typed?.type === "lineComment") return undefined;
    if (typed?.type === "blockComment" && (offset < typed.end || !isClosedComment(script, typed))) {
        return undefined;
    }
    if (typed?.type === "string" && (offset < typed.end || !isClosedString(script, typed))) {
        return undefined;
    }
    if (typed && (typed.type === "word" || typed.type === "variable")) {
        return {
            start: typed.start,
            end: offset,
            replaceEnd: typed.end,
            text: script.slice(typed.start, offset),
        };
    }
    if (typed?.type === "quotedIdentifier") {
        return {
            start: typed.start,
            end: offset,
            replaceEnd: typed.end,
            text: script.slice(typed.start, offset),
            quote: script[typed.start],
        };
    }
    // "@" or "@@" alone is not a variable token yet, but it starts one.
    let start = offset;
    for (
        let i = index;
        i >= 0 && tokens[i].end === start && script.slice(tokens[i].start, tokens[i].end) === "@";
        i--
    ) {
        start = tokens[i].start;
    }
    return { start, end: offset, replaceEnd: offset, text: script.slice(start, offset) };
}

function isClosedComment(script: string, token: SqlToken): boolean {
    return token.end - token.start >= 4 && script.startsWith("*/", token.end - 2);
}

function isClosedString(script: string, token: SqlToken): boolean {
    const text = script.slice(token.start, token.end);
    const quote = text.search(/['$]/);
    return text.length - quote >= 2 && (text.endsWith("'") || text.endsWith("$"));
}

/**
 * Tokens (comments left out) of the statement the cursor is in. The statement is the one of the last
 * token before the cursor, so that `SELECT * FROM t WHERE` followed by a new line is still the
 * statement being written; after a semicolon, a new statement starts.
 */
function statementTokens(
    script: string,
    allTokens: readonly SqlToken[],
    wordStart: number,
    driver: ContextDriver,
): Token[] {
    const tokens: Token[] = allTokens
        .filter((t) => !isComment(t))
        .map((t) => {
            const text = script.slice(t.start, t.end);
            return { ...t, text, upper: t.type === "word" ? text.toUpperCase() : text };
        });
    let anchor = -1;
    while (anchor + 1 < tokens.length && tokens[anchor + 1].end <= wordStart) anchor++;
    const nextSemicolon = (from: number) => {
        const index = tokens.findIndex((t, i) => i >= from && isPunct(t, ";"));
        return index === -1 ? tokens.length : index;
    };
    if (anchor === -1 || isPunct(tokens[anchor], ";")) {
        return tokens.slice(anchor + 1, nextSemicolon(anchor + 1));
    }
    const starts = lineStarts(script);
    const range = driver.getStatementAt(script, positionAt(starts, tokens[anchor].start));
    if (!range) {
        let first = anchor;
        while (first > 0 && !isPunct(tokens[first - 1], ";")) first--;
        return tokens.slice(first, nextSemicolon(anchor));
    }
    const from = starts[range.start.line] + range.start.column;
    const to = starts[range.end.line] + range.end.column;
    return tokens.filter(
        (t) => t.start >= from && (t.end <= to || t.start <= wordStart) && !isPunct(t, ";"),
    );
}

function lineStarts(script: string): number[] {
    const starts = [0];
    for (let i = script.indexOf("\n"); i !== -1; i = script.indexOf("\n", i + 1))
        starts.push(i + 1);
    return starts;
}

function positionAt(starts: readonly number[], offset: number): TextPosition {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= offset) low = middle;
        else high = middle - 1;
    }
    return { line: low, column: offset - starts[low] };
}

/** An identifier token as written and as named: [a]]b] -> a]b, "x""y" -> x"y. */
export function identifierOf(token: { type: string; text: string }): Identifier {
    if (token.type !== "quotedIdentifier") {
        return { text: token.text, name: token.text, quoted: false };
    }
    const close = token.text[0] === "[" ? "]" : token.text[0];
    let inner = token.text.slice(1);
    if (inner.endsWith(close)) inner = inner.slice(0, -1);
    return { text: token.text, name: inner.split(close + close).join(close), quoted: true };
}

/** Case-insensitive unless both are quoted: enough for aliases and CTE names. */
export function sameName(a: Identifier, b: Identifier): boolean {
    return a.quoted && b.quoted ? a.name === b.name : a.name.toLowerCase() === b.name.toLowerCase();
}

class StatementAnalyzer {
    /** Index of the ")" closing the "(" at an index (tokens.length while it is open). */
    private readonly close = new Map<number, number>();
    /** Index of the "(" of the group around each token; -1 at the top level. */
    private readonly parent: number[] = [];
    /** Index of the first token at or after the cursor's word. */
    private readonly cursor: number;
    /** Index of the word being typed, -1 when nothing is typed. */
    private readonly typed: number;
    /** The "(" of the groups around the cursor, innermost first, then -1 for the statement. */
    private readonly chain: number[] = [];

    constructor(
        private readonly tokens: Token[],
        private readonly word: WordAtCursor,
        private readonly reserved: ReadonlySet<string>,
    ) {
        const stack: number[] = [];
        tokens.forEach((token, i) => {
            this.parent.push(stack.length ? stack[stack.length - 1] : -1);
            if (isPunct(token, "(")) stack.push(i);
            else if (isPunct(token, ")") && stack.length) this.close.set(stack.pop()!, i);
        });
        for (const open of stack) this.close.set(open, tokens.length);

        const cursor = tokens.findIndex((t) => t.start >= word.start);
        this.cursor = cursor === -1 ? tokens.length : cursor;
        this.typed = word.text && tokens[this.cursor]?.start === word.start ? this.cursor : -1;
        for (let i = 0; i < this.cursor; i++) {
            if (isPunct(tokens[i], "(") && this.close.get(i)! >= this.cursor) this.chain.unshift(i);
        }
        this.chain.push(-1);
    }

    analyze(): Omit<CompletionContext, "variables"> {
        const qualifiers: Identifier[] = [];
        let before = this.cursor - 1;
        while (
            before >= 1 &&
            isPunct(this.tokens[before], ".") &&
            isName(this.tokens[before - 1])
        ) {
            qualifiers.unshift(identifierOf(this.tokens[before - 1]));
            before -= 2;
        }
        const ctes = this.commonTableExpressions();
        const relations = this.relationsInScope(ctes);
        const target = this.target(relations);
        let kind = this.positionKind(before, target);
        if (qualifiers.length > 0 && (kind === "afterOperand" || kind === "keyword")) {
            // A dotted name in progress: `x.` at the start of an expression or a statement.
            kind = "expression";
        }
        return {
            kind,
            word: this.word,
            qualifiers,
            relations,
            ctes,
            target: kind === "targetColumn" ? target : undefined,
        };
    }

    // -- position -----------------------------------------------------------------------------

    /** What goes after the token at `prevIndex` (the cursor's word, or the dotted name it ends). */
    private positionKind(prevIndex: number, target: ScopeRelation | undefined): PositionKind {
        const prev = this.tokens[prevIndex];
        if (!prev) return "keyword";
        if (prev.type === "word") {
            const kind = this.afterWord(prevIndex, target);
            if (kind) return kind;
            if (this.isKeyword(prev) && !OPERAND_KEYWORDS.has(prev.upper)) return "keyword";
        }
        if (prev.type === "operator") {
            if (prev.text === "::") return "dataType";
            if (prev.text === "*" && this.isSelectStar(prevIndex)) return "afterOperand";
            return "expression";
        }
        if (isPunct(prev, "(") || isPunct(prev, ","))
            return this.afterOpenOrComma(prevIndex, target);
        if (prev.type === "number" && isWord(this.tokens[prevIndex - 1], "TOP"))
            return "expression";
        if (prev.type === "variable" && this.isDeclaration(prevIndex)) return "dataType";
        if (isName(prev) && this.isColumnDefinitionName(prevIndex)) return "dataType";
        // A name, number, string, variable or ")" ends an operand.
        return "afterOperand";
    }

    /** What goes after a keyword; undefined when the word gives no clue (identifiers). */
    private afterWord(index: number, target: ScopeRelation | undefined): PositionKind | undefined {
        const keyword = this.tokens[index].upper;
        const first = this.tokens[0].upper;
        const ifBefore =
            isWord(this.tokens[index - 1], "IF") ||
            (isWord(this.tokens[index - 1], "NOT") && isWord(this.tokens[index - 2], "IF"));
        if (keyword === "EXISTS" && ifBefore) {
            // CREATE TABLE IF NOT EXISTS <new name>, DROP TABLE IF EXISTS <relation>.
            return first === "CREATE" ? "none" : first === "DROP" ? "relation" : "keyword";
        }
        if (CREATED_OBJECTS.has(keyword) && this.createsObject(index)) return "none";
        if (keyword === "DELETE") return "relation";
        if (RELATION_INTRODUCERS.has(keyword)) {
            // FOR UPDATE, ON DELETE / UPDATE CASCADE, THEN UPDATE SET: no relation follows.
            if (keyword === "UPDATE" && isWord(this.tokens[index - 1], "FOR", "ON", "THEN")) {
                return "keyword";
            }
            if (keyword === "USING" && this.isJoinUsing(index)) return "keyword";
            return "relation";
        }
        if (PROCEDURE_INTRODUCERS.has(keyword)) return "procedure";
        if (
            (keyword === "PROCEDURE" || keyword === "PROC") &&
            (first === "DROP" || first === "ALTER")
        ) {
            return "procedure";
        }
        if (keyword === "USE") return "database";
        if (keyword === "SET")
            return target && this.isUpdateSet(index) ? "targetColumn" : "keyword";
        if (keyword === "AS") return this.afterAs(index);
        if (keyword === "RETURNS") return "dataType";
        if (keyword === "TYPE" && first === "ALTER") return "dataType";
        if (EXPRESSION_INTRODUCERS.has(keyword)) return "expression";
        return undefined;
    }

    private afterOpenOrComma(index: number, target: ScopeRelation | undefined): PositionKind {
        const group = this.chain[0];
        const isOpen = isPunct(this.tokens[index], "(");
        if (group !== -1 && !this.isQueryGroup(group)) {
            if (target && this.isInsertColumnList(group)) return "targetColumn";
            if (this.isCreateTableList(group)) return "keyword";
            if (isOpen && CONVERT_FUNCTIONS.has(this.tokens[group - 1]?.upper ?? ""))
                return "dataType";
            return "expression";
        }
        if (isOpen) return "expression";
        const clause = this.lastClause(index, group);
        if (clause === undefined) return "expression";
        if (FROM_CLAUSES.has(clause)) return "relation";
        if (clause === "SET") return target && this.isUpdateSet(index) ? "targetColumn" : "keyword";
        if (clause === "DECLARE") return "none";
        if (clause === "USING" || clause === "INTO" || clause === "UPDATE") return "relation";
        return "expression";
    }

    private afterAs(index: number): PositionKind {
        const group = this.parent[index];
        if (group !== -1 && CAST_FUNCTIONS.has(this.tokens[group - 1]?.upper ?? ""))
            return "dataType";
        const before = this.tokens[index - 1];
        if (before?.type === "variable" && this.isDeclaration(index - 1)) return "dataType";
        const first = this.tokens[0].upper;
        // CREATE VIEW v AS, CREATE PROCEDURE p AS, WITH x AS: a statement or "(" follows.
        if (
            (first === "CREATE" || first === "ALTER" || first === "WITH") &&
            !this.lastClause(index, -1)
        ) {
            return "keyword";
        }
        // SELECT x AS alias, FROM t AS alias: a new name.
        return "none";
    }

    private isKeyword(token: Token): boolean {
        return (
            this.reserved.has(token.upper) ||
            EXPRESSION_INTRODUCERS.has(token.upper) ||
            CLAUSES.has(token.upper) ||
            NOT_ALIASES.has(token.upper)
        );
    }

    /** CREATE [OR REPLACE] [TEMP...] <object>: the word after it is a new name. */
    private createsObject(index: number): boolean {
        for (let i = index - 1; i >= 0 && i >= index - 5; i--) {
            const token = this.tokens[i];
            if (token.type !== "word") return false;
            if (token.upper === "CREATE") return true;
            if (["ALTER", "DROP", "TRUNCATE", "FROM", "INTO", "ON"].includes(token.upper))
                return false;
        }
        return false;
    }

    /** `JOIN t USING (col)`, as opposed to MERGE ... USING s and DELETE ... USING t. */
    private isJoinUsing(index: number): boolean {
        for (let i = index - 1; i >= 0; i--) {
            if (this.parent[i] !== this.parent[index] || this.tokens[i].type !== "word") continue;
            const upper = this.tokens[i].upper;
            if (upper === "JOIN") return true;
            if (["MERGE", "DELETE", "FROM", "WHERE", "SELECT"].includes(upper)) return false;
        }
        return false;
    }

    private isSelectStar(index: number): boolean {
        const before = this.tokens[index - 1];
        return (
            !before ||
            isWord(before, "SELECT", "DISTINCT", "ALL") ||
            isPunct(before, ",") ||
            isPunct(before, ".") ||
            isPunct(before, "(")
        );
    }

    /** `DECLARE @x` or `DECLARE @a int, @b`: a type follows the variable. */
    private isDeclaration(index: number): boolean {
        const before = this.tokens[index - 1];
        if (isWord(before, "DECLARE")) return true;
        return isPunct(before, ",") && this.lastClause(index - 1, this.parent[index]) === "DECLARE";
    }

    /** `CREATE TABLE t (id`, `ALTER TABLE t ADD c`, `ALTER COLUMN c`: a type follows the name. */
    private isColumnDefinitionName(index: number): boolean {
        const before = this.tokens[index - 1];
        if (isWord(before, "ADD", "COLUMN") && this.tokens[0].upper === "ALTER") return true;
        const group = this.parent[index];
        return (
            group !== -1 &&
            this.isCreateTableList(group) &&
            (isPunct(before, "(") || isPunct(before, ","))
        );
    }

    /** The column definitions of CREATE TABLE t ( ... ). */
    private isCreateTableList(group: number): boolean {
        const before = this.tokens.slice(0, group);
        return (
            this.parent[group] === -1 &&
            this.tokens[0].upper === "CREATE" &&
            before.some((t) => isWord(t, "TABLE")) &&
            !before.some((t) => isWord(t, "AS", "SELECT", "FUNCTION", "RETURNS"))
        );
    }

    /** The "(" right after the target of INSERT INTO. */
    private isInsertColumnList(group: number): boolean {
        let i = group - 1;
        while (i >= 2 && isName(this.tokens[i]) && isPunct(this.tokens[i - 1], ".")) i -= 2;
        return isName(this.tokens[i]) && isWord(this.tokens[i - 1], "INTO", "INSERT");
    }

    /** The SET at or before `index` belongs to an UPDATE (or MERGE's THEN UPDATE SET). */
    private isUpdateSet(index: number): boolean {
        for (let i = index; i >= 0; i--) {
            const token = this.tokens[i];
            if (token.type !== "word" || this.parent[i] !== this.parent[index]) continue;
            if (token.upper === "SET") {
                return this.tokens.slice(Math.max(0, i - 8), i).some((t) => isWord(t, "UPDATE"));
            }
            if (CLAUSES.has(token.upper)) return false;
        }
        return false;
    }

    /**
     * Last clause keyword at or before `index` in `group`. ON is skipped: a comma after a join
     * condition (`JOIN b ON a.x = b.y, c`) continues the FROM list.
     */
    private lastClause(index: number, group: number): string | undefined {
        for (let i = Math.min(index, this.tokens.length - 1); i >= 0; i--) {
            const token = this.tokens[i];
            if (
                this.parent[i] === group &&
                token.type === "word" &&
                CLAUSES.has(token.upper) &&
                token.upper !== "ON"
            ) {
                return token.upper;
            }
        }
        return undefined;
    }

    private isQueryGroup(open: number): boolean {
        return isWord(this.tokens[open + 1], "SELECT", "WITH", "VALUES");
    }

    // -- scope --------------------------------------------------------------------------------

    private relationsInScope(ctes: CommonTableExpression[]): ScopeRelation[] {
        const relations: ScopeRelation[] = [];
        const blocks = this.chain.filter((open) => open === -1 || this.isQueryGroup(open));
        blocks.forEach((open, depth) => {
            for (const relation of this.blockRelations(open, depth)) {
                if (relation.kind === "table" && relation.parts.length === 1) {
                    const cte = ctes.find((c) => sameName(c.name, relation.parts[0]));
                    if (cte) {
                        relation.kind = "cte";
                        relation.columns = cte.columns;
                    }
                }
                relations.push(relation);
            }
        });
        return relations;
    }

    /** Relations introduced at the top level of the query block opened at `open` (-1: the statement). */
    private blockRelations(open: number, depth: number): ScopeRelation[] {
        const relations: ScopeRelation[] = [];
        const end = open === -1 ? this.tokens.length : this.close.get(open)!;
        let parsedUntil = open + 1;
        for (let i = open + 1; i < end; i++) {
            const token = this.tokens[i];
            if (i < parsedUntil || this.parent[i] !== open) continue;
            // A comma after a join condition: FROM a JOIN b ON a.x = b.y, c
            if (isPunct(token, ",") && FROM_CLAUSES.has(this.lastClause(i, open) ?? "")) {
                const parsed = this.parseRelation(i + 1, "FROM", depth);
                if (parsed) {
                    relations.push(parsed.relation);
                    parsedUntil = parsed.next;
                }
                continue;
            }
            if (token.type !== "word") continue;
            let introducer = token.upper;
            if (introducer === "DELETE" && !isWord(this.tokens[i + 1], "FROM")) introducer = "FROM";
            if (!SCOPE_INTRODUCERS.has(introducer)) continue;
            if (introducer === "UPDATE" && isWord(this.tokens[i - 1], "FOR", "ON", "THEN"))
                continue;
            if (introducer === "MERGE" && isWord(this.tokens[i + 1], "INTO")) continue;
            if (introducer === "USING" && this.isJoinUsing(i)) continue;
            let next = i + 1;
            if (isWord(this.tokens[next], "ONLY", "LATERAL")) next++;
            for (;;) {
                const parsed = this.parseRelation(next, introducer, depth);
                if (!parsed) break;
                relations.push(parsed.relation);
                next = parsed.next;
                parsedUntil = next;
                // FROM a, b
                if (!FROM_CLAUSES.has(introducer) || !isPunct(this.tokens[next], ",")) break;
                next++;
            }
        }
        return relations;
    }

    /** A relation reference at `index`: a name or a (subquery), then an optional alias. */
    private parseRelation(
        index: number,
        introducer: string,
        depth: number,
    ): { relation: ScopeRelation; next: number } | undefined {
        let i = index;
        const token = this.tokens[i];
        let relation: ScopeRelation;
        if (isPunct(token, "(")) {
            relation = {
                parts: [],
                kind: "derived",
                columns: this.isQueryGroup(i) ? this.selectColumns(i) : undefined,
                depth,
            };
            i = this.close.get(i)! + 1;
        } else if (isName(token) && i !== this.typed && !this.isReservedWord(token)) {
            const parts = [identifierOf(token)];
            i++;
            while (
                isPunct(this.tokens[i], ".") &&
                isName(this.tokens[i + 1]) &&
                i + 1 !== this.typed
            ) {
                parts.push(identifierOf(this.tokens[i + 1]));
                i += 2;
            }
            relation = { parts, kind: "table", depth };
            if (isPunct(this.tokens[i], "(") && FROM_CLAUSES.has(introducer)) {
                relation.kind = "function";
                i = this.close.get(i)! + 1;
            }
        } else {
            return undefined;
        }
        // [AS] alias [(column aliases)]
        let alias: Token | undefined;
        if (isWord(this.tokens[i], "AS") && isName(this.tokens[i + 1]) && i + 1 !== this.typed) {
            alias = this.tokens[i + 1];
            i += 2;
        } else if (
            isName(this.tokens[i]) &&
            i !== this.typed &&
            !this.isReservedWord(this.tokens[i])
        ) {
            alias = this.tokens[i];
            i++;
        }
        if (alias) {
            relation.alias = identifierOf(alias);
            if (isPunct(this.tokens[i], "(") && relation.kind !== "table") {
                relation.columns = this.nameList(i);
                i = this.close.get(i)! + 1;
            }
        }
        return { relation, next: i };
    }

    private isReservedWord(token: Token): boolean {
        return (
            token.type === "word" &&
            (NOT_ALIASES.has(token.upper) || this.reserved.has(token.upper))
        );
    }

    /** Names of a parenthesized list: (a, b, c). */
    private nameList(open: number): string[] {
        const names: string[] = [];
        for (let i = open + 1; i < this.close.get(open)!; i++) {
            if (this.parent[i] === open && isName(this.tokens[i])) {
                names.push(identifierOf(this.tokens[i]).name);
            }
        }
        return names;
    }

    /** Columns of a subquery's select list when they can be told cheaply; undefined with `*`. */
    private selectColumns(open: number): string[] | undefined {
        const end = this.close.get(open)!;
        let i = open + 1;
        while (i < end && !(this.parent[i] === open && isWord(this.tokens[i], "SELECT"))) i++;
        const items: Token[][] = [[]];
        for (i++; i < end; i++) {
            if (this.parent[i] !== open) continue;
            const token = this.tokens[i];
            if (token.type === "word" && CLAUSES.has(token.upper)) break;
            if (isPunct(token, ",")) items.push([]);
            else if (!isWord(token, "DISTINCT", "ALL", "TOP")) items[items.length - 1].push(token);
        }
        const columns: string[] = [];
        for (const item of items) {
            const last = item[item.length - 1];
            if (!last) continue;
            if (last.text === "*") return undefined;
            if (item.length > 2 && isName(item[0]) && item[1].text === "=") {
                columns.push(identifierOf(item[0]).name); // alias = expression (T-SQL)
            } else if (isName(last)) {
                columns.push(identifierOf(last).name);
            }
        }
        return columns;
    }

    /** WITH [RECURSIVE] a [(columns)] AS [[NOT] MATERIALIZED] (query), b AS (...) */
    private commonTableExpressions(): CommonTableExpression[] {
        const ctes: CommonTableExpression[] = [];
        if (!isWord(this.tokens[0], "WITH")) return ctes;
        let i = isWord(this.tokens[1], "RECURSIVE") ? 2 : 1;
        while (isName(this.tokens[i])) {
            const cte: CommonTableExpression = { name: identifierOf(this.tokens[i]) };
            i++;
            if (isPunct(this.tokens[i], "(")) {
                cte.columns = this.nameList(i);
                i = this.close.get(i)! + 1;
            }
            if (!isWord(this.tokens[i], "AS")) break;
            i++;
            while (isWord(this.tokens[i], "NOT", "MATERIALIZED")) i++;
            if (!isPunct(this.tokens[i], "(")) break;
            cte.columns ??= this.selectColumns(i);
            ctes.push(cte);
            i = this.close.get(i)! + 1;
            if (!isPunct(this.tokens[i], ",")) break;
            i++;
        }
        return ctes;
    }

    /** The relation of INSERT INTO / UPDATE / MERGE, resolved through the aliases of FROM. */
    private target(relations: ScopeRelation[]): ScopeRelation | undefined {
        for (let i = 0; i < this.tokens.length; i++) {
            const token = this.tokens[i];
            if (token.type !== "word") continue;
            const next = this.tokens[i + 1];
            const isTarget =
                (token.upper === "INTO" && isWord(this.tokens[i - 1], "INSERT", "MERGE")) ||
                (token.upper === "INSERT" && isName(next) && !isWord(next, "INTO")) ||
                (token.upper === "UPDATE" && !isWord(this.tokens[i - 1], "FOR", "ON", "THEN")) ||
                (token.upper === "MERGE" && !isWord(next, "INTO"));
            if (!isTarget) continue;
            const parsed = this.parseRelation(i + 1, "INTO", 0);
            if (!parsed || parsed.relation.kind !== "table") continue;
            const relation = parsed.relation;
            if (relation.parts.length === 1) {
                // UPDATE x SET ... FROM t x (T-SQL): x is an alias.
                const aliased = relations.find(
                    (r) => r.alias && sameName(r.alias, relation.parts[0]),
                );
                if (aliased) return aliased;
            }
            return relation;
        }
        return undefined;
    }
}

/**
 * Variables (@name) written in the batch before the cursor, with the type written after them when
 * they are declared (DECLARE, parameters). PostgreSQL has none.
 */
function batchVariables(
    script: string,
    tokens: readonly SqlToken[],
    offset: number,
    driver: ContextDriver,
): { name: string; type?: string }[] {
    const starts = lineStarts(script);
    const line = positionAt(starts, offset).line;
    const batch = driver
        .splitBatches(script)
        .find((b) => b.startLine <= line && line < b.startLine + b.text.split("\n").length);
    const from = batch ? starts[batch.startLine] : 0;
    const text = (t: SqlToken | undefined) => (t ? script.slice(t.start, t.end) : "");
    const significant = tokens.filter((t) => !isComment(t) && t.start >= from && t.end < offset);
    const variables = new Map<string, { name: string; type?: string }>();
    significant.forEach((token, i) => {
        const name = text(token);
        if (token.type !== "variable" || !name.startsWith("@") || name.startsWith("@@")) return;
        let type: string | undefined;
        if (/^(DECLARE|,|\(|PROCEDURE|PROC|FUNCTION)$/i.test(text(significant[i - 1]))) {
            let next = significant[i + 1];
            if (/^AS$/i.test(text(next))) next = significant[i + 2];
            if (next?.type === "word") type = text(next);
        }
        const known = variables.get(name.toLowerCase());
        if (!known) variables.set(name.toLowerCase(), { name, type });
        else known.type ??= type;
    });
    return [...variables.values()];
}
