/**
 * Commands of SQL editors: connect, change connection or database, run and cancel
 * queries, execution plans, new query from the Object Explorer. Handlers follow vscode-mssql's
 * mainController (and its SqlOutputContentProvider for the actual plan).
 */

import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import * as ConnInfo from "../models/connectionInfo";
import {
    CredentialsQuickPickItemType,
    IConnectionCredentialsQuickPickItem,
    IConnectionProfile,
} from "../models/interfaces";
import { ConnectionStore } from "../connections/connectionStore";
import { createDatabaseFilter } from "../connections/databaseFilter";
import { EditorConnections } from "./editorConnections";
import { QueryManager } from "./queryManager";
import { TreeNodeInfo } from "../objectExplorer/nodes/treeNodeInfo";
import { ObjectExplorerUtils } from "../objectExplorer/objectExplorerUtils";
import { getUriKey } from "../utils/utils";
import { getDriver } from "../drivers";

/**
 * Context key listing the connected editors whose engine has execution plans: the plan buttons
 * and commands are offered there only (`resource in yast.executionPlan.urisWithPlanSupport`).
 */
export const planSupportContextKey = "yast.executionPlan.urisWithPlanSupport";

export function registerQueryCommands(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    connections: EditorConnections,
    queries: QueryManager,
): void {
    const register = (command: string, handler: (...args: any[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(command, handler));

    /** Active SQL editor, or undefined after telling the user one is needed. */
    const sqlEditor = (): vscode.TextEditor | undefined => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== Constants.languageId) {
            vscode.window.showInformationMessage(LocalizedConstants.noActiveEditorMsg);
            return undefined;
        }
        return editor;
    };

    /** Asks for a profile and connects the editor with it. */
    const connectEditor = async (editor: vscode.TextEditor): Promise<boolean> => {
        const profile = await pickConnectionProfile(store);
        if (!profile) {
            return false;
        }
        return connections.connect(getUriKey(editor.document.uri), profile);
    };

    register(Constants.cmdConnect, async () => {
        const editor = sqlEditor();
        if (editor) {
            await connectEditor(editor);
        }
    });

    register(Constants.cmdChangeConnection, async () => {
        const editor = sqlEditor();
        if (editor) {
            await connectEditor(editor);
        }
    });

    register(Constants.cmdDisconnect, async () => {
        const editor = sqlEditor();
        if (editor) {
            await connections.disconnect(getUriKey(editor.document.uri));
        }
    });

    const changeDatabase = async () => {
        const editor = sqlEditor();
        if (!editor) {
            return;
        }
        const uri = getUriKey(editor.document.uri);
        const editorConnection = connections.get(uri);
        if (!editorConnection) {
            vscode.window.showInformationMessage(LocalizedConstants.msgChooseDatabaseNotConnected);
            return;
        }
        // The connection's database filter applies here too; the current database always stays.
        const filter = createDatabaseFilter(editorConnection.profile.databaseFilter);
        const databases = (await editorConnection.connection.listDatabases()).filter(
            (name) => !filter || filter(name) || name === editorConnection.database,
        );
        const picked = await vscode.window.showQuickPick(
            databases.map((name) => ({
                label: name,
                description: name === editorConnection.database ? "$(check)" : undefined,
            })),
            { placeHolder: LocalizedConstants.msgChooseDatabasePlaceholder },
        );
        if (picked && picked.label !== editorConnection.database) {
            await connections.changeDatabase(uri, picked.label);
        }
    };
    register(Constants.cmdChangeDatabase, changeDatabase);
    register(Constants.cmdChooseDatabase, changeDatabase);

    register(Constants.cmdRunQuery, async () => {
        const editor = sqlEditor();
        if (editor) {
            await queries.runQuery(editor, () => connectEditor(editor));
        }
    });

    register(Constants.cmdRunCurrentStatement, async () => {
        const editor = sqlEditor();
        if (editor) {
            await queries.runCurrentStatement(editor, () => connectEditor(editor));
        }
    });

    register(Constants.cmdShowEstimatedPlan, async () => {
        const editor = sqlEditor();
        if (editor) {
            await queries.showEstimatedPlan(editor, () => connectEditor(editor));
        }
    });

    register(Constants.cmdEnableActualPlan, () => {
        const editor = sqlEditor();
        if (editor) {
            queries.setActualPlanEnabled(getUriKey(editor.document.uri), true);
        }
    });

    register(Constants.cmdDisableActualPlan, () => {
        const editor = sqlEditor();
        if (editor) {
            queries.setActualPlanEnabled(getUriKey(editor.document.uri), false);
        }
    });

    register(Constants.cmdToggleActualPlan, () => {
        // Like vscode-mssql: nothing to do without an active editor.
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const uri = getUriKey(editor.document.uri);
            queries.setActualPlanEnabled(uri, !queries.isActualPlanEnabled(uri));
        }
    });

    register(Constants.cmdToggleQueryResultPanel, () => {
        // Like vscode-mssql: nothing to do when the active editor is not a SQL one.
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.languageId === Constants.languageId) {
            queries.toggleQueryResult(getUriKey(editor.document.uri));
        }
    });

    // Alt+F1 as in SSMS: the selected text names the object; with no selection, list the database's objects.
    register(Constants.cmdShowObjectInformation, async () => {
        const editor = sqlEditor();
        if (editor) {
            const name = editor.document.getText(editor.selection).trim();
            await queries.showObjectInformation(editor, name || undefined, () =>
                connectEditor(editor),
            );
        }
    });

    register(Constants.cmdCancelQuery, () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            queries.cancelQuery(getUriKey(editor.document.uri));
        }
    });

    register(Constants.cmdRevealQueryResult, () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            queries.revealQueryResult(getUriKey(editor.document.uri));
        }
    });

    /** New SQL editor, connected like the selected Object Explorer node when there is one. */
    const newQuery = async (node?: TreeNodeInfo) => {
        const doc = await vscode.workspace.openTextDocument({ language: Constants.languageId });
        const editor = await vscode.window.showTextDocument(doc);
        const profile = node instanceof TreeNodeInfo ? node.connectionProfile : undefined;
        if (profile) {
            const database = ObjectExplorerUtils.getDatabaseName(node);
            await connections.connect(
                getUriKey(editor.document.uri),
                profile,
                database && database !== LocalizedConstants.defaultDatabaseLabel
                    ? database
                    : undefined,
            );
        } else {
            await connectEditor(editor);
        }
    };
    register(Constants.cmdNewQuery, () => newQuery());
    register(Constants.cmdObjectExplorerNewQuery, (node?: TreeNodeInfo) => newQuery(node));
}

