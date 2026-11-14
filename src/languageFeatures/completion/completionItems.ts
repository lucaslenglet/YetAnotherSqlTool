/**
 * The suggestions for a cursor position: context (completionContext.ts) + metadata
 * (completionMetadata.ts) -> items. No dependency on `vscode`: completionProvider.ts converts them.
 *
 * Kinds, details and inserted text follow sqltoolsservice (docs/reference/mssql-completions.json):
 * schemas are modules, tables and views files, columns fields, routines and functions values,
 * procedures, synonyms, aliases and variables units, databases methods; a function inserts
 * `name($0)` as a snippet; a name that needs quoting is inserted quoted ([Order Lines]). Unlike
 * sqltoolsservice, items are sorted by relevance (columns in scope first, keywords last), objects of
 * other schemas are offered schema-qualified, and keywords are offered where an expression goes.
 */

import type { CompletionColumn, CompletionObject, SqlLanguage } from "../../drivers/types";
import {
    analyzeCompletionContext,
    sameName,
    type CompletionContext,
    type ContextDriver,
    type Identifier,
    type ScopeRelation,
} from "./completionContext";
import { relationKey, type CompletionMetadata, type ObjectIndex } from "./completionMetadata";

export interface CompletionDriver extends ContextDriver {
    formatIdentifier(name: string): string;
    readonly language: SqlLanguage;
}

export type SuggestionKind =
    | "keyword"
    | "constant"
    | "dataType"
    | "builtInFunction"
    | "column"
    | "alias"
    | "variable"
    | "database"
    | "schema"
    | "table"
    | "view"
    | "function"
    | "procedure"
    | "type"
    | "sequence"
    | "synonym";

export interface Suggestion {
    label: string;
    kind: SuggestionKind;
    /** Shown on the right of the label in the list (a column's type). */
    description?: string;
    /** Shown for the selected item: what the object is ("table dbo.customers"). */
    detail?: string;
    insertText: string;
    /** `insertText` is a snippet ($0 marks where the cursor goes). */
    snippet?: boolean;
    /** Text VS Code matches the typed word against, when it is not the label. */
    filterText?: string;
    sortText: string;
}

export interface CompletionResult {
    items: Suggestion[];
    /** Offsets replaced by an accepted item: the typed word, or the whole word around the cursor. */
    range: { start: number; end: number; replaceEnd: number };
    /** Some metadata was still loading, or the list was cut: VS Code should ask again as the user types. */
    incomplete: boolean;
}

export interface CompletionOptions {
    /** yast.intelliSense.lowerCaseSuggestions: keywords, types and built-in functions in lower case. */
    lowerCaseSuggestions: boolean;
    /** Longest wait for metadata, in milliseconds. */
    budgetMs: number;
    /** Above this many items, only those matching the typed word are kept (and the list is incomplete). */
    maxItems: number;
}

/** Sort groups: the lower, the higher in the list. */
const GROUP = {
    column: 0,
    scope: 1,
    variable: 2,
    defaultSchema: 3,
    otherSchema: 4,
    schema: 5,
    builtIn: 6,
    keyword: 8,
    database: 9,
} as const;

const RELATION_KINDS = new Set(["table", "view", "synonym"]);
const isRelation = (o: CompletionObject) =>
    RELATION_KINDS.has(o.kind) || (o.kind === "function" && !!o.returnsTable);

/** Relations whose columns an expression position offers without qualifier. */
const MAX_SCOPE_RELATIONS = 20;

