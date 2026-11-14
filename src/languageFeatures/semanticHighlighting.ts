/**
 * Syntax highlighting that follows the engine of each SQL editor's connection.
 *
 * Every SQL editor has the language id "sql" and VS Code colors it with its built-in T-SQL
 * grammar (TextMate), which is Microsoft's. Coloring per connection with one language id means
 * semantic tokens: they are drawn over the TextMate colors. An editor without a connection gets
 * none, so it keeps the TextMate colors.
 *
 * Token types: the standard ones where VS Code's default TextMate fallback gives the colors of
 * Microsoft's grammar (comment, string, number, operator, function + defaultLibrary), and types
 * of our own, declared in package.json, where it does not (keywords and types are keyword.other.sql
 * and storage.type.sql there, not keyword.control and entity.name.type). Their super types keep
 * theme rules for keyword, type and variable working. yastIdentifier has no super type: it falls
 * back to the meta.embedded scope, which the built-in themes color like plain text, so that a
 * word colored by the T-SQL grammar (TOP in a PostgreSQL editor) looks like any other name.
 */

import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import { getDriver } from "../drivers";
import type { Driver, DriverId } from "../drivers/types";
import { getUriKey } from "../utils/utils";
import { classifySql, type ClassifiedToken, type SqlTokenKind } from "./sqlClassifier";

export const tokenTypes = [
    "comment",
    "string",
    "number",
    "operator",
    "function",
    "yastKeyword",
    "yastType",
    "yastVariable",
    "yastIdentifier",
] as const;
export const tokenModifiers = ["defaultLibrary"] as const;

const DEFAULT_LIBRARY = 1 << tokenModifiers.indexOf("defaultLibrary");

/** Legend index and modifier bits of each kind of token. */
const encoding: Record<SqlTokenKind, [type: number, modifiers: number]> = {
    comment: [tokenTypes.indexOf("comment"), 0],
    string: [tokenTypes.indexOf("string"), 0],
    dollarQuote: [tokenTypes.indexOf("string"), 0],
    number: [tokenTypes.indexOf("number"), 0],
    operator: [tokenTypes.indexOf("operator"), 0],
    function: [tokenTypes.indexOf("function"), DEFAULT_LIBRARY],
    keyword: [tokenTypes.indexOf("yastKeyword"), 0],
    type: [tokenTypes.indexOf("yastType"), 0],
    variable: [tokenTypes.indexOf("yastVariable"), 0],
    identifier: [tokenTypes.indexOf("yastIdentifier"), 0],
};

/** Setting that turns the feature off. */
export const configEngineSyntaxHighlighting = "syntaxHighlighting.engineSpecific";

/** What the provider needs from EditorConnections. */
export interface EditorProviders {
    /** Engine of the editor's connection; undefined when it has none. */
    providerOf(uri: string): DriverId | undefined;
    readonly onDidChange: vscode.Event<string>;
}

interface CachedTokens {
    version: number;
    engine: DriverId;
    tokens: ClassifiedToken[];
    lineStarts: number[];
    text: string;
}

export class SqlSemanticTokensProvider
    implements
        vscode.DocumentSemanticTokensProvider,
        vscode.DocumentRangeSemanticTokensProvider,
        vscode.Disposable
{
    public static readonly legend = new vscode.SemanticTokensLegend(
        [...tokenTypes],
        [...tokenModifiers],
    );

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChangeSemanticTokens = this._onDidChange.event;
    /** Last classification of each document, for the range requests and unchanged documents. */
    private readonly _cache = new Map<string, CachedTokens>();

    constructor(
        private readonly _editors: EditorProviders,
        private readonly _isEnabled: () => boolean,
    ) {}

    /** Asks VS Code for the tokens again, e.g. when an editor connects or disconnects. */
    public refresh(): void {
        this._onDidChange.fire();
    }

    public forget(uri: string): void {
        this._cache.delete(uri);
    }

    public provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
        const cached = this.classify(document);
        return new vscode.SemanticTokens(cached ? encode(cached, 0, Infinity) : new Uint32Array(0));
    }

    public provideDocumentRangeSemanticTokens(
        document: vscode.TextDocument,
        range: vscode.Range,
    ): vscode.SemanticTokens {
        const cached = this.classify(document);
        return new vscode.SemanticTokens(
            cached ? encode(cached, range.start.line, range.end.line) : new Uint32Array(0),
        );
    }

    public dispose(): void {
        this._cache.clear();
        this._onDidChange.dispose();
    }

    private classify(document: vscode.TextDocument): CachedTokens | undefined {
        const uri = getUriKey(document.uri);
        const engine = this._isEnabled() ? this._editors.providerOf(uri) : undefined;
        if (!engine) {
            this._cache.delete(uri);
            return undefined;
        }
        const cached = this._cache.get(uri);
        if (cached && cached.version === document.version && cached.engine === engine) {
            return cached;
        }
        const text = document.getText();
        const driver: Driver = getDriver(engine);
        const fresh = {
            version: document.version,
            engine,
            tokens: classifySql(text, driver),
            lineStarts: lineStartsOf(text),
            text,
        };
        this._cache.set(uri, fresh);
        return fresh;
    }
}

