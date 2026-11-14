/**
 * Copy as CSV/JSON/IN/INSERT and save as CSV/JSON/Excel/INSERT, from the results grid.
 *
 * Follows vscode-mssql's QueryRunner.copyResultsAs* and ResultsSerializer (settings,
 * save dialog, notifications, opening the saved file); the text and bytes come from
 * the formatters of this folder instead of sqltoolsservice. Rows are read from the result
 * store chunk by chunk: a save streams them to the file, a copy builds its text up to
 * MAX_COPY_CHARACTERS.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as Constants from "../../constants/constants";
import * as LocalizedConstants from "../../constants/locConstants";
import { ISlickRange } from "../../sharedInterfaces/queryResult";
import { getEditorEOL, getErrorMessage } from "../../utils/utils";
import {
    CopyTooLargeError,
    MAX_COPY_CHARACTERS,
    OperationCanceledError,
    type QueryRunner,
} from "../../queries/queryRunner";
import { getInMemoryGridDataProcessingThreshold } from "../utils";
import { csvWriter } from "./csv";
import { writeExcel } from "./excel";
import { jsonWriter } from "./json";
import { inClauseWriter, insertWriter } from "./sql";
import type { CsvOptions, ExcelOptions, ExportSource, TextFormatWriter } from "./types";

export type CopyFormat = "csv" | "json" | "in-clause" | "insert-into";
export type SaveFormat = "csv" | "json" | "excel" | "insert";

/** Table name of INSERT exports, as in sqltoolsservice. */
const INSERT_TABLE_NAME = "TableName";

interface CsvSettings {
    includeHeaders?: boolean;
    delimiter?: string;
    lineSeparator?: string;
    textIdentifier?: string;
    encoding?: string;
}

interface ExcelSettings {
    includeHeaders?: boolean | null;
    freezeHeaderRow?: boolean;
    boldHeaderRow?: boolean;
    autoFilterHeaderRow?: boolean;
    autoSizeColumns?: boolean;
}

/**
 * Runs a copy. Like vscode-mssql, a copy of more rows than the in-memory threshold shows a
 * cancellable progress notification. A copy too large for the clipboard is refused with a
 * pointer to Save as.
 */
export async function runCopyOperation(
    totalRows: number,
    operation: (isCanceled: () => boolean) => Promise<void>,
): Promise<void> {
    try {
        if (totalRows > getInMemoryGridDataProcessingThreshold()) {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: LocalizedConstants.copyingResults,
                    cancellable: true,
                },
                (_progress, token) => operation(() => token.isCancellationRequested),
            );
        } else {
            await operation(() => false);
        }
    } catch (error) {
        if (error instanceof OperationCanceledError) {
            void vscode.window.showInformationMessage(LocalizedConstants.copyingResultsCanceled);
        } else if (error instanceof CopyTooLargeError) {
            void vscode.window.showWarningMessage(error.message);
        } else {
            void vscode.window.showErrorMessage(
                LocalizedConstants.QueryResult.copyError(getErrorMessage(error)),
            );
        }
    }
}

/** Copies the selection to the clipboard in the given format. */
export async function copyResultsAs(
    runner: QueryRunner,
    format: CopyFormat,
    batchId: number,
    resultId: number,
    selection: ISlickRange[],
): Promise<void> {
    await runCopyOperation(
        runner.getSelectedRowCount(batchId, resultId, selection),
        async (isCanceled) => {
            const source = runner.getExportSource(batchId, resultId, selection, { isCanceled });
            if (!source || source.rowCount === 0) {
                return;
            }
            const eol = getEditorEOL();
            let writer: TextFormatWriter;
            switch (format) {
                case "csv":
                    writer = csvWriter(source.columns, getCsvOptions(runner.uri, eol));
                    break;
                case "json":
                    writer = jsonWriter(source.columns, { lineSeparator: eol });
                    break;
                case "in-clause":
                    // The grid shows "Copied" anyway: say clearly why nothing was copied.
                    if (source.columns.length !== 1) {
                        void vscode.window.showWarningMessage(
                            LocalizedConstants.QueryResult.copyAsInClauseRequiresSingleColumn,
                        );
                        return;
                    }
                    writer = inClauseWriter(source.columns, {
                        dialect: runner.dialect,
                        lineSeparator: eol,
                    });
                    break;
                case "insert-into":
                    writer = insertWriter(source.columns, {
                        dialect: runner.dialect,
                        tableName: INSERT_TABLE_NAME,
                        includeHeaders: true,
                        lineSeparator: eol,
                    });
                    break;
            }
            await vscode.env.clipboard.writeText(await buildText(source, writer));
        },
    );
}

