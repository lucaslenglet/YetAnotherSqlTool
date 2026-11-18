/**
 * Runs queries for SQL editors and feeds their results to the results webview.
 *
 * Follows vscode-mssql's SqlOutputContentProvider: one QueryRunner per editor,
 * whose events update that editor's QueryResultWebviewState. Frequent updates
 * (rows arriving, messages) are throttled so the webview is not flooded. Execution plans
 * reported by the driver are converted (ExecutionPlanService) for the Query Plan tab, and the
 * actual plan is turned on per editor, as there.
 */

import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import * as LocalizedConstants from "../constants/locConstants";
import * as qr from "../sharedInterfaces/queryResult";
import { getDriver } from "../drivers";
import type {
    Driver,
    DriverConnection,
    ExecutionPlanKind,
    ExecutionPlanSupport,
} from "../drivers/types";
import {
    ExecutionPlanEvent,
    OperationCanceledError,
    QueryRunner,
    formatClock,
} from "./queryRunner";
import { createRowStore, type RowStore } from "./rowStore";
import { EditorConnections } from "./editorConnections";
import { QueryResultWebviewController } from "../queryResult/queryResultWebViewController";
import { buildSelectionSummaryStatusBarStrings } from "../queryResult/selectionSummaryFormatter";
import { countResultSets, getInMemoryGridDataProcessingThreshold } from "../queryResult/utils";
import store from "../queryResult/singletonStore";
import { getEditorEOL, getErrorMessage, getUriKey } from "../utils/utils";
import { ApiStatus } from "../sharedInterfaces/webview";
import { ExecutionPlanService } from "../services/executionPlanService";
import { getPlanGraphFileType } from "../controllers/sharedExecutionPlanUtils";
import {
    copyResultsAs,
    runCopyOperation,
    saveResultsAs,
    type CopyFormat,
    type SaveFormat,
} from "../queryResult/export/resultExporter";

/** What the copy-as requests of the webview have in common. */
type CopyAsParams = Pick<qr.CopyAsCsvRequest, "uri" | "batchId" | "resultId" | "selection">;

/** Delay between two webview updates while a query streams (vscode-mssql uses 100 ms). */
const STATE_UPDATE_DELAY_MS = 100;

/** Context key listing the editors whose actual plan is on (vscode-mssql's, under our prefix). */
export const actualPlanContextKey = "yast.executionPlan.urisWithActualPlanEnabled";

/**
 * Which plan a run asks for: "estimated" (Show Estimated Plan), "editor" (the actual plan when
 * it is on for the editor: Run Query, Execute Current Statement) or "none".
 */
type RunPlan = "estimated" | "editor" | "none";

/**
 * Picks the tab to show when a run completes (vscode-mssql's getCompletedRunTab). Failed runs
 * show Messages. Estimated plan runs show the Query Plan tab. Every other run, including one that
 * captures actual plans, shows Results when it returned any result sets, matching SSMS.
 */
function getCompletedRunTab(
    state: qr.QueryResultWebviewState,
    isEstimatedPlan: boolean,
    hasError: boolean,
): qr.QueryResultPaneTabs {
    if (hasError) {
        return qr.QueryResultPaneTabs.Messages;
    }
    if (isEstimatedPlan) {
        return state.isExecutionPlan
            ? qr.QueryResultPaneTabs.ExecutionPlan
            : qr.QueryResultPaneTabs.Messages;
    }
    return countResultSets(state.resultSetSummaries) > 0
        ? qr.QueryResultPaneTabs.Results
        : qr.QueryResultPaneTabs.Messages;
}

/** The selection summary being computed for an editor; a newer selection supersedes it. */
interface SummaryRequest {
    superseded: boolean;
    /** What a click on the summary in the footer does now (load, or cancel the loading). */
    onClick?: () => void;
}

export class QueryManager implements vscode.Disposable {
    private readonly _runners = new Map<
        string,
        { runner: QueryRunner; listeners: vscode.Disposable[] }
    >();
    private readonly _pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly _onDidRunText = new vscode.EventEmitter<{ uri: string; text: string }>();
    /** Fires after an editor ran text (finished, failed or canceled); autocompletion watches for DDL. */
    public readonly onDidRunText = this._onDidRunText.event;
    private readonly _summaryRequests = new Map<string, SummaryRequest>();
    /** Editors whose runs capture the actual plan (vscode-mssql's _actualPlanStatuses). */
    private readonly _actualPlanUris = new Set<string>();
    /** Whether the current run of an editor reported an error (vscode-mssql's batch.hasError). */
    private readonly _runHasError = new Map<string, boolean>();