/** Offsets where each line starts; lines end with \r\n, \n or \r, like in VS Code. */
export function lineStartsOf(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 13 /* \r */) {
            if (text.charCodeAt(i + 1) === 10) i++;
            starts.push(i + 1);
        } else if (c === 10 /* \n */) {
            starts.push(i + 1);
        }
    }
    return starts;
}

/**
 * Semantic tokens of the lines `firstLine`..`lastLine`, in VS Code's relative encoding. A token
 * spanning several lines (block comment, string, dollar body) is cut at each line break, which
 * the API requires.
 */
function encode(
    { tokens, lineStarts, text }: CachedTokens,
    firstLine: number,
    lastLine: number,
): Uint32Array {
    const data: number[] = [];
    let previousLine = 0;
    let previousStart = 0;
    const lineContentEnd = (line: number) => {
        const next = lineStarts[line + 1];
        if (next === undefined) return text.length;
        let end = next - 1;
        if (text.charCodeAt(end) === 10 && text.charCodeAt(end - 1) === 13) end--;
        return end;
    };
    let line = 0;
    const firstOffset = lineStarts[Math.min(firstLine, lineStarts.length - 1)];
    for (const token of tokens) {
        if (token.end <= firstOffset) continue;
        let start = token.start;
        while (line + 1 < lineStarts.length && lineStarts[line + 1] <= start) line++;
        if (line > lastLine) break;
        let current = line;
        while (start < token.end && current <= lastLine) {
            const end = Math.min(token.end, lineContentEnd(current));
            if (end > start && current >= firstLine) {
                const character = start - lineStarts[current];
                const [type, modifiers] = encoding[token.kind];
                data.push(
                    current - previousLine,
                    current === previousLine ? character - previousStart : character,
                    end - start,
                    type,
                    modifiers,
                );
                previousLine = current;
                previousStart = character;
            }
            current++;
            start = lineStarts[current] ?? token.end;
        }
    }
    return new Uint32Array(data);
}

/** Registers the provider for SQL editors and keeps it in step with their connections. */
export function registerSemanticHighlighting(
    context: vscode.ExtensionContext,
    editors: EditorProviders,
): SqlSemanticTokensProvider {
    const isEnabled = () =>
        vscode.workspace
            .getConfiguration(Constants.extensionConfigSectionName)
            .get<boolean>(configEngineSyntaxHighlighting, true);
    const provider = new SqlSemanticTokensProvider(editors, isEnabled);
    const selector = { language: Constants.languageId };
    context.subscriptions.push(
        provider,
        vscode.languages.registerDocumentSemanticTokensProvider(
            selector,
            provider,
            SqlSemanticTokensProvider.legend,
        ),
        vscode.languages.registerDocumentRangeSemanticTokensProvider(
            selector,
            provider,
            SqlSemanticTokensProvider.legend,
        ),
        editors.onDidChange(() => provider.refresh()),
        vscode.workspace.onDidChangeConfiguration((event) => {
            const section = `${Constants.extensionConfigSectionName}.${configEngineSyntaxHighlighting}`;
            if (event.affectsConfiguration(section)) provider.refresh();
        }),
        vscode.workspace.onDidCloseTextDocument((document) =>
            provider.forget(getUriKey(document.uri)),
        ),
    );
    return provider;
}
