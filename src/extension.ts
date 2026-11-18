import * as path from "path";
import * as vscode from "vscode";
import * as Constants from "./constants/constants";
import { ConnectionConfig } from "./connectionconfig/connectionconfig";
import { ConnectionStore } from "./connections/connectionStore";
import { Connector } from "./connections/connector";
import { registerImportMssqlConnections } from "./connections/importMssqlConnectionsCommand";
import { Dashboards, registerDashboards } from "./dashboard/dashboardCommands";
import { registerSqlCompletion } from "./languageFeatures/completion/completionProvider";
import { registerObjectExplorer } from "./objectExplorer/objectExplorerCommands";
import { EditorConnections } from "./queries/editorConnections";
import { QueryManager } from "./queries/queryManager";
import { ResultFiles } from "./queries/resultFiles";
import { registerQueryCommands } from "./queries/queryCommands";
import { QueryResultWebviewController } from "./queryResult/queryResultWebViewController";
import { SqlCodeLensProvider } from "./queryResult/sqlCodeLensProvider";
import { ScriptingService } from "./scripting/scriptingService";
import { IconUtils } from "./utils/iconUtils";
import { registerSemanticHighlighting } from "./languageFeatures/semanticHighlighting";

/** Files of the large results of this window, deleted at deactivation. */
let resultFiles: ResultFiles | undefined;
/** Server dashboards, whose connections are closed at deactivation. */
let dashboards: Dashboards | undefined;

export function activate(context: vscode.ExtensionContext): void {
    IconUtils.initialize(context.extensionUri);
    const store = new ConnectionStore(new ConnectionConfig(), context.secrets, context.globalState);
    const connector = new Connector(store);
    // Scripting needs the editors, which are created below.
    let scripting: ScriptingService | undefined;
    const explorer = registerObjectExplorer(
        context,
        store,
        connector,
        (node, operation) => scripting!.scriptNode(node, operation),
        (node) => scripting!.scriptDatabase(node),
    );

    registerImportMssqlConnections(context, store);
    dashboards = registerDashboards(context, store, connector, (node) =>
        explorer.objectExplorerService.getSession(node),
    );

    const results = new QueryResultWebviewController(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(Constants.queryResultViewId, results, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
    // Large results go to disk under the extension's storage, not the OS temp directory (often RAM).
    resultFiles = new ResultFiles(path.join(context.globalStorageUri.fsPath, "results"));
    void resultFiles.removeStaleSessions();
    const files = resultFiles;
    const connections = new EditorConnections(connector, store.connectionConfig);
    const queries = new QueryManager(connections, results, () => files.createRowStore());
    context.subscriptions.push(
        connections,
        queries,
        vscode.window.onDidChangeActiveTextEditor((editor) =>
            results.updateResultsOnActiveEditorChange(editor),
        ),
        vscode.workspace.onDidCloseTextDocument((doc) => queries.onDidCloseTextDocument(doc)),
    );
    scripting = new ScriptingService(explorer.objectExplorerService, connections, queries);
    const codeLens = new SqlCodeLensProvider(connections, store.connectionConfig);
    context.subscriptions.push(
        codeLens,
        vscode.languages.registerCodeLensProvider({ language: Constants.languageId }, codeLens),
    );
    registerQueryCommands(context, store, connections, queries);
    registerSemanticHighlighting(context, {
        // A profile without a provider is a SQL Server one.
        providerOf: (uri) => {
            const editorConnection = connections.get(uri);
            return editorConnection ? (editorConnection.profile.provider ?? "mssql") : undefined;
        },
        onDidChange: connections.onDidChange,
    });
    registerSqlCompletion(context, connections, queries);
}

export async function deactivate(): Promise<void> {
    // VS Code disposes the subscriptions (and the stores) after this: close the files and remove
    // the session directory now, so that no result stays on disk.
    const files = resultFiles;
    resultFiles = undefined;
    const open = dashboards;
    dashboards = undefined;
    await Promise.all([files?.removeSession(), open?.closeAll()]);
}