    /** `newRowStore` gives each result set its store (by default in memory only). */
    constructor(
        private readonly _connections: EditorConnections,
        private readonly _results: QueryResultWebviewController,
        private readonly newRowStore: () => RowStore = () => createRowStore(),
    ) {
        _results.queryManager = this;
    }

    public isRunning(uri: string): boolean {
        return this._runners.get(uri)?.runner.isExecuting ?? false;
    }

    /**
     * Runs the editor's selection, or the whole document when nothing is selected.
     * Asks for a connection first when the editor has none.
     */
    public runQuery(editor: vscode.TextEditor, connect: () => Promise<boolean>): Promise<void> {
        return this.runText(editor, connect, "document", "editor");
    }

    /**
     * Shows the estimated plan of the editor's selection, or of the whole document when nothing
     * is selected (vscode-mssql's onRunQuery with includeEstimatedExecutionPlanXml).
     */
    public showEstimatedPlan(
        editor: vscode.TextEditor,
        connect: () => Promise<boolean>,
    ): Promise<void> {
        return this.runText(editor, connect, "document", "estimated");
    }

    /**
     * Runs the editor's selection, or the statement at the cursor when nothing is selected
     * (vscode-mssql's onRunCurrentStatement). Asks for a connection first when the editor has none.
     */
    public runCurrentStatement(
        editor: vscode.TextEditor,
        connect: () => Promise<boolean>,
    ): Promise<void> {
        return this.runText(editor, connect, "statement", "editor");
    }

    /** `scope` is what runs when nothing is selected. */
    private async runText(
        editor: vscode.TextEditor,
        connect: () => Promise<boolean>,
        scope: "document" | "statement",
        plan: RunPlan,
    ): Promise<void> {
        // vscode-mssql's checks, before anything else.
        if (editor.document.getText().trim() === "") {
            void vscode.window.showInformationMessage(LocalizedConstants.msgNoQueryTextToExecute);
            return;
        }
        if (editor.selections.length > 1) {
            void vscode.window.showErrorMessage(
                LocalizedConstants.msgMultipleSelectionModeNotSupported,
            );
            return;
        }
        if (!editor.selection.isEmpty && editor.document.getText(editor.selection).trim() === "") {
            void vscode.window.showInformationMessage(LocalizedConstants.msgNoQueryTextToExecute);
            return;
        }
        await this.runOnEditor(editor, connect, plan, (runner, driver, connection, planKind) => {
            const selection = editor.selection;
            let range: vscode.Range | undefined;
            if (!selection.isEmpty) {
                range = new vscode.Range(selection.start, selection.end);
            } else if (scope === "document") {
                range = new vscode.Range(0, 0, editor.document.lineCount, 0);
            } else {
                const statement = driver.getStatementAt(editor.document.getText(), {
                    line: selection.active.line,
                    column: selection.active.character,
                });
                range =
                    statement &&
                    new vscode.Range(
                        statement.start.line,
                        statement.start.column,
                        statement.end.line,
                        statement.end.column,
                    );
            }
            // No statement at the cursor: like sqltoolsservice, an empty query, which completes
            // with "Commands completed successfully.".
            const text = range ? editor.document.getText(range) : "";
            const start = (range ?? selection).start;
            const uri = getUriKey(editor.document.uri);
            return runner
                .run(
                    driver,
                    connection,
                    text,
                    {
                        line: start.line,
                        column: start.character,
                    },
                    planKind,
                )
                .finally(() => this._onDidRunText.fire({ uri, text }));
        });
    }

    /**
     * Shows the information about an object, as SSMS's Alt+F1: results replace the editor's current
     * ones. Without a name, lists the objects of the current database.
     */
    public async showObjectInformation(
        editor: vscode.TextEditor,
        objectName: string | undefined,
        connect: () => Promise<boolean>,
    ): Promise<void> {
        await this.runOnEditor(editor, connect, "none", (runner, driver, connection) =>
            runner.runObjectInformation(driver, connection, objectName),
        );
    }