/** The whole text of a source, refused beyond `maxLength` characters. */
export async function buildText(
    source: ExportSource,
    writer: TextFormatWriter,
    maxLength: number = MAX_COPY_CHARACTERS,
): Promise<string> {
    const parts: string[] = [];
    let length = 0;
    const add = (text: string) => {
        length += text.length;
        if (length > maxLength) {
            throw new CopyTooLargeError(maxLength);
        }
        parts.push(text);
    };
    add(writer.start());
    for await (const chunk of source.chunks()) {
        add(writer.rows(chunk));
    }
    add(writer.end());
    return parts.join("");
}

/**
 * Writes a source to a file in the given format, streaming: memory holds one chunk of rows,
 * and each piece waits for the disk. A file left half written by an error is deleted.
 */
export async function writeResultsFile(
    filePath: string,
    source: ExportSource,
    format: SaveFormat,
    options: {
        dialect: QueryRunner["dialect"];
        csv: CsvOptions;
        encoding?: string;
        includeHeaders: boolean;
        excel: ExcelOptions;
        eol: string;
    },
): Promise<void> {
    const handle = await fs.promises.open(filePath, "w");
    try {
        const write = async (data: Uint8Array) => {
            await handle.write(data);
        };
        if (format === "excel") {
            await writeExcel(source, options.excel, write);
        } else {
            let writer: TextFormatWriter;
            let encoding: string | undefined;
            switch (format) {
                case "csv":
                    writer = csvWriter(source.columns, options.csv);
                    encoding = options.encoding;
                    break;
                case "json":
                    writer = jsonWriter(source.columns, { lineSeparator: options.eol });
                    break;
                case "insert":
                    writer = insertWriter(source.columns, {
                        dialect: options.dialect,
                        tableName: INSERT_TABLE_NAME,
                        includeHeaders: options.includeHeaders,
                        lineSeparator: options.eol,
                    });
                    break;
            }
            const writeText = async (text: string) => {
                if (text) {
                    await write(encode(text, encoding));
                }
            };
            await writeText(writer.start());
            for await (const chunk of source.chunks()) {
                await writeText(writer.rows(chunk));
            }
            await writeText(writer.end());
        }
        await handle.close();
    } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
        throw error;
    }
}

/**
 * Asks for a file and saves a result set to it: the selection when it covers more
 * than one cell (its first range, as vscode-mssql does), else every row.
 */
export async function saveResultsAs(
    runner: QueryRunner,
    format: SaveFormat,
    batchId: number,
    resultId: number,
    selection: ISlickRange[] | undefined,
): Promise<void> {
    const resultSet = runner.getResultSet(batchId, resultId);
    if (!resultSet) {
        return;
    }
    // A result set still loading would be saved partially.
    if (runner.isExecuting && !resultSet.summary.complete) {
        void vscode.window.showWarningMessage(LocalizedConstants.msgSaveResultsWhileLoading);
        return;
    }
    const filePath = await promptForFilePath(runner.uri, format);
    if (!filePath) {
        return;
    }
    try {
        const range = selection?.[0];
        const isRange =
            range && !(range.fromCell === range.toCell && range.fromRow === range.toRow);
        const source = runner.getExportSource(batchId, resultId, isRange ? [range] : undefined)!;
        const csvSettings = getCsvSettings(runner.uri);
        await writeResultsFile(filePath, source, format, {
            dialect: runner.dialect,
            csv: getCsvOptions(runner.uri, os.EOL),
            encoding: csvSettings.encoding,
            includeHeaders: csvSettings.includeHeaders ?? true,
            excel: getExcelOptions(runner.uri),
            eol: os.EOL,
        });
    } catch (error) {
        vscode.window.showErrorMessage(LocalizedConstants.msgSaveFailed(getErrorMessage(error)));
        return;
    }
    showSaveSucceededNotification(filePath, format);
    const openAfterSave = getConfig(runner.uri).get<boolean>(
        Constants.configResultsOpenAfterSave,
        true,
    );
    if (openAfterSave) {
        await openSavedFile(filePath, format);
    }
}