export async function computeCompletions(
    script: string,
    offset: number,
    driver: CompletionDriver,
    metadata: CompletionMetadata | undefined,
    options: CompletionOptions,
): Promise<CompletionResult> {
    const context = analyzeCompletionContext(script, offset, driver);
    const range = {
        start: context.word.start,
        end: context.word.end,
        replaceEnd: context.word.replaceEnd,
    };
    if (context.kind === "none") return { items: [], range, incomplete: false };

    const objects = metadata ? await metadata.objects(options.budgetMs) : undefined;
    const builder = new SuggestionBuilder(context, driver, objects, options, metadata?.database);
    let incomplete = metadata !== undefined && objects === undefined;

    const needed = builder.relationsNeedingColumns();
    let columns = new Map<string, CompletionColumn[]>();
    if (metadata && needed.length) {
        const loaded = await metadata.columnsOf(needed, options.budgetMs);
        columns = loaded.columns;
        incomplete ||= !loaded.complete;
    }
    const items = builder.build(columns);
    const limited = limit(items, context, options.maxItems);
    return { items: limited, range, incomplete: incomplete || limited.length < items.length };
}

/** Keeps the best `max` items matching the typed word when there are too many. */
function limit(items: Suggestion[], context: CompletionContext, max: number): Suggestion[] {
    if (items.length <= max) return items;
    const typed = context.word.text.replace(/^[["]/, "").toLowerCase();
    const matching = typed
        ? items.filter((i) => (i.filterText ?? i.label).toLowerCase().includes(typed))
        : items;
    return matching.sort((a, b) => (a.sortText < b.sortText ? -1 : 1)).slice(0, max);
}

/** A relation in scope and the catalog object it refers to, if any. */
interface ResolvedRelation {
    relation: ScopeRelation;
    object?: CompletionObject;
}

class SuggestionBuilder {
    private readonly items: Suggestion[] = [];
    private readonly resolved: ResolvedRelation[];
    private readonly quote: string | undefined;

    constructor(
        private readonly context: CompletionContext,
        private readonly driver: CompletionDriver,
        private readonly objects: ObjectIndex | undefined,
        private readonly options: CompletionOptions,
        private readonly database: string | undefined,
    ) {
        this.quote = context.word.quote;
        this.resolved = context.relations.map((relation) => ({
            relation,
            object: this.resolveRelation(relation),
        }));
    }

    // -- what the position needs ---------------------------------------------------------------

    /** Catalog relations whose columns the position offers. */
    relationsNeedingColumns(): { schema: string; name: string }[] {
        const objects = this.columnSources()
            .map((r) => r.object)
            .filter((o) => o !== undefined);
        const unique = new Map(objects.map((o) => [relationKey(asRelation(o)), asRelation(o)]));
        return [...unique.values()];
    }

    /** Relations whose columns are offered, as resolved relations (scope or catalog). */
    private columnSources(): ResolvedRelation[] {
        const { kind, qualifiers } = this.context;
        if (kind === "targetColumn" && qualifiers.length === 0) {
            const target = this.context.target!;
            return [{ relation: target, object: this.resolveRelation(target) }];
        }
        if (kind !== "expression" && kind !== "targetColumn") return [];
        if (qualifiers.length > 0) {
            const qualified = this.qualifiedRelation(qualifiers);
            return qualified ? [qualified] : [];
        }
        return this.resolved.slice(0, MAX_SCOPE_RELATIONS);
    }

    /** The relation `a.` / `a.b.` / `a.b.c.` names: an alias or relation in scope, else one of the catalog. */
    private qualifiedRelation(qualifiers: Identifier[]): ResolvedRelation | undefined {
        const last = qualifiers[qualifiers.length - 1];
        if (qualifiers.length === 1) {
            const byAlias = this.resolved.find(
                (r) => r.relation.alias && sameName(r.relation.alias, last),
            );
            if (byAlias) return byAlias;
            const byName = this.resolved.find(
                (r) =>
                    !r.relation.alias &&
                    r.relation.parts.length > 0 &&
                    sameName(r.relation.parts[r.relation.parts.length - 1], last),
            );
            if (byName) return byName;
        }
        const inScope = this.resolved.find(
            (r) =>
                r.relation.parts.length >= qualifiers.length &&
                qualifiers.every((q, i) =>
                    sameName(q, r.relation.parts[r.relation.parts.length - qualifiers.length + i]),
                ),
        );
        if (inScope) return inScope;
        const relation: ScopeRelation = { parts: qualifiers, kind: "table", depth: 0 };
        const object = this.resolveRelation(relation);
        return object ? { relation, object } : undefined;
    }

    /** The catalog object a relation of the script refers to. */
    private resolveRelation(relation: ScopeRelation): CompletionObject | undefined {
        if (!this.objects || (relation.kind !== "table" && relation.kind !== "function"))
            return undefined;
        const parts = relation.parts.map((p) => p.name);
        if (parts.length === 3 && !this.isCurrentDatabase(parts[0])) return undefined;
        if (parts.length > 3 || parts.length === 0) return undefined;
        return this.objects.resolve(parts.slice(-2), isRelation);
    }

    /** Only the current database's objects are known: db.schema.x of another one gives nothing. */
    private isCurrentDatabase(name: string): boolean {
        return this.database?.toLowerCase() === name.toLowerCase();
    }

    // -- building ------------------------------------------------------------------------------

    build(columns: Map<string, CompletionColumn[]>): Suggestion[] {
        const { kind, qualifiers } = this.context;
        switch (kind) {
            case "keyword":
            case "afterOperand":
                this.addKeywords();
                break;
            case "relation":
                if (qualifiers.length) this.addQualifiedObjects(qualifiers, isRelation);
                else this.addRelations();
                break;
            case "procedure":
                if (qualifiers.length)
                    this.addQualifiedObjects(qualifiers, (o) => o.kind === "procedure");
                else this.addProcedures();
                break;
            case "database":
                this.addDatabases(GROUP.defaultSchema);
                break;
            case "dataType":
                if (qualifiers.length)
                    this.addQualifiedObjects(qualifiers, (o) => o.kind === "type");
                else this.addDataTypes();
                break;
            case "targetColumn":
                this.addColumns(this.columnSources(), columns, false);
                break;
            case "expression":
                if (qualifiers.length) this.addQualifiedExpression(qualifiers, columns);
                else this.addExpression(columns);
                break;
        }
        return this.items;
    }

    private addExpression(columns: Map<string, CompletionColumn[]>): void {
        if (this.context.word.text.startsWith("@")) {
            this.addVariables();
            this.addBuiltIns((name) => name.startsWith("@"));
            return;
        }
        this.addColumns(this.columnSources(), columns, true);
        this.addScopeNames();
        this.addVariables();
        this.addObjects(
            (o) => o.kind === "function" && !o.system,
            GROUP.defaultSchema,
            GROUP.otherSchema,
        );
        this.addBuiltIns(() => true);
        this.addKeywords();
    }

    private addQualifiedExpression(
        qualifiers: Identifier[],
        columns: Map<string, CompletionColumn[]>,
    ): void {
        const relation = this.qualifiedRelation(qualifiers);
        if (relation) this.addColumns([relation], columns, false);
        // schema. -> its functions and relations (for schema.table.column).
        const schema = this.schemaOf(qualifiers);
        if (schema && this.objects) {
            for (const object of this.objects.objectsOf(schema)) {
                if (object.kind === "function") this.addObject(object, GROUP.defaultSchema, false);
                else if (isRelation(object)) this.addObject(object, GROUP.otherSchema, false);
            }
        }
    }

    /** The schema `qualifiers` name: [schema] or [database, schema] of the current database. */
    private schemaOf(qualifiers: Identifier[]): string | undefined {
        if (!this.objects || qualifiers.length > 2) return undefined;
        if (qualifiers.length === 2 && !this.isCurrentDatabase(qualifiers[0].name))
            return undefined;
        return this.objects.schemaNamed(qualifiers[qualifiers.length - 1].name);
    }

    private addQualifiedObjects(
        qualifiers: Identifier[],
        accept: (o: CompletionObject) => boolean,
    ): void {
        if (!this.objects) return;
        const schema = this.schemaOf(qualifiers);
        if (schema) {
            for (const object of this.objects.objectsOf(schema)) {
                if (accept(object)) this.addObject(object, GROUP.defaultSchema, false);
            }
            return;
        }
        // database. -> its schemas (the current database only).
        if (qualifiers.length === 1 && this.isCurrentDatabase(qualifiers[0].name)) {
            this.addSchemas(GROUP.defaultSchema);
        }
    }

    private addRelations(): void {
        for (const cte of this.context.ctes) {
            this.add({
                label: cte.name.name,
                kind: "table",
                detail: "common table expression",
                insertText: this.identifier(cte.name.name),
                sortText: sortText(GROUP.scope, 0, cte.name.name),
            });
        }
        this.addObjects((o) => isRelation(o) && !o.system, GROUP.defaultSchema, GROUP.otherSchema);
        this.addSchemas(GROUP.schema);
        this.addDatabases(GROUP.database);
    }

    private addProcedures(): void {
        this.addObjects(
            (o) => o.kind === "procedure" && !o.system,
            GROUP.defaultSchema,
            GROUP.otherSchema,
        );
        // System procedures (sp_who, sp_help, xp_...) come after, without schema, as sqltoolsservice
        // inserts them: the engine finds them unqualified (SQL Server's sys, PostgreSQL's pg_catalog).
        for (const object of this.objects?.objects ?? []) {
            if (object.kind === "procedure" && object.system) {
                // After the user's procedures of every schema, before the schemas.
                this.addObject(object, GROUP.otherSchema, false, 1);
            }
        }
        this.addSchemas(GROUP.schema);
    }

    private addDataTypes(): void {
        for (const name of this.driver.language.dataTypes) {
            const text = this.keywordCase(name);
            this.add({
                label: text,
                kind: "dataType",
                detail: "data type",
                insertText: text,
                sortText: sortText(GROUP.column, 0, text),
            });
        }
        this.addObjects((o) => o.kind === "type", GROUP.scope, GROUP.otherSchema);
    }

    /** Objects of the database, unqualified in the default schemas, schema-qualified elsewhere. */
    private addObjects(
        accept: (o: CompletionObject) => boolean,
        defaultGroup: number,
        otherGroup: number,
    ): void {
        if (!this.objects) return;
        for (const object of this.objects.objects) {
            if (!accept(object)) continue;
            const rank = this.objects.defaultSchemaRank(object.schema);
            if (rank >= 0) this.addObject(object, defaultGroup, false, rank);
            else this.addObject(object, otherGroup, true);
        }
    }

    private addObject(object: CompletionObject, group: number, qualify: boolean, rank = 0): void {
        const callable = object.kind === "function";
        const quoted = this.quotedName(object.name);
        let insertText = quoted ?? this.identifier(object.name);
        if (qualify) insertText = `${this.driver.formatIdentifier(object.schema!)}.${insertText}`;
        const label = qualify ? `${object.schema}.${object.name}` : object.name;
        this.add({
            label,
            kind: object.kind,
            detail: describeObject(object),
            insertText: callable ? `${escapeSnippet(insertText)}($0)` : insertText,
            snippet: callable || undefined,
            filterText: quoted ?? (qualify ? `${object.name} ${object.schema}` : undefined),
            sortText: sortText(group, rank, label),
        });
    }

    private addSchemas(group: number): void {
        for (const schema of this.objects?.schemas ?? []) {
            const quoted = this.quotedName(schema.name);
            this.add({
                label: schema.name,
                kind: "schema",
                detail: "schema",
                insertText: quoted ?? this.identifier(schema.name),
                filterText: quoted,
                sortText: sortText(group, 0, schema.name),
            });
        }
    }

    private addDatabases(group: number): void {
        for (const database of this.objects?.databases ?? []) {
            const quoted = this.quotedName(database.name);
            this.add({
                label: database.name,
                kind: "database",
                detail: "database",
                insertText: quoted ?? this.identifier(database.name),
                filterText: quoted,
                sortText: sortText(group, 0, database.name),
            });
        }
    }

    /**
     * Columns of relations, in table order. With `qualifyAmbiguous`, a name found in several
     * relations of the cursor's query is offered once per relation, qualified with its alias.
     */
    private addColumns(
        sources: ResolvedRelation[],
        loaded: Map<string, CompletionColumn[]>,
        qualifyAmbiguous: boolean,
    ): void {
        const lists = sources.map((source) => ({
            source,
            columns: columnsOf(source, loaded),
        }));
        const counts = new Map<string, number>();
        for (const { source, columns } of lists) {
            if (source.relation.depth > 0) continue;
            for (const column of new Set(columns.map((c) => c.name.toLowerCase()))) {
                counts.set(column, (counts.get(column) ?? 0) + 1);
            }
        }
        const seen = new Set<string>();
        lists.forEach(({ source, columns }, relationIndex) => {
            const qualifier = relationQualifier(source.relation);
            columns.forEach((column, columnIndex) => {
                const ambiguous =
                    qualifyAmbiguous &&
                    qualifier !== undefined &&
                    (counts.get(column.name.toLowerCase()) ?? 0) > 1;
                const quoted = this.quotedName(column.name);
                const name = quoted ?? this.identifier(column.name);
                const label = ambiguous ? `${qualifier.name}.${column.name}` : column.name;
                if (seen.has(label.toLowerCase())) return;
                seen.add(label.toLowerCase());
                const type = column.dataType
                    ? `${column.dataType}, ${column.nullable ? "null" : "not null"}`
                    : undefined;
                this.add({
                    label,
                    kind: "column",
                    description: column.dataType || undefined,
                    detail: `column ${relationDisplay(source)}.${column.name}${type ? ` (${type})` : ""}`,
                    insertText: ambiguous
                        ? `${this.driver.formatIdentifier(qualifier.name)}.${name}`
                        : name,
                    filterText:
                        quoted ?? (ambiguous ? `${column.name} ${qualifier.name}` : undefined),
                    sortText: sortText(
                        GROUP.column,
                        source.relation.depth * 1000 + relationIndex,
                        String(columnIndex).padStart(4, "0"),
                    ),
                });
            });
        });
    }

    /** Aliases and relation names of the query, to qualify columns with. */
    private addScopeNames(): void {
        for (const { relation, object } of this.resolved) {
            const name = relation.alias ?? relation.parts[relation.parts.length - 1];
            if (!name) continue;
            this.add({
                label: name.name,
                kind: "alias",
                detail: relation.alias
                    ? `${object ? describeObject(object) : relationDisplay({ relation })} AS ${relation.alias.name}`
                    : object
                      ? describeObject(object)
                      : relationDisplay({ relation }),
                insertText: this.quotedName(name.name) ?? this.identifier(name.name),
                sortText: sortText(GROUP.scope, relation.depth, name.name),
            });
        }
    }

    private addVariables(): void {
        for (const variable of this.context.variables) {
            this.add({
                label: variable.name,
                kind: "variable",
                detail: `local variable ${variable.name}${variable.type ? ` ${variable.type}` : ""}`,
                insertText: variable.name,
                sortText: sortText(GROUP.variable, 0, variable.name),
            });
        }
    }

    private addBuiltIns(accept: (name: string) => boolean): void {
        for (const name of this.driver.language.functions) {
            if (!accept(name)) continue;
            const text = this.keywordCase(name);
            const isGlobalVariable = name.startsWith("@@");
            this.add({
                label: text,
                kind: "builtInFunction",
                detail: isGlobalVariable ? "global variable" : "built-in function",
                insertText: isGlobalVariable ? text : `${escapeSnippet(text)}($0)`,
                snippet: !isGlobalVariable || undefined,
                sortText: sortText(GROUP.builtIn, 0, text),
            });
        }
        for (const name of this.driver.language.constants) {
            if (!accept(name)) continue;
            const text = this.keywordCase(name);
            this.add({
                label: text,
                kind: "constant",
                detail: "constant",
                insertText: text,
                sortText: sortText(GROUP.builtIn, 1, text),
            });
        }
    }

    private addKeywords(): void {
        // Constants are keywords too; where they were offered as constants, once is enough.
        const offered = new Set(
            this.items.filter((i) => i.kind === "constant").map((i) => i.label),
        );
        for (const keyword of this.driver.language.keywords) {
            if (offered.has(this.keywordCase(keyword))) continue;
            const text = this.keywordCase(keyword);
            this.add({
                label: text,
                kind: "keyword",
                detail: `${keyword} keyword`,
                insertText: text,
                sortText: sortText(GROUP.keyword, 0, text),
            });
        }
    }

    // -- helpers -------------------------------------------------------------------------------

    private add(item: Suggestion): void {
        this.items.push(item);
    }

    private keywordCase(name: string): string {
        return this.options.lowerCaseSuggestions ? name.toLowerCase() : name.toUpperCase();
    }

    private identifier(name: string): string {
        return this.driver.formatIdentifier(name);
    }

    /**
     * When the user started the word with a quote ([cust or "Cust), the name quoted that way: it is
     * both what is inserted and what VS Code matches the typed text against.
     */
    private quotedName(name: string): string | undefined {
        const quote = this.quote;
        if (!quote) return undefined;
        const close = quote === "[" ? "]" : quote;
        return `${quote}${name.split(close).join(close + close)}${close}`;
    }
}

function asRelation(object: CompletionObject): { schema: string; name: string } {
    return { schema: object.schema!, name: object.name };
}

function columnsOf(
    source: ResolvedRelation,
    loaded: Map<string, CompletionColumn[]>,
): CompletionColumn[] {
    if (source.object) return loaded.get(relationKey(asRelation(source.object))) ?? [];
    // CTEs and derived tables: names only.
    return (source.relation.columns ?? []).map((name) => ({ name, dataType: "", nullable: true }));
}

/** What qualifies a relation's columns: its alias, else its name. */
function relationQualifier(relation: ScopeRelation): Identifier | undefined {
    return relation.alias ?? relation.parts[relation.parts.length - 1];
}

function relationDisplay(source: { relation: ScopeRelation; object?: CompletionObject }): string {
    if (source.object) return `${source.object.schema}.${source.object.name}`;
    const { relation } = source;
    if (relation.parts.length) return relation.parts.map((p) => p.name).join(".");
    return relation.alias?.name ?? "";
}

const OBJECT_KIND_NAMES: Record<string, string> = {
    table: "table",
    view: "view",
    synonym: "synonym",
    sequence: "sequence",
    procedure: "stored procedure",
    type: "user-defined type",
};

/** "table dbo.customers", "stored procedure dbo.p @a int", "scalar-valued function dbo.f(@a int) RETURNS int". */
export function describeObject(object: CompletionObject): string {
    let kind = OBJECT_KIND_NAMES[object.kind] ?? object.kind;
    if (object.kind === "function")
        kind = object.returnsTable ? "table-valued function" : "scalar-valued function";
    let detail = object.detail ?? "";
    if (object.kind === "view" || object.kind === "table" || object.kind === "type") {
        // "materialized view", "foreign table", "domain"...: the driver's word for it.
        if (detail) kind = detail;
        detail = "";
    }
    const name = `${object.schema}.${object.name}`;
    if (!detail) return `${kind} ${name}`;
    return detail.startsWith("(") ? `${kind} ${name}${detail}` : `${kind} ${name} ${detail}`;
}

function sortText(group: number, rank: number, label: string): string {
    return `${group}${String(rank).padStart(4, "0")}${label.toLowerCase()}`;
}

/** Text inside a snippet: $, } and \ are literal. */
function escapeSnippet(text: string): string {
    return text.replace(/[$}\\]/g, (c) => `\\${c}`);
}
