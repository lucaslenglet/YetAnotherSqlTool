/**
 * Autocompletion in SQL editors connected with YAST: the part of vscode-mssql's language client that
 * asks sqltoolsservice for completions (textDocument/completion), the "Refresh IntelliSense Cache"
 * command (mssql.rebuildIntelliSenseCache) and the mssql.intelliSense.* settings, ported to the
 * drivers.
 *
 * An editor that is not connected with YAST gets nothing from this provider, so another SQL
 * extension can serve it.
 */

import * as vscode from "vscode";
import * as Constants from "../../constants/constants";
import * as LocalizedConstants from "../../constants/locConstants";
import { getDriver } from "../../drivers";
import type { EditorConnections } from "../../queries/editorConnections";
import type { QueryManager } from "../../queries/queryManager";
import { getUriKey } from "../../utils/utils";
import { computeCompletions, type Suggestion, type SuggestionKind } from "./completionItems";
import { CompletionMetadataCache } from "./completionMetadata";
import { changesSchema } from "./schemaChanges";
import { loadsCompletionMetadata, SETTING_ENABLE } from "./completionSettings";

/** Settings ported from mssql.intelliSense.* (package.json). */
const SETTING_SUGGESTIONS = "intelliSense.enableSuggestions";
const SETTING_LOWER_CASE = "intelliSense.lowerCaseSuggestions";

/** sqltoolsservice's trigger characters, but "\" (nothing in T-SQL or PostgreSQL starts with it). */
export const TRIGGER_CHARACTERS = [".", ":", "[", '"'];

/** Longest wait for metadata in one request; past it, the list is marked incomplete. */
const METADATA_BUDGET_MS = 500;
/** Beyond this, only the items matching the typed word are returned (huge databases). */
const MAX_ITEMS = 3000;

const ITEM_KINDS: Record<SuggestionKind, vscode.CompletionItemKind> = {
    keyword: vscode.CompletionItemKind.Keyword,
    constant: vscode.CompletionItemKind.Keyword,
    dataType: vscode.CompletionItemKind.TypeParameter,
    type: vscode.CompletionItemKind.TypeParameter,
    builtInFunction: vscode.CompletionItemKind.Value,
    function: vscode.CompletionItemKind.Value,
    column: vscode.CompletionItemKind.Field,
    alias: vscode.CompletionItemKind.Unit,
    variable: vscode.CompletionItemKind.Unit,
    procedure: vscode.CompletionItemKind.Unit,
    synonym: vscode.CompletionItemKind.Unit,
    sequence: vscode.CompletionItemKind.Unit,
    database: vscode.CompletionItemKind.Method,
    schema: vscode.CompletionItemKind.Module,
    table: vscode.CompletionItemKind.File,
    view: vscode.CompletionItemKind.File,
};

function setting(name: string, defaultValue: boolean): boolean {
    return vscode.workspace
        .getConfiguration(Constants.extensionConfigSectionName)
        .get<boolean>(name, defaultValue);
}

/** Editors connected to the same server share invalidations. */
function serverKey(profile: { provider?: string; server?: string; port?: unknown }): string {
    return `${profile.provider ?? "mssql"}|${profile.server ?? ""}|${profile.port ?? ""}`;
}

const isEnabled = () => setting(SETTING_ENABLE, true) && setting(SETTING_SUGGESTIONS, true);

export class SqlCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
    readonly cache: CompletionMetadataCache;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly connections: EditorConnections,
        queries: QueryManager,
    ) {
        this.cache = new CompletionMetadataCache((uri) => {
            const editor = connections.get(uri);
            if (!editor) return undefined;
            return {
                connection: editor.connection,
                database: editor.database,
                serverKey: serverKey(editor.profile),
            };
        });
        this.disposables.push(
            // Like sqltoolsservice, metadata loads as soon as an editor connects.
            connections.onDidChange((uri) => {
                if (loadsCompletionMetadata()) this.cache.connectionChanged(uri);
                else this.cache.forget(uri);
            }),
            queries.onDidRunText(({ uri, text }) => this.onDidRunText(uri, text)),
        );
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext,
    ): Promise<vscode.CompletionList | undefined> {
        if (!isEnabled()) return undefined;
        const uri = getUriKey(document.uri);
        const editor = this.connections.get(uri);
        if (!editor) return undefined;
        const driver = getDriver(editor.profile.provider);
        const text = document.getText();
        const offset = document.offsetAt(position);
        if (context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter) {
            // ":" only matters as "::", and an opening quote only where the engine quotes names.
            if (context.triggerCharacter === ":" && !text.slice(0, offset).endsWith("::"))
                return undefined;
        }
        const result = await computeCompletions(text, offset, driver, this.cache.get(uri), {
            lowerCaseSuggestions: setting(SETTING_LOWER_CASE, false),
            budgetMs: METADATA_BUDGET_MS,
            maxItems: MAX_ITEMS,
        });
        if (token.isCancellationRequested) return undefined;
        const quoteTrigger = context.triggerCharacter === "[" || context.triggerCharacter === '"';
        if (
            context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter &&
            quoteTrigger &&
            text.slice(result.range.start, result.range.end) !== context.triggerCharacter
        ) {
            return undefined;
        }
        const range = {
            inserting: new vscode.Range(document.positionAt(result.range.start), position),
            replacing: new vscode.Range(
                document.positionAt(result.range.start),
                document.positionAt(result.range.replaceEnd),
            ),
        };
        return new vscode.CompletionList(
            result.items.map((item) => toCompletionItem(item, range)),
            result.incomplete,
        );
    }

    /** "Refresh IntelliSense Cache": reloads the active editor's metadata. */
    async refreshCache(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== Constants.languageId) {
            void vscode.window.showWarningMessage(LocalizedConstants.msgOpenSqlFile);
            return;
        }
        const metadata = this.cache.refresh(getUriKey(editor.document.uri));
        if (metadata) {
            vscode.window.setStatusBarMessage(
                LocalizedConstants.updatingIntelliSenseLabel,
                metadata.whenLoaded(),
            );
            await metadata.whenLoaded();
        }
    }

    private onDidRunText(uri: string, text: string): void {
        const editor = this.connections.get(uri);
        if (!editor) return;
        const driver = getDriver(editor.profile.provider);
        if (!changesSchema(text, driver.tokenize(text))) return;
        // Every editor on this database reloads, this one included.
        this.cache.invalidateDatabase(serverKey(editor.profile), editor.database);
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.cache.dispose();
    }
}

function toCompletionItem(
    suggestion: Suggestion,
    range: { inserting: vscode.Range; replacing: vscode.Range },
): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
        suggestion.description
            ? { label: suggestion.label, description: suggestion.description }
            : suggestion.label,
        ITEM_KINDS[suggestion.kind],
    );
    item.detail = suggestion.detail;
    item.insertText = suggestion.snippet
        ? new vscode.SnippetString(suggestion.insertText)
        : suggestion.insertText;
    item.filterText = suggestion.filterText;
    item.sortText = suggestion.sortText;
    item.range = range;
    return item;
}

export function registerSqlCompletion(
    context: vscode.ExtensionContext,
    connections: EditorConnections,
    queries: QueryManager,
): SqlCompletionProvider {
    const provider = new SqlCompletionProvider(connections, queries);
    context.subscriptions.push(
        provider,
        vscode.languages.registerCompletionItemProvider(
            { language: Constants.languageId },
            provider,
            ...TRIGGER_CHARACTERS,
        ),
        vscode.commands.registerCommand(Constants.cmdRebuildIntelliSenseCache, () =>
            provider.refreshCache(),
        ),
    );
    return provider;
}