    /**
     * What every run of an editor shares: the "already running" prompt, the connection prompt, a
     * clean results state, and the running flag around `run`.
     */
    private async runOnEditor(
        editor: vscode.TextEditor,
        connect: () => Promise<boolean>,
        plan: RunPlan,
        run: (
            runner: QueryRunner,
            driver: Driver,
            connection: DriverConnection,
            planKind: ExecutionPlanKind | undefined,
        ) => Promise<void>,
    ): Promise<void> {
        const uri = getUriKey(editor.document.uri);
        if (this.isRunning(uri)) {
            const choice = await vscode.window.showInformationMessage(
                LocalizedConstants.msgRunQueryInProgress,
                LocalizedConstants.msgRunQueryInProgressCancelAction,
            );
            if (choice === LocalizedConstants.msgRunQueryInProgressCancelAction) {
                this.cancelQuery(uri);
            }
            return;
        }
        if (!this._connections.isConnected(uri) && !(await connect())) {
            return;
        }
        const editorConnection = this._connections.get(uri);
        if (!editorConnection) {
            return;
        }

        const driver = getDriver(editorConnection.profile.provider);
        const plansAvailable =
            driver.executionPlan !== undefined &&
            editorConnection.connection.executeForPlan !== undefined;
        let planKind: ExecutionPlanKind | undefined;
        if (plan === "estimated") {
            if (!plansAvailable) {
                void vscode.window.showInformationMessage(
                    LocalizedConstants.executionPlanNotSupported(driver.displayName),
                );
                return;
            }
            planKind = "estimated";
        } else if (plan === "editor" && plansAvailable && this._actualPlanUris.has(uri)) {
            planKind = "actual";
        }

        const runner = this.getOrCreateRunner(uri, getEditorTitle(editor.document));
        // Filters, widths and scroll positions belong to the previous results.
        store.deleteUriState(uri);
        this._results.addQueryResultState(uri, runner.title, planKind !== undefined);

        this._connections.setRunning(uri, true);
        try {
            await run(runner, driver, editorConnection.connection, planKind);
        } finally {
            this._connections.setRunning(uri, false);
            // USE (SQL Server) can change the session's database.
            void this._connections.refreshDatabase(uri);
        }
    }

    public cancelQuery(uri: string): void {
        const runner = this._runners.get(uri)?.runner;
        if (!runner?.isExecuting) {
            vscode.window.showInformationMessage(LocalizedConstants.msgCancelQueryNotRunning);
            return;
        }
        runner.cancel();
    }

    /** Shows the results of an editor: its tab when it has one, else the bottom panel view. */
    public revealQueryResult(uri: string): void {
        if (this._results.hasPanel(uri)) {
            this._results.revealPanel(uri);
        } else {
            void vscode.commands.executeCommand(`${Constants.queryResultViewId}.focus`, {
                preserveFocus: true,
            });
        }
    }

    /** Hides the results when they are visible, else shows them (vscode-mssql's toggleQueryResultPanel). */
    public toggleQueryResult(uri: string): void {
        if (this._results.isVisible()) {
            void vscode.commands.executeCommand("workbench.action.closePanel");
        } else {
            this.revealQueryResult(uri);
        }
    }

    public cleanupRunner(uri: string): void {
        const entry = this._runners.get(uri);
        if (!entry) {
            return;
        }
        this._runners.delete(uri);
        entry.listeners.forEach((l) => l.dispose());
        entry.runner.dispose();
        clearTimeout(this._pendingUpdates.get(uri));
        this._pendingUpdates.delete(uri);
        this._runHasError.delete(uri);
        this.supersedeSummary(uri);
        store.deleteUriState(uri);
    }

    // -- execution plans --------------------------------------------------------------

    public isActualPlanEnabled(uri: string): boolean {
        return this._actualPlanUris.has(uri);
    }

    /** Turns the actual plan on or off for the runs of an editor (vscode-mssql's onToggleActualPlan). */
    public setActualPlanEnabled(uri: string, enabled: boolean): void {
        if (enabled) {
            this._actualPlanUris.add(uri);
        } else {
            this._actualPlanUris.delete(uri);
        }
        this.updateActualPlanContext();
    }

    private updateActualPlanContext(): void {
        void vscode.commands.executeCommand("setContext", actualPlanContextKey, [
            ...this._actualPlanUris,
        ]);
    }

    /**
     * Execution plans of the engine of an editor's last run (the plans of its results come from
     * there, even if the editor changed connection since).
     */
    public getExecutionPlanSupport(uri: string | undefined): ExecutionPlanSupport | undefined {
        const runner = uri ? this._runners.get(uri)?.runner : undefined;
        if (runner) {
            return getDriver(runner.dialect).executionPlan;
        }
        const editorConnection = uri ? this._connections.get(uri) : undefined;
        return editorConnection
            ? getDriver(editorConnection.profile.provider).executionPlan
            : undefined;
    }