async function promptForFilePath(uri: string, format: SaveFormat): Promise<string | undefined> {
    const documentUri = vscode.Uri.parse(uri);
    // Next to the script, as vscode-mssql does; VS Code picks the folder for untitled editors.
    const defaultUri =
        documentUri.scheme === "untitled"
            ? undefined
            : vscode.Uri.file(path.dirname(documentUri.fsPath));
    const filters: Record<string, string[]> = {
        csv: { [LocalizedConstants.fileTypeCSVLabel]: ["csv"] },
        json: { [LocalizedConstants.fileTypeJSONLabel]: ["json"] },
        excel: { [LocalizedConstants.fileTypeExcelLabel]: ["xlsx"] },
        insert: { "SQL Files": ["sql"] },
    }[format];
    const target = await vscode.window.showSaveDialog({ defaultUri, filters });
    if (!target) {
        return undefined;
    }
    return target.scheme === "file" ? target.fsPath : target.path;
}

function showSaveSucceededNotification(filePath: string, format: SaveFormat): void {
    const openFileAction = LocalizedConstants.Common.openFile;
    const revealFileAction =
        process.platform === "darwin"
            ? LocalizedConstants.Common.revealInFinder
            : process.platform === "win32"
              ? LocalizedConstants.Common.revealInExplorer
              : LocalizedConstants.Common.openContainingFolder;
    void vscode.window
        .showInformationMessage(
            LocalizedConstants.msgSaveSucceeded(filePath),
            openFileAction,
            revealFileAction,
        )
        .then((action) => {
            if (action === openFileAction) {
                void openSavedFile(filePath, format);
            } else if (action === revealFileAction) {
                void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath));
            }
        });
}

/** Text files open in VS Code; Excel files with the application the system associates with them. */
async function openSavedFile(filePath: string, format: SaveFormat): Promise<void> {
    try {
        if (format === "excel") {
            await vscode.env.openExternal(vscode.Uri.file(filePath));
            return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: false,
            preview: false,
        });
    } catch (error) {
        vscode.window.showErrorMessage(getErrorMessage(error));
    }
}

function getConfig(uri: string): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(
        Constants.extensionConfigSectionName,
        vscode.Uri.parse(uri),
    );
}

function getCsvSettings(uri: string): CsvSettings {
    return getConfig(uri).get<CsvSettings>(Constants.configSaveAsCsv) ?? {};
}

function getCsvOptions(uri: string, defaultLineSeparator: string): CsvOptions {
    const settings = getCsvSettings(uri);
    return {
        includeHeaders: settings.includeHeaders ?? true,
        delimiter: settings.delimiter || ",",
        lineSeparator: settings.lineSeparator || defaultLineSeparator,
        textIdentifier: settings.textIdentifier || '"',
    };
}

function getExcelOptions(uri: string): ExcelOptions {
    const settings = getConfig(uri).get<ExcelSettings>(Constants.configSaveAsExcel) ?? {};
    return {
        // Unset: follows the CSV setting, as vscode-mssql does.
        includeHeaders:
            typeof settings.includeHeaders === "boolean"
                ? settings.includeHeaders
                : (getCsvSettings(uri).includeHeaders ?? true),
        freezeHeaderRow: settings.freezeHeaderRow ?? false,
        boldHeaderRow: settings.boldHeaderRow ?? false,
        autoFilterHeaderRow: settings.autoFilterHeaderRow ?? false,
        autoSizeColumns: settings.autoSizeColumns ?? false,
    };
}

/** Encodes text for a file: the encodings vscode-mssql offers for CSV, UTF-8 otherwise. No BOM, like sqltoolsservice. */
export function encode(text: string, encoding: string = "utf-8"): Uint8Array {
    switch (encoding.toLowerCase()) {
        case "utf-16le":
            return Buffer.from(text, "utf16le");
        case "utf-16be":
            return Buffer.from(text, "utf16le").swap16();
        case "ascii":
            return Buffer.from(text, "ascii");
        case "latin1":
        case "iso-8859-1":
            return Buffer.from(text, "latin1");
        default:
            return Buffer.from(text, "utf8");
    }
}
