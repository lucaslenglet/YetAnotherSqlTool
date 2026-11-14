/**
 * Minimal stand-in for the `vscode` module, enough to run extension code
 * (tree nodes, Object Explorer service) under vitest. Aliased in vitest.config.mts.
 */

import { vi } from "vitest";

function format(message: string, args: unknown[]): string {
    return message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)]));
}

export const l10n = {
    t: (message: string | { message: string; args?: unknown[] }, ...args: unknown[]) =>
        typeof message === "string"
            ? format(message, args)
            : format(message.message, message.args ?? []),
};

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
}

export class TreeItem {
    id?: string;
    iconPath?: unknown;
    tooltip?: string;
    contextValue?: string;
    command?: unknown;
    constructor(
        public label: string | { label: string },
        public collapsibleState?: TreeItemCollapsibleState,
    ) {}
}

export class ThemeIcon {
    constructor(public id: string) {}
}

export class Uri {
    private constructor(public readonly path: string) {}
    static file(path: string) {
        return new Uri(path);
    }
    static parse(value: string) {
        return new Uri(value);
    }
    static joinPath(base: Uri, ...segments: string[]) {
        return new Uri([base.path, ...segments].join("/"));
    }
    toString() {
        return this.path;
    }
}

export class Position {
    constructor(
        public readonly line: number,
        public readonly character: number,
    ) {}
}

export class Range {
    public readonly start: Position;
    public readonly end: Position;
    constructor(
        startOrLine: Position | number,
        endOrCharacter: Position | number,
        endLine?: number,
        endCharacter?: number,
    ) {
        this.start =
            typeof startOrLine === "number"
                ? new Position(startOrLine, endOrCharacter as number)
                : startOrLine;
        this.end =
            typeof startOrLine === "number"
                ? new Position(endLine!, endCharacter!)
                : (endOrCharacter as Position);
    }
    get isEmpty(): boolean {
        return this.start.line === this.end.line && this.start.character === this.end.character;
    }
}

export class Selection extends Range {
    constructor(
        public readonly anchor: Position,
        public readonly active: Position,
    ) {
        super(anchor, active);
    }
}

export class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    event = (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => undefined };
    };
    fire(e: T) {
        this.listeners.forEach((l) => l(e));
    }
    dispose() {
        this.listeners = [];
    }
}

export class SemanticTokensLegend {
    constructor(
        public readonly tokenTypes: string[],
        public readonly tokenModifiers: string[] = [],
    ) {}
}

export class SemanticTokens {
    constructor(public readonly data: Uint32Array) {}
}

// Completion (values of vscode.d.ts).
export enum CompletionItemKind {
    Text = 0,
    Method = 1,
    Function = 2,
    Constructor = 3,
    Field = 4,
    Variable = 5,
    Class = 6,
    Interface = 7,
    Module = 8,
    Property = 9,
    Unit = 10,
    Value = 11,
    Enum = 12,
    Keyword = 13,
    Snippet = 14,
    Color = 15,
    File = 16,
    Reference = 17,
    Folder = 18,
    EnumMember = 19,
    Constant = 20,
    Struct = 21,
    Event = 22,
    Operator = 23,
    TypeParameter = 24,
}

export enum CompletionTriggerKind {
    Invoke = 0,
    TriggerCharacter = 1,
    TriggerForIncompleteCompletions = 2,
}

export class SnippetString {
    constructor(public value: string) {}
}

export class CompletionItem {
    detail?: string;
    insertText?: string | SnippetString;
    filterText?: string;
    sortText?: string;
    range?: unknown;
    constructor(
        public label: string | { label: string; description?: string },
        public kind?: CompletionItemKind,
    ) {}
}

export class CompletionList {
    constructor(
        public items: CompletionItem[] = [],
        public isIncomplete = false,
    ) {}
}

export const languages = {
    registerCompletionItemProvider: vi.fn(() => ({ dispose: () => undefined })),
};

export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3,
}

const outputChannel = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
};

export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
}

export enum ColorThemeKind {
    Light = 1,
    Dark = 2,
}

const noopEvent = () => ({ dispose: () => undefined });

/** Webview panel that drops every message; tests call controller reducers directly. */
function createWebviewPanel(_viewType: string, title: string) {
    return {
        title,
        webview: {
            html: "",
            cspSource: "",
            asWebviewUri: (uri: Uri) => uri,
            onDidReceiveMessage: noopEvent,
            postMessage: async () => true,
        },
        onDidDispose: noopEvent,
        onDidChangeViewState: noopEvent,
        reveal: () => undefined,
        dispose: () => undefined,
        iconPath: undefined,
    };
}

export const window = {
    createWebviewPanel: vi.fn(createWebviewPanel),
    activeColorTheme: { kind: ColorThemeKind.Dark },
    onDidChangeActiveColorTheme: noopEvent,
    showQuickPick: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showInputBox: vi.fn(async () => undefined),
    createOutputChannel: () => outputChannel,
    setStatusBarMessage: vi.fn(() => ({ dispose: () => undefined })),
    activeTextEditor: undefined as unknown,
};

export const workspace = {
    getConfiguration: () => ({
        get: <T>(_key: string, defaultValue?: T) => defaultValue,
        inspect: () => undefined,
        update: async () => undefined,
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    isTrusted: true,
    onDidGrantWorkspaceTrust: () => ({ dispose: () => undefined }),
};

export const authentication = {
    getSession: vi.fn(async () => undefined),
    getAccounts: vi.fn(async () => []),
};

export const env = {
    clipboard: { writeText: vi.fn(async () => undefined) },
};

export const commands = {
    registerCommand: () => ({ dispose: () => undefined }),
    executeCommand: vi.fn(async () => undefined),
};