    /**
     * The plan of the editor's results that a grid cell showed, found by the result set the
     * driver showed its document in (GetExecutionPlanIndexOfCellRequest): the index of its first
     * graph in `executionPlanGraphs`, or -1 when the cell is not one of these result sets.
     */
    public async getExecutionPlanIndexOfCell(uri: string, content: string): Promise<number> {
        const runner = this._runners.get(uri)?.runner;
        if (!runner || !this._results.hasQueryResultState(uri)) {
            return -1;
        }
        const planState = this._results.getQueryResultState(uri).executionPlanState;
        for (const [key, document] of Object.entries(planState?.xmlPlans ?? {})) {
            const match = /^(\d+),(\d+)$/.exec(key);
            if (!match) {
                continue;
            }
            const subset = await runner.getRows(Number(match[1]), Number(match[2]), 0, 1);
            if (subset.rows[0]?.[0]?.displayValue === content) {
                return (
                    planState.executionPlanGraphs?.findIndex(
                        (graph) => graph.graphFile?.graphFileContent === document,
                    ) ?? -1
                );
            }
        }
        return -1;
    }

    /**
     * Opens a new SQL editor with `content`, connected like the editor `sourceUri` when it is
     * connected (vscode-mssql's SqlDocumentService.newQuery with ConnectionStrategy.CopyFromUri).
     */
    public async openQueryEditor(content: string, sourceUri?: string): Promise<void> {
        const doc = await vscode.workspace.openTextDocument({
            language: Constants.languageId,
            content,
        });
        const editor = await vscode.window.showTextDocument(doc);
        const source = sourceUri ? this._connections.get(sourceUri) : undefined;
        if (source) {
            await this._connections.connect(
                getUriKey(editor.document.uri),
                source.profile,
                source.database,
            );
        }
    }

    /**
     * Converts a plan document of a run and adds its graphs to the editor's Query Plan tab
     * (vscode-mssql's onExecutionPlan listener). A document the converter rejects shows its
     * error in the tab, as a failed sqltoolsservice request does.
     */
    private async addExecutionPlan(
        uri: string,
        runner: QueryRunner,
        event: ExecutionPlanEvent,
    ): Promise<void> {
        const support = getDriver(runner.dialect).executionPlan;
        if (!support) {
            return;
        }
        let planGraphs: Awaited<ReturnType<ExecutionPlanService["getExecutionPlan"]>> | undefined;
        let parseError: unknown;
        try {
            planGraphs = await new ExecutionPlanService(support).getExecutionPlan({
                graphFileContent: event.content,
                graphFileType: getPlanGraphFileType(support),
            });
        } catch (e) {
            parseError = e;
        }

        // Read the state after the conversion: plans of the same run are added in order.
        if (!this._results.hasQueryResultState(uri)) {
            return;
        }
        const resultWebviewState = this._results.getQueryResultState(uri);
        const planState = resultWebviewState.executionPlanState;
        const xmlPlans = { ...planState.xmlPlans };
        xmlPlans[
            event.resultId !== undefined
                ? `${event.batchId},${event.resultId}`
                : `${event.batchId},plan${event.planIndex}`
        ] = event.content;
        // Like createExecutionPlanGraphs: the first document in error stops the loading.
        if (planState.loadState === ApiStatus.Error) {
            planState.xmlPlans = xmlPlans;
            return;
        }
        resultWebviewState.isExecutionPlan = true;
        if (planGraphs) {
            const existingGraphs = [...(planState.executionPlanGraphs ?? []), ...planGraphs.graphs];
            resultWebviewState.executionPlanState = {
                ...planState,
                errorMessage: planGraphs.errorMessage,
                executionPlanGraphs: existingGraphs,
                loadState: ApiStatus.Loaded,
                totalCost: existingGraphs.reduce(
                    (acc, graph) => acc + graph.root.cost + graph.root.subTreeCost,
                    0,
                ),
                xmlPlans,
            };
        } else {
            resultWebviewState.executionPlanState = {
                ...planState,
                loadState: ApiStatus.Error,
                errorMessage: getErrorMessage(parseError),
                xmlPlans,
            };
        }

        // Plans can be converted after the run has completed, so an estimated plan run also
        // opens the Query Plan tab here (when no error took the Messages tab).
        if (runner.executionPlanKind === "estimated" && !(this._runHasError.get(uri) ?? false)) {
            resultWebviewState.tabStates.resultPaneTab = qr.QueryResultPaneTabs.ExecutionPlan;
        }
        this.updateNow(uri);
    }

