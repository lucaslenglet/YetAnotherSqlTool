/**
 * Connection of each SQL editor, and the status bar items that show it.
 *
 * Like vscode-mssql, every editor owns its own session: temporary tables, SET
 * options and USE statements stay with the editor that ran them. The status bar
 * follows vscode-mssql's StatusView: connection item (click: change connection),
 * database item (click: change database) and an "Executing query..." timer.
 *
 * The color of the connection's profile, when it has one, is the text color of the
 * connection and database items (as vscode-mssql does with the group color) and a
 * bar in the gutter, at the far left of every visible editor using the connection.
 */

import * as vscode from "vscode";
import type { IServerInfo } from "vscode-mssql";
import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import * as ConnInfo from "../models/connectionInfo";
import { IConnectionProfile } from "../models/interfaces";
import type { DriverConnection } from "../drivers/types";
import { Connector } from "../connections/connector";
import { colorBarIcon, resolveConnectionColor } from "../connections/connectionColor";
import type { IConnectionConfig } from "../connectionconfig/connectionconfig";
import { getErrorMessage, getUriKey } from "../utils/utils";

export interface EditorConnection {
    profile: IConnectionProfile;
    connection: DriverConnection;
    /** Database the session currently uses. */
    database: string;
}

/** Context key listing the URIs of connected editors (`resource in yast.connections`). */
const connectionsContextKey = "yast.connections";
/** Context key listing the URIs of editors running a query (`resource in yast.runningQueries`). */
const runningQueriesContextKey = "yast.runningQueries";

export class EditorConnections implements vscode.Disposable {
    private readonly _connections = new Map<string, EditorConnection>();
    private readonly _connecting = new Set<string>();
    private readonly _running = new Set<string>();
    private readonly _statusBar = new EditorStatusBar();
    private readonly _colorBars = new ConnectionColorBars();
    /** Saved profiles, to read the current color of a connection's profile. */
    private _savedProfiles: IConnectionProfile[] = [];
    private _savedProfilesLoad = 0;
    private readonly _disposables: vscode.Disposable[] = [];

    private readonly _onDidChange = new vscode.EventEmitter<string>();
    /** Fires with the editor URI when its connection or database changes. */
    public readonly onDidChange = this._onDidChange.event;

