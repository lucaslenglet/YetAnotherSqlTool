/**
 * "Script as" for Object Explorer nodes. Follows vscode-mssql's ScriptingService.scriptNode:
 * generate the script, open it in a new SQL editor connected like the node and, for Select,
 * run it. sqltoolsservice's scripting request is replaced by DriverConnection.scriptObject.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import type { ScriptOperation } from "../drivers/types";
import { ObjectExplorerService } from "../objectExplorer/objectExplorerService";
import { TreeNodeInfo } from "../objectExplorer/nodes/treeNodeInfo";
import { ObjectExplorerUtils } from "../objectExplorer/objectExplorerUtils";
import { EditorConnections } from "../queries/editorConnections";
import { QueryManager } from "../queries/queryManager";
import { logger } from "../models/logger";
import { getErrorMessage, getUriKey } from "../utils/utils";

/**
 * Largest database script opened in an editor (in UTF-16 code units, about bytes): VS Code becomes
 * slow well before its own limits. Larger ones must be saved to a file.
 */
export const MAX_EDITOR_SCRIPT_LENGTH = 50 * 1024 * 1024;

class ScriptTooLargeError extends Error {}

const isAbortError = (error: unknown) => (error as Error | undefined)?.name === "AbortError";

export class ScriptingService {
    private readonly _logger = logger.withPrefix("ScriptingService");

    constructor(
        private readonly _objectExplorer: ObjectExplorerService,
        private readonly _connections: EditorConnections,
        private readonly _queries: QueryManager,
    ) {}