    /** Called when an editor closes: its results go unless they are shown in their own tab. */
    public onDidCloseTextDocument(doc: vscode.TextDocument): void {
        const uri = getUriKey(doc.uri);
        if (this._actualPlanUris.delete(uri)) {
            this.updateActualPlanContext();
        }
        if (!this._results.hasPanel(uri)) {
            this._results.deleteQueryResultState(uri);
            this.cleanupRunner(uri);
        }
    }

    public dispose(): void {
        for (const uri of [...this._runners.keys()]) {
            this.cleanupRunner(uri);
        }
        this._onDidRunText.dispose();
    }

    private getOrCreateRunner(uri: string, title: string): QueryRunner {
        const existing = this._runners.get(uri);
        if (existing) {
            existing.runner.title = title;
            return existing.runner;
        }
        const runner = new QueryRunner(uri, title, this.newRowStore);
        const state = () => this._results.getQueryResultState(uri);
        const showBatchMessages = () =>
            vscode.workspace
                .getConfiguration(Constants.extensionConfigSectionName)
                .get<boolean>(Constants.configResultsShowBatchMessages, true);

        const listeners = [
            runner.onStart(() => {
                const s = state();
                this._runHasError.set(uri, false);
                s.tabStates.resultPaneTab = qr.QueryResultPaneTabs.Messages;
                s.isExecutionPlan = false;
                s.initializationError = undefined;
                s.isExecuting = true;
                s.executionStartTime = Date.now();
                s.executionElapsedMilliseconds = undefined;
                s.rowsAffected = undefined;
                this.updateNow(uri);
                this.revealQueryResult(uri);
            }),
            runner.onBatchStart((batch) => {
                if (!showBatchMessages()) {
                    return;
                }
                const { selection } = batch;
                state().messages.push({
                    // A run that is not text of the editor has no line to link to.
                    message: selection
                        ? LocalizedConstants.runQueryBatchStartMessage
                        : LocalizedConstants.runObjectInformationStartMessage,
                    selection,
                    isError: false,
                    time: new Date().toLocaleTimeString(),
                    link: selection
                        ? {
                              text: LocalizedConstants.runQueryBatchStartLine(
                                  selection.startLine + 1,
                              ),
                              uri,
                          }
                        : undefined,
                });
                this.updateSoon(uri);
            }),
            runner.onResultSetAvailable((resultSet) => {
                const s = state();
                (s.resultSetSummaries[resultSet.batchId] ??= {})[resultSet.id] = { ...resultSet };
                // The first result set brings the Results tab to the front, unless this run shows
                // an estimated plan instead.
                if (
                    countResultSets(s.resultSetSummaries) === 1 &&
                    runner.executionPlanKind !== "estimated"
                ) {
                    s.tabStates.resultPaneTab = qr.QueryResultPaneTabs.Results;
                }
                this.updateNow(uri);
            }),
            runner.onResultSetUpdated((resultSet) => {
                (state().resultSetSummaries[resultSet.batchId] ??= {})[resultSet.id] = {
                    ...resultSet,
                };
                this.updateSoon(uri);
            }),
            runner.onResultSetComplete((resultSet) => {
                (state().resultSetSummaries[resultSet.batchId] ??= {})[resultSet.id] = {
                    ...resultSet,
                };
                this.updateNow(uri);
            }),
            runner.onMessage((message) => {
                const s = state();
                if (message.isError) {
                    this._runHasError.set(uri, true);
                }
                s.messages.push(message);
                if (typeof message.rowsAffected === "number") {
                    s.rowsAffected = message.rowsAffected;
                }
                this.updateSoon(uri);
            }),
            runner.onComplete((e) => {
                const s = state();
                s.isExecuting = false;
                s.executionStartTime = undefined;
                s.executionElapsedMilliseconds = e.totalElapsedMilliseconds;
                if (showBatchMessages()) {
                    s.messages.push({
                        message: LocalizedConstants.elapsedTimeLabel(
                            formatClock(e.totalElapsedMilliseconds),
                        ),
                        isError: false,
                        time: new Date().toLocaleTimeString(),
                    });
                }
                // Like SSMS: Messages after an error or when nothing came back, else Results.
                s.tabStates.resultPaneTab = getCompletedRunTab(
                    s,
                    runner.executionPlanKind === "estimated",
                    e.hasError,
                );
                this.updateNow(uri);
            }),
            runner.onExecutionPlan((e) => this.addExecutionPlan(uri, runner, e)),
        ];
        this._runners.set(uri, { runner, listeners });
        return runner;
    }