    constructor(
        private readonly _connector: Connector,
        private readonly _connectionConfig: IConnectionConfig,
    ) {
        this._disposables.push(
            this._statusBar,
            this._colorBars,
            this._onDidChange,
            vscode.window.onDidChangeActiveTextEditor(() => this.refreshStatusBar()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refreshColorBars()),
            vscode.workspace.onDidChangeTextDocument((e) => {
                // The bar covers the lines of the document: follow lines added at its end.
                if (e.contentChanges.length > 0 && this.colorOf(e.document)) {
                    this.refreshColorBars();
                }
            }),
            vscode.workspace.onDidCloseTextDocument((doc) => void this.onDidCloseDocument(doc)),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration(
                        `${Constants.extensionName}.${Constants.connectionsArrayName}`,
                    )
                ) {
                    void this.loadSavedProfiles();
                }
            }),
        );
        this.refreshStatusBar();
        void this.loadSavedProfiles();
    }

    public get(uri: string): EditorConnection | undefined {
        return this._connections.get(uri);
    }

    public isConnected(uri: string): boolean {
        return this._connections.has(uri);
    }

    public isConnecting(uri: string): boolean {
        return this._connecting.has(uri);
    }

    /**
     * Connects an editor with a profile, replacing its current connection. When
     * `database` is given the session switches to it after connecting. Shows the
     * error and returns false when the connection fails or is canceled.
     */
    public async connect(
        uri: string,
        profile: IConnectionProfile,
        database?: string,
    ): Promise<boolean> {
        if (this._running.has(uri)) {
            vscode.window.showInformationMessage(LocalizedConstants.msgRunQueryInProgress);
            return false;
        }
        this._connecting.add(uri);
        this.refreshStatusBar();
        this._onDidChange.fire(uri);
        try {
            const profileForConnect = database ? { ...profile, database } : profile;
            const connection = await this._connector.connect(profileForConnect);
            if (!connection) {
                return false;
            }
            await this.closeConnection(uri);
            this._connections.set(uri, {
                profile: profileForConnect,
                connection,
                database: await connection.getCurrentDatabase(),
            });
            this.changed(uri);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(
                LocalizedConstants.msgConnectionError2(getErrorMessage(error)),
            );
            return false;
        } finally {
            this._connecting.delete(uri);
            this.refreshStatusBar();
            this._onDidChange.fire(uri);
        }
    }

    public async disconnect(uri: string): Promise<void> {
        await this.closeConnection(uri);
        this.changed(uri);
    }

    public async changeDatabase(uri: string, database: string): Promise<void> {
        const editorConnection = this._connections.get(uri);
        if (!editorConnection) {
            return;
        }
        try {
            await editorConnection.connection.changeDatabase(database);
            editorConnection.database = await editorConnection.connection.getCurrentDatabase();
        } catch (error) {
            vscode.window.showErrorMessage(getErrorMessage(error));
        }
        this.changed(uri);
    }

    /** The session's database may change during a query (USE, \c...): re-read it. */
    public async refreshDatabase(uri: string): Promise<void> {
        const editorConnection = this._connections.get(uri);
        if (!editorConnection) {
            return;
        }
        try {
            const database = await editorConnection.connection.getCurrentDatabase();
            if (database !== editorConnection.database) {
                editorConnection.database = database;
                this.changed(uri);
            }
        } catch {
            // The connection may be broken; the next query reports it.
        }
    }

    public setRunning(uri: string, running: boolean): void {
        if (running) {
            this._running.add(uri);
            this._statusBar.executingQuery(uri);
        } else {
            this._running.delete(uri);
            this._statusBar.executedQuery(uri);
        }
        void vscode.commands.executeCommand("setContext", runningQueriesContextKey, [
            ...this._running,
        ]);
    }

    public isRunning(uri: string): boolean {
        return this._running.has(uri);
    }

    public dispose(): void {
        for (const uri of [...this._connections.keys()]) {
            void this.closeConnection(uri);
        }
        this._disposables.forEach((d) => d.dispose());
    }

    private async onDidCloseDocument(doc: vscode.TextDocument): Promise<void> {
        const uri = getUriKey(doc.uri);
        if (this._connections.has(uri)) {
            await this.disconnect(uri);
        }
        this._statusBar.forget(uri);
    }

    private async closeConnection(uri: string): Promise<void> {
        const editorConnection = this._connections.get(uri);
        if (!editorConnection) {
            return;
        }
        this._connections.delete(uri);
        try {
            await editorConnection.connection.close();
        } catch {
            // Closing a broken connection may fail: nothing left to clean up.
        }
    }

    private changed(uri: string): void {
        void vscode.commands.executeCommand("setContext", connectionsContextKey, [
            ...this._connections.keys(),
        ]);
        this.refreshStatusBar();
        this.refreshColorBars();
        this._onDidChange.fire(uri);
    }

    /** Reads the saved profiles again (their colors may have changed) and repaints. */
    private async loadSavedProfiles(): Promise<void> {
        const load = ++this._savedProfilesLoad;
        let profiles: IConnectionProfile[];
        try {
            profiles = await this._connectionConfig.getConnections();
        } catch {
            return;
        }
        // A later load (settings changed again meanwhile) wins.
        if (load !== this._savedProfilesLoad) {
            return;
        }
        this._savedProfiles = profiles;
        this.refreshStatusBar();
        this.refreshColorBars();
    }

    /** Color of the connection of a SQL document; undefined when not connected or uncolored. */
    private colorOf(document: vscode.TextDocument): string | undefined {
        if (document.languageId !== Constants.languageId) {
            return undefined;
        }
        const connection = this._connections.get(getUriKey(document.uri));
        return connection
            ? resolveConnectionColor(connection.profile, this._savedProfiles)
            : undefined;
    }

    private refreshColorBars(): void {
        this._colorBars.update((document) => this.colorOf(document));
    }

    private refreshStatusBar(): void {
        const editor = vscode.window.activeTextEditor;
        const uri = editor ? getUriKey(editor.document.uri) : undefined;
        if (!uri || editor.document.languageId !== Constants.languageId) {
            this._statusBar.hide();
            return;
        }
        this._statusBar.show(uri, {
            connecting: this._connecting.has(uri),
            connection: this._connections.get(uri),
            running: this._running.has(uri),
            color: this.colorOf(editor.document),
        });
    }
}

/**
 * Bar of the connection's color in the gutter of the visible editors: a gutter icon on every
 * line, drawn left of the line numbers so that selections and highlights of the text never
 * cover it and it never touches the code. VS Code shows gutter icons in the glyph margin
 * only: with `editor.glyphMargin` off, there is no bar (the status bar keeps the color).
 * One decoration type per color in use.
 */
class ConnectionColorBars implements vscode.Disposable {
    private readonly _types = new Map<string, vscode.TextEditorDecorationType>();

    public update(colorOf: (document: vscode.TextDocument) => string | undefined): void {
        const editors = vscode.window.visibleTextEditors.map((editor) => ({
            editor,
            color: colorOf(editor.document),
        }));
        const used = new Set(editors.map((e) => e.color).filter((c) => c !== undefined));
        // Disposing a type removes its decorations from every editor.
        for (const [color, type] of this._types) {
            if (!used.has(color)) {
                type.dispose();
                this._types.delete(color);
            }
        }
        for (const color of used) {
            if (!this._types.has(color)) {
                this._types.set(
                    color,
                    vscode.window.createTextEditorDecorationType({
                        isWholeLine: true,
                        gutterIconPath: vscode.Uri.parse(colorBarIcon(color)),
                        // The icon fills the whole cell of each line: the bars of consecutive
                        // lines join into one.
                        gutterIconSize: "100% 100%",
                        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
                    }),
                );
            }
        }
        for (const { editor, color } of editors) {
            const lastLine = Math.max(editor.document.lineCount - 1, 0);
            for (const [typeColor, type] of this._types) {
                editor.setDecorations(
                    type,
                    typeColor === color ? [new vscode.Range(0, 0, lastLine, 0)] : [],
                );
            }
        }
    }