/** Keeps `planSupportContextKey` up to date as editors connect, disconnect or change connection. */
export function registerExecutionPlanContext(
    context: vscode.ExtensionContext,
    connections: EditorConnections,
): void {
    const supported = new Set<string>();
    const update = (uri: string) => {
        const editorConnection = connections.get(uri);
        const hasPlans =
            editorConnection !== undefined &&
            getDriver(editorConnection.profile.provider).executionPlan !== undefined &&
            editorConnection.connection.executeForPlan !== undefined;
        if (hasPlans === supported.has(uri)) {
            return;
        }
        if (hasPlans) {
            supported.add(uri);
        } else {
            supported.delete(uri);
        }
        void vscode.commands.executeCommand("setContext", planSupportContextKey, [...supported]);
    };
    context.subscriptions.push(connections.onDidChange(update));
}

/**
 * Quick pick of the recently used connections then the saved profiles, plus
 * "Create Connection Profile" which opens the connection dialog (vscode-mssql's
 * connectionUI.promptForConnection).
 */
async function pickConnectionProfile(
    store: ConnectionStore,
): Promise<IConnectionProfile | undefined> {
    const all = await store.readAllConnections(true);
    const seen = new Set<string>();
    const items: IConnectionCredentialsQuickPickItem[] = [];
    // Recently used first, as vscode-mssql lists them.
    for (const profile of [...all].sort((a, b) => b.profileSource - a.profileSource)) {
        const key =
            profile.id ??
            `${profile.provider}|${profile.server}|${profile.database}|${profile.user}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
            label: ConnInfo.getSimpleConnectionDisplayName(profile),
            description: ConnInfo.getPicklistDescription(profile),
            detail: ConnInfo.getPicklistDetails(profile),
            connectionCreds: profile,
            quickPickItemType: profile.profileSource,
        });
    }
    items.push({
        label: `$(add) ${LocalizedConstants.CreateProfileFromConnectionsListLabel}`,
        connectionCreds: undefined,
        quickPickItemType: CredentialsQuickPickItemType.NewConnection,
    });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: LocalizedConstants.recentConnectionsPlaceholder,
        matchOnDescription: true,
    });
    if (!picked) {
        return undefined;
    }
    if (picked.quickPickItemType === CredentialsQuickPickItemType.NewConnection) {
        await vscode.commands.executeCommand(Constants.cmdAddObjectExplorer);
        return undefined;
    }
    const profile = picked.connectionCreds as IConnectionProfile;
    // A recently used entry lacks the password and may be outdated: prefer its saved profile.
    return picked.quickPickItemType === CredentialsQuickPickItemType.Mru
        ? ((await store.findSavedProfile(profile)) ?? profile)
        : profile;
}