    /** Sends the state at once (and drops a pending throttled update). */
    private updateNow(uri: string): void {
        clearTimeout(this._pendingUpdates.get(uri));
        this._pendingUpdates.delete(uri);
        if (this._results.hasQueryResultState(uri)) {
            this._results.pushState(uri, this._results.getQueryResultState(uri));
        }
    }

    /** Sends the state within STATE_UPDATE_DELAY_MS, coalescing the changes made meanwhile. */
    private updateSoon(uri: string): void {
        if (this._pendingUpdates.has(uri)) {
            return;
        }
        this._pendingUpdates.set(
            uri,
            setTimeout(() => this.updateNow(uri), STATE_UPDATE_DELAY_MS),
        );
    }

    // -- requests from the results webview -----------------------------------------

    public async getRows(
        uri: string,
        batchId: number,
        resultId: number,
        rowStart: number,
        numberOfRows: number,
    ): Promise<qr.ResultSetSubset> {
        const runner = this._runners.get(uri)?.runner;
        return (
            (await runner?.getRows(batchId, resultId, rowStart, numberOfRows)) ?? {
                rowCount: 0,
                rows: [],
            }
        );
    }

    public async copySelection(
        uri: string,
        batchId: number,
        resultId: number,
        selection: qr.ISlickRange[],
        includeHeaders: boolean,
    ): Promise<void> {
        const runner = this._runners.get(uri)?.runner;
        if (!runner) {
            return;
        }
        const removeNewLines = vscode.workspace
            .getConfiguration(Constants.extensionConfigSectionName, vscode.Uri.parse(uri))
            .get<boolean>(Constants.configCopyRemoveNewLine, true);
        await runCopyOperation(
            runner.getSelectedRowCount(batchId, resultId, selection),
            async (isCanceled) => {
                const text = await runner.getSelectionAsText(
                    batchId,
                    resultId,
                    selection,
                    includeHeaders,
                    removeNewLines,
                    getEditorEOL(),
                    { isCanceled },
                );
                await vscode.env.clipboard.writeText(text);
            },
        );
    }

    public async copyHeaders(
        uri: string,
        batchId: number,
        resultId: number,
        selection: qr.ISlickRange[],
    ): Promise<void> {
        const runner = this._runners.get(uri)?.runner;
        if (runner) {
            await vscode.env.clipboard.writeText(
                runner.getSelectionHeaders(batchId, resultId, selection),
            );
        }
    }

    public async copyAs(format: CopyFormat, request: CopyAsParams): Promise<void> {
        const runner = this._runners.get(request.uri)?.runner;
        if (runner) {
            await copyResultsAs(
                runner,
                format,
                request.batchId,
                request.resultId,
                request.selection,
            );
        }
    }

    public async saveResults(request: qr.SaveResultsWebviewParams): Promise<void> {
        const runner = this._runners.get(request.uri)?.runner;
        if (runner && request.batchId !== undefined && request.resultId !== undefined) {
            await saveResultsAs(
                runner,
                request.format as SaveFormat,
                request.batchId,
                request.resultId,
                request.selection,
            );
        }
    }

    /**
     * Statistics of a new selection, shown in the results footer. Follows vscode-mssql: a
     * selection of more rows than the in-memory threshold waits for a click ("N rows selected,
     * click to load summary"), then loads with a click-to-cancel text. Rows are read from the
     * store in chunks, and a newer selection drops the computation in progress.
     */
    public updateSelectionSummary(
        uri: string,
        batchId: number,
        resultId: number,
        selection: qr.ISlickRange[],
    ): void {
        const runner = this._runners.get(uri)?.runner;
        if (!runner || !this._results.hasQueryResultState(uri)) {
            return;
        }
        this.supersedeSummary(uri);
        const request: SummaryRequest = { superseded: false };
        this._summaryRequests.set(uri, request);
        void this.loadSelectionSummary(uri, request, runner, batchId, resultId, selection, true);
    }