    public dispose(): void {
        this._types.forEach((type) => type.dispose());
        this._types.clear();
    }
}

/**
 * Status bar items of the active SQL editor. Texts and commands follow
 * vscode-mssql's StatusView.
 */
class EditorStatusBar implements vscode.Disposable {
    private readonly _connection = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
    );
    private readonly _database = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
    private readonly _query = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
    /** Start time of the running query of each editor. */
    private readonly _queryStart = new Map<string, number>();
    private _shownUri: string | undefined;
    private _timer: ReturnType<typeof setInterval> | undefined;

    public show(
        uri: string,
        state: {
            connecting: boolean;
            connection?: EditorConnection;
            running: boolean;
            color?: string;
        },
    ): void {
        this._shownUri = uri;
        const maxLength = vscode.workspace
            .getConfiguration(Constants.extensionConfigSectionName)
            .get<number>(Constants.configStatusBarConnectionInfoMaxLength, -1);

        if (state.connecting) {
            this._connection.text = `$(loading~spin) ${LocalizedConstants.StatusBar.connectingLabel}`;
            this._connection.tooltip = undefined;
            this._connection.command = undefined;
            this._connection.color = undefined;
            this._database.hide();
        } else if (state.connection) {
            const creds = { ...state.connection.profile, database: state.connection.database };
            this._connection.text = trim(
                `$(check) ${ConnInfo.generateServerDisplayName(creds)}`,
                maxLength,
            );
            this._connection.tooltip = ConnInfo.getTooltip(creds, {
                serverVersion: state.connection.connection.serverInfo.serverVersion,
            } as IServerInfo);
            this._connection.command = Constants.cmdConnect;
            this._database.text = trim(
                ConnInfo.generateDatabaseDisplayName(creds, true),
                maxLength,
            );
            this._database.tooltip = LocalizedConstants.StatusBar.changeDatabaseTooltip;
            this._database.command = Constants.cmdChangeDatabase;
            this._database.show();
            this._connection.color = state.color;
            this._database.color = state.color;
        } else {
            this._connection.text = `$(plug) ${LocalizedConstants.StatusBar.disconnectedLabel}`;
            this._connection.tooltip = LocalizedConstants.StatusBar.notConnectedTooltip;
            this._connection.command = Constants.cmdConnect;
            this._connection.color = undefined;
            this._database.hide();
        }
        this._connection.show();
        this.updateQueryItem();
    }

    public hide(): void {
        this._shownUri = undefined;
        this._connection.hide();
        this._database.hide();
        this.updateQueryItem();
    }

    public executingQuery(uri: string): void {
        this._queryStart.set(uri, Date.now());
        this.updateQueryItem();
    }

    public executedQuery(uri: string): void {
        this._queryStart.delete(uri);
        this.updateQueryItem();
    }

    public forget(uri: string): void {
        this._queryStart.delete(uri);
    }

    public dispose(): void {
        clearInterval(this._timer);
        this._connection.dispose();
        this._database.dispose();
        this._query.dispose();
    }

    private updateQueryItem(): void {
        clearInterval(this._timer);
        this._timer = undefined;
        const start = this._shownUri ? this._queryStart.get(this._shownUri) : undefined;
        const enabled = vscode.workspace
            .getConfiguration(Constants.extensionConfigSectionName)
            .get<boolean>(Constants.configStatusBarShowQueryExecutionStatus, true);
        if (start === undefined || !enabled) {
            this._query.hide();
            return;
        }
        const render = () => {
            const elapsed = Date.now() - start;
            this._query.text =
                elapsed < 1000
                    ? LocalizedConstants.executeQueryLabel
                    : `${LocalizedConstants.executeQueryLabel} ${formatTimer(elapsed)}`;
        };
        render();
        this._query.show();
        this._timer = setInterval(render, 1000);
    }
}

/** Same as StatusView.trimDisplayString: negative = no limit, 0 = empty. */
function trim(text: string, maxLength: number): string {
    if (maxLength === undefined || maxLength < 0) {
        return text;
    }
    if (maxLength === 0) {
        return "";
    }
    return text.length > maxLength ? text.slice(0, maxLength) + " …" : text;
}

/** "m:ss", like StatusView.formatMillisecondsToTimeString. */
function formatTimer(milliseconds: number): string {
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.floor((milliseconds % 60000) / 1000);
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}