    /** Scripts a node into a new editor. Failures are reported to the user or logged, never thrown. */
    public async scriptNode(node: TreeNodeInfo, operation: ScriptOperation): Promise<void> {
        try {
            const profile = node.connectionProfile;
            const session = this._objectExplorer.getSession(node);
            if (!profile || !session) {
                throw new Error(LocalizedConstants.msgScriptingFailed);
            }
            if (!node.metadata || !node.objectNode) {
                throw new Error(
                    LocalizedConstants.msgScriptingObjectNotFound(
                        node.nodeType,
                        node.label as string,
                    ),
                );
            }

            const objectNode = node.objectNode;
            const generatedScript = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: LocalizedConstants.ObjectExplorer.GeneratingScript,
                },
                async () => {
                    try {
                        return await session.scriptObject(objectNode, operation);
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            LocalizedConstants.msgScriptingOperationFailed(getErrorMessage(error)),
                        );
                        throw error;
                    }
                },
            );
            if (!generatedScript) {
                throw new Error(LocalizedConstants.msgScriptingFailed);
            }

            const doc = await vscode.workspace.openTextDocument({
                language: Constants.languageId,
                content: generatedScript,
            });
            const editor = await vscode.window.showTextDocument(doc);
            if (!editor) {
                throw new Error(LocalizedConstants.msgScriptingEditorFailed);
            }
            const database = ObjectExplorerUtils.getDatabaseName(node);
            await this._connections.connect(
                getUriKey(editor.document.uri),
                profile,
                database && database !== LocalizedConstants.defaultDatabaseLabel
                    ? database
                    : undefined,
            );

            if (operation === "select" && this.shouldAutoExecuteScript()) {
                // If the connection above failed the user was told; do not ask for another one.
                await this._queries.runQuery(editor, async () => false);
            }
        } catch (error) {
            this._logger.error("Scripting failed: ", getErrorMessage(error));
        }
    }

    /**
     * "Generate Scripts..." on a database node (SSMS's wizard; vscode-mssql has none): what to
     * script, then where, then a cancellable progress notification while the driver writes it.
     * Failures are reported to the user or logged, never thrown.
     */
    public async scriptDatabase(node: TreeNodeInfo): Promise<void> {
        const texts = LocalizedConstants.GenerateScripts;
        try {
            const profile = node.connectionProfile;
            const session = this._objectExplorer.getSession(node);
            const database = ObjectExplorerUtils.getDatabaseName(node);
            if (!profile || !session || !database) {
                throw new Error(LocalizedConstants.msgScriptingFailed);
            }

            const content = await vscode.window.showQuickPick(
                [
                    { label: texts.schemaOnly, options: { schema: true, data: false } },
                    { label: texts.schemaAndData, options: { schema: true, data: true } },
                    { label: texts.dataOnly, options: { schema: false, data: true } },
                ],
                { title: texts.title, placeHolder: texts.whatToScript },
            );
            if (!content) return;
            const destination = await vscode.window.showQuickPick(
                [
                    { label: texts.toEditor, toFile: false },
                    { label: texts.toFile, toFile: true },
                ],
                { title: texts.title, placeHolder: texts.whereToScript },
            );
            if (!destination) return;

            let file: vscode.Uri | undefined;
            if (destination.toFile) {
                file = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(path.join(os.homedir(), `${database}.sql`)),
                    filters: { [texts.sqlFiles]: ["sql"] },
                    title: texts.title,
                });
                if (!file) return;
            }

            const script = (write: (text: string) => Promise<void> | void) =>
                vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: texts.generating(database),
                        cancellable: true,
                    },
                    async (progress, token) => {
                        const controller = new AbortController();
                        token.onCancellationRequested(() => controller.abort());
                        await session.scriptDatabase(
                            database,
                            content.options,
                            write,
                            controller.signal,
                            (message) => progress.report({ message }),
                        );
                    },
                );

            if (file) {
                await this.scriptToFile(file, script);
                const open = await vscode.window.showInformationMessage(
                    texts.saved(file.fsPath),
                    texts.open,
                );
                if (open === texts.open) {
                    await vscode.window.showTextDocument(
                        await vscode.workspace.openTextDocument(file),
                    );
                }
                return;
            }

            const chunks: string[] = [];
            let size = 0;
            await script((text) => {
                size += text.length;
                if (size > MAX_EDITOR_SCRIPT_LENGTH) throw new ScriptTooLargeError();
                chunks.push(text);
            });
            const doc = await vscode.workspace.openTextDocument({
                language: Constants.languageId,
                content: chunks.join(""),
            });
            const editor = await vscode.window.showTextDocument(doc);
            await this._connections.connect(getUriKey(editor.document.uri), profile, database);
        } catch (error) {
            if (isAbortError(error)) return;
            if (error instanceof ScriptTooLargeError) {
                vscode.window.showErrorMessage(
                    texts.tooLargeForEditor(MAX_EDITOR_SCRIPT_LENGTH / 1024 / 1024),
                );
                return;
            }
            vscode.window.showErrorMessage(
                LocalizedConstants.msgScriptingOperationFailed(getErrorMessage(error)),
            );
            this._logger.error("Scripting the database failed: ", getErrorMessage(error));
        }
    }

    /** Streams the script into a file, waiting for the disk; a failed or canceled file is deleted. */
    private async scriptToFile(
        file: vscode.Uri,
        script: (write: (text: string) => Promise<void>) => Thenable<void>,
    ): Promise<void> {
        const stream = fs.createWriteStream(file.fsPath, { encoding: "utf8" });
        let streamError: Error | undefined;
        stream.on("error", (error) => (streamError = error));
        try {
            await script(async (text) => {
                if (streamError) throw streamError;
                if (!stream.write(text)) {
                    await new Promise<void>((resolve, reject) => {
                        stream.once("drain", resolve);
                        stream.once("error", reject);
                    });
                }
            });
            await new Promise<void>((resolve, reject) => {
                stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
            });
            if (streamError) throw streamError;
        } catch (error) {
            // Wait for the stream to be closed: a file still being opened would be created
            // after its removal.
            await new Promise<void>((resolve) => {
                if (stream.closed) return resolve();
                stream.once("close", () => resolve());
                stream.destroy();
            });
            await fs.promises.rm(file.fsPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    private shouldAutoExecuteScript(): boolean {
        return !vscode.workspace
            .getConfiguration()
            .get<boolean>(Constants.configPreventAutoExecuteScript);
    }
}