    /** Click on the summary in the results footer. */
    public handleSelectionSummary(uri: string): void {
        this._summaryRequests.get(uri)?.onClick?.();
    }

    private supersedeSummary(uri: string): void {
        const previous = this._summaryRequests.get(uri);
        if (previous) {
            previous.superseded = true;
            previous.onClick = undefined;
            this._summaryRequests.delete(uri);
        }
    }

    private async loadSelectionSummary(
        uri: string,
        request: SummaryRequest,
        runner: QueryRunner,
        batchId: number,
        resultId: number,
        selection: qr.ISlickRange[],
        askFirst: boolean,
    ): Promise<void> {
        const totalRows = runner.getSelectedRowCount(batchId, resultId, selection);
        const isLarge = totalRows > getInMemoryGridDataProcessingThreshold();
        const command = {
            title: Constants.cmdHandleSummaryOperation,
            command: Constants.cmdHandleSummaryOperation,
            arguments: [uri],
        };
        if (isLarge && askFirst) {
            await new Promise<void>((resolve) => {
                request.onClick = resolve;
                this.setSelectionSummary(uri, request, {
                    text: `$(play-circle) ${LocalizedConstants.QueryResult.summaryFetchConfirmation(totalRows)}`,
                    tooltip: LocalizedConstants.QueryResult.clickToFetchSummary,
                    command,
                    batchId,
                    resultId,
                });
            });
        }
        if (request.superseded) {
            return;
        }
        let canceledByUser = false;
        request.onClick = () => (canceledByUser = true);
        if (isLarge) {
            this.setSelectionSummary(uri, request, {
                text: `$(loading~spin) ${LocalizedConstants.QueryResult.summaryLoadingProgress(totalRows)}`,
                tooltip: LocalizedConstants.QueryResult.clickToCancelLoadingSummary,
                command,
                batchId,
                resultId,
            });
        }
        try {
            const stats = await runner.getSelectionSummary(batchId, resultId, selection, {
                isCanceled: () => request.superseded || canceledByUser,
            });
            const { text, tooltip } = buildSelectionSummaryStatusBarStrings(stats);
            request.onClick = undefined;
            this.setSelectionSummary(uri, request, { stats, text, tooltip, batchId, resultId });
        } catch (error) {
            if (request.superseded) {
                return;
            }
            if (error instanceof OperationCanceledError) {
                // Back to "click to load", as vscode-mssql does after a cancel.
                await this.loadSelectionSummary(
                    uri,
                    request,
                    runner,
                    batchId,
                    resultId,
                    selection,
                    true,
                );
                return;
            }
            request.onClick = undefined;
            this.setSelectionSummary(uri, request, {
                text: LocalizedConstants.QueryResult.errorLoadingSummary,
                tooltip: LocalizedConstants.QueryResult.errorLoadingSummaryTooltip(
                    getErrorMessage(error),
                ),
                batchId,
                resultId,
            });
        }
    }

    private setSelectionSummary(
        uri: string,
        request: SummaryRequest,
        summary: Omit<qr.SelectionSummary, "displayText">,
    ): void {
        if (request.superseded || !this._results.hasQueryResultState(uri)) {
            return;
        }
        const state = this._results.getQueryResultState(uri);
        state.selectionSummary = {
            ...summary,
            displayText: summary.text?.replace(/\$\([^)]+\)\s*/g, "").trim(),
        };
        this._results.pushState(uri, state);
    }

    /** Selects a range in the editor (click on "Line N" in the Messages tab). */
    public async setEditorSelection(uri: string, selection: qr.ISelectionData): Promise<void> {
        const doc = vscode.workspace.textDocuments.find((d) => getUriKey(d.uri) === uri);
        if (!doc) {
            return;
        }
        const visible = vscode.window.visibleTextEditors.find(
            (e) => getUriKey(e.document.uri) === uri,
        );
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: visible?.viewColumn ?? vscode.window.activeTextEditor?.viewColumn,
            preserveFocus: false,
            preview: false,
        });
        const range = new vscode.Range(
            selection.startLine,
            selection.startColumn,
            selection.endLine,
            selection.endColumn,
        );
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
}

/** Title of the results tab: the editor's file name, as vscode-mssql does. */
function getEditorTitle(doc: vscode.TextDocument): string {
    const path = doc.uri.path;
    return path.slice(path.lastIndexOf("/") + 1);
}
