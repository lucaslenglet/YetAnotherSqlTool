/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Collection of Non-localizable Constants
export const languageId = "sql";
// Prefixed: the mssql extension registers "queryResult", and a second registration fails activation.
export const queryResultViewId = "yastQueryResult";
export const extensionId = "YetAnotherSqlTool.yet-another-sql-tool";
export const extensionName = "yast";
export const extensionConfigSectionName = "yast";
export const telemetryConfigSectionName = "telemetry";
export const configProfilerEventBufferSize = "profiler.eventBufferSize";
export const mssqlProviderName = "MSSQL";
export const objectExplorerId = "yastObjectExplorer";
export const objectExplorerFilterEncryptionKeySecretStorageKey =
    "yast.objectExplorerFilterEncryptionKey";
export const objectExplorerFilterGlobalStorageFileName = "objectExplorerFilters.enc";
export const queryHistory = "queryHistory";
export const backgroundTasks = "backgroundTasks";
export const queryHistoryEncryptionKeySecretStorageKey = "yast.queryHistoryTreeEncryptionKey";
export const queryHistoryGlobalStorageFileName = "queryHistoryTree.enc";
export const connectionApplicationName = "YetAnotherSqlTool";
export const outputChannelName = "YetAnotherSqlTool";
export const connectionConfigFilename = "settings.json";
export const connectionsArrayName = "connections";
export const connectionGroupsArrayName = "connectionGroups";
export const disconnectedServerNodeType = "disconnectedServer";
export const disconnected = "disconnected";
export const serverLabel = "Server";
export const disconnectedDockerContainer = "disconnectedDockerContainer";
export const dockerContainer = "DockerContainer";
export const dockerContainerDatabase = "DockerContainerDatabase";
export const databasesSubNodeType = "Databases";
export const folderLabel = "Folder";
export const database_green = "Database_green";
export const database_red = "Database_red";
export const cmdRunQuery = "yast.runQuery";
export const cmdRunQueryWithUriOwnership = "yast.runQueryWithUriOwnership";
export const cmdShowObjectInformation = "yast.showObjectInformation";
export const cmdRunCurrentStatement = "yast.runCurrentStatement";
export const cmdOpenShortcutsConfiguration = "yast.shortcutsConfiguration.open";
export const cmdCancelQuery = "yast.cancelQuery";
export const cmdRevealQueryResult = "yast.revealQueryResult";
export const cmdToggleQueryResultPanel = "yast.toggleQueryResultPanel";
export const cmdCopyAll = "yast.copyAll";
export const cmdConnect = "yast.connect";
export const cmdConnectWithUriOwnership = "yast.connectWithUriOwnership";
export const cmdDisconnect = "yast.disconnect";
export const cmdCancelConnect = "yast.cancelConnect";
export const cmdChangeConnection = "yast.changeConnection";
export const cmdChangeDatabase = "yast.changeDatabase";
export const cmdChooseDatabase = "yast.chooseDatabase";
export const cmdChooseLanguageFlavor = "yast.chooseLanguageFlavor";
export const cmdShowGettingStarted = "yast.showGettingStarted";
export const cmdRefreshQueryHistory = "yast.refreshQueryHistory";
export const cmdClearAllQueryHistory = "yast.clearAllQueryHistory";
export const cmdClearFinishedBackgroundTasks = "yast.clearFinishedBackgroundTasks";
export const cmdDeleteQueryHistory = "yast.deleteQueryHistory";
export const cmdOpenQueryHistory = "yast.openQueryHistory";
export const cmdOpenBackgroundTask = "yast.openBackgroundTask";
export const cmdViewBackgroundTaskLogs = "yast.viewBackgroundTaskLogs";
export const cmdRunQueryHistory = "yast.runQueryHistory";
export const cmdStartQueryHistory = "yast.startQueryHistoryCapture";
export const cmdPauseQueryHistory = "yast.pauseQueryHistoryCapture";
export const cmdCommandPaletteQueryHistory = "yast.commandPaletteQueryHistory";
export const cmdCancelBackgroundTask = "yast.cancelBackgroundTask";
export const cmdBackgroundTaskAction = "yast.backgroundTaskAction";
export const backgroundTaskLogUriScheme = "mssql-background-task-log";
export const cmdNewQuery = "yast.newQuery";
export const cmdSchemaCompare = "yast.schemaCompare";
export const cmdTableExplorer = "yast.tableExplorer";
export const cmdSearchDatabase = "yast.searchDatabase";
export const cmdTableNodeAction = "yast.tableNodeAction";
export const cmdSchemaCompareOpenFromCommandPalette = "yast.schemaCompareOpenFromCommandPalette";
export const triggerSchemaCompareAutomatic = "automatic";
export const triggerSchemaCompareManual = "manual";
export const cmdDacpacDialog = "yast.dacpacDialog.launch";
export const cmdDeployDacpac = "yast.dacpacDialog.deploy";
export const cmdExtractDacpac = "yast.dacpacDialog.extract";
export const cmdImportBacpac = "yast.dacpacDialog.import";
export const cmdExportBacpac = "yast.dacpacDialog.export";
export const cmdPublishDatabaseProject = "yast.publishDatabaseProject";
export const cmdConfigureCodeAnalysisSettings = "yast.configureCodeAnalysisSettings";
export const cmdManageConnectionProfiles = "yast.manageProfiles";
export const cmdClearPooledConnections = "yast.clearPooledConnections";
export const cmdRebuildIntelliSenseCache = "yast.rebuildIntelliSenseCache";
export const cmdAddObjectExplorer = "yast.addObjectExplorer";
export const cmdConnectionGroupCreate = "yast.connectionGroups.create";
export const cmdConnectionGroupEdit = "yast.connectionGroups.edit";
export const cmdConnectionGroupDelete = "yast.connectionGroups.delete";
export const cmdObjectExplorerNewQuery = "yast.objectExplorerNewQuery";
export const cmdCreateDatabase = "yast.createDatabase";
export const cmdDropDatabase = "yast.dropDatabase";
export const cmdRenameDatabase = "yast.renameDatabase";
export const cmdRemoveObjectExplorerNode = "yast.removeObjectExplorerNode";
export const cmdRefreshObjectExplorerNode = "yast.refreshObjectExplorerNode";
export const cmdDisconnectObjectExplorerNode = "yast.disconnectObjectExplorerNode";
export const cmdObjectExplorerNodeSignIn = "yast.objectExplorerNodeSignIn";
export const cmdConnectObjectExplorerNode = "yast.connectObjectExplorerNode";
export const cmdConnectObjectExplorerProfile = "yast.connectObjectExplorerProfile";
export const cmdOpenObjectExplorerCommand = "workbench.view.extension.objectExplorer";
export const cmdObjectExplorerGroupBySchemaFlagName = "yast.objectExplorer.groupBySchema";
export const cmdObjectExplorerEnableGroupBySchemaCommand =
    "yast.objectExplorer.enableGroupBySchema";
export const cmdObjectExplorerDisableGroupBySchemaCommand =
    "yast.objectExplorer.disableGroupBySchema";
export const cmdObjectExplorerCollapseOrExpandByDefault =
    "objectExplorer.collapseConnectionGroupsOnStartup";
export const cmdEnableExperimentalFeatures = "yast.enableExperimentalFeatures";
export const cmdScriptSelect = "yast.scriptSelect";
export const cmdScriptCreate = "yast.scriptCreate";
export const cmdScriptDelete = "yast.scriptDelete";
export const cmdScriptExecute = "yast.scriptExecute";
export const cmdScriptAlter = "yast.scriptAlter";
export const cmdScriptDatabase = "yast.scriptDatabase";
export const cmdToggleSqlCmd = "yast.toggleSqlCmd";
export const cmdCopyObjectName = "yast.copyObjectName";
export const cmdCopyConnectionString = "yast.copyConnectionString";
export const cmdFilterNode = "yast.filterNode";
export const cmdFilterNodeWithExistingFilters = "yast.filterNodeWithExistingFilters";
export const cmdClearFilters = "yast.clearFilters";
export const cmdOpenExtension = "extension.open";
export const cmdLoadCompletionExtension = "yast.loadCompletionExtension";
export const cmdAadRemoveAccount = "yast.removeAadAccount";
export const cmdAadAddAccount = "yast.addAadAccount";
export const cmdClearAzureTokenCache = "yast.clearAzureAccountTokenCache";
export const cmdShowEstimatedPlan = "yast.showEstimatedPlan";
export const cmdEnableActualPlan = "yast.enableActualPlan";
export const cmdDisableActualPlan = "yast.disableActualPlan";
export const cmdToggleActualPlan = "yast.toggleActualPlan";
export const cmdCompareExecutionPlans = "yast.compareExecutionPlans";
export const cmdEnableLiveQueryStatistics = "yast.enableLiveQueryStatistics";
export const cmdDisableLiveQueryStatistics = "yast.disableLiveQueryStatistics";
export const cmdNewTable = "yast.newTable";
export const cmdEditTable = "yast.editTable";
export const cmdEditConnection = "yast.editConnection";
export const cmdDesignSchema = "yast.schemaDesigner";
export const cmdDesignSchemaForTable = "yast.schemaDesignerForTable";
export const cmdBuildDataApi = "yast.buildDataApi";
export const cmdDeployNewDatabase = "yast.deployNewDatabase";
export const cmdStopContainer = "yast.stopContainer";
export const cmdDeleteContainer = "yast.deleteContainer";
export const cmdStartContainer = "yast.startContainer";
export const cmdCancelContainerOperation = "yast.cancelContainerOperation";
export const cmdHandleSummaryOperation = "yast.handleSummaryOperation";
export const cmdMoveToSchema = "yast.moveToSchema";
export const cmdOpenOverview = "yast.openOverview";
/**
 * Menu items take their label from the command, so this exists only to read as "Open" next to the
 * node rather than the full title.
 */
export const cmdOpenOverviewFromNode = "yast.objectExplorer.openOverview";
export const cmdHideOverviewInObjectExplorer = "yast.hideOverviewInObjectExplorer";
export const cmdShowOverviewInObjectExplorer = "yast.showOverviewInObjectExplorer";
export const overviewVisibleContextKey = "yast.overviewVisible";
export const cmdOpenAzureDataStudioMigration = "yast.openAzureDataStudioMigration";
export const cmdBackupDatabase = "yast.backupDatabase";
export const cmdRestoreDatabase = "yast.restoreDatabase";
export const cmdLaunchProfiler = "yast.profiler.launchFromObjectExplorer";
export const cmdFlatFileImport = "yast.flatFileImport";
export const cmdNotebooksCreate = "yast.notebooks.createNotebook";
export const cmdNotebooksChangeDatabase = "yast.notebooks.changeDatabase";
export const cmdNotebooksChangeConnection = "yast.notebooks.changeConnection";
export const cmdNotebooksCopyCellMessages = "yast.notebooks.copyCellMessages";

export const piiLogging = "piiLogging";
export const mssqlPiiLogging = "yast.piiLogging";
export const enableConnectionPooling = "yast.enableConnectionPooling";
export const sqlDbSuffix = ".database.windows.net";
export const defaultConnectionTimeout = 15;
export const azureSqlDbConnectionTimeout = 30;
export const defaultCommandTimeout = 30;
export const stsImmediateActivityTimeout = 5000; // 5 seconds
// Upper bound for a query cancel round-trip to SQL Tools Service before the editor is reset.
export const queryCancelRequestTimeoutMs = 15000; // 15 seconds
// Grace period for a completion notification to arrive after the service reported that it has
// no running query for an editor we still consider executing.
export const queryCancelOrphanGraceMs = 2000; // 2 seconds
export const azureDatabase = "Azure";
export const azureMfa = "AzureMFA";
export const azureServicePrincipal = "ActiveDirectoryServicePrincipal";
export const defaultPortNumber = 1433;
export const integratedauth = "Integrated";
export const sqlAuthentication = "SqlLogin";
export const defaultDatabase = "master";
export const systemDatabases = ["master", "tempdb", "model", "msdb"];
export const defaultSchema = "dbo";
export const errorPasswordExpired = 18487;
export const errorPasswordNeedsReset = 18488;
export const errorLoginFailed = 18456;
export const errorSSLCertificateValidationFailed = -2146893019;
export const errorKerberosSubString = "Kerberos";

/**
 * SqlClient connection timeout error number
 */
export const errorConnectionTimeout = -2;

export const oeExpandTimeoutErrorCode = "EXPAND_TIMEOUT";
export const oeCreateSessionTimeoutErrorCode = "CREATE_SESSION_TIMEOUT";

/**
 * SQL Tools Service error codes for operation timeouts
 */
export const serverlessWakeTimeoutErrorCodes = [
    oeExpandTimeoutErrorCode,
    oeCreateSessionTimeoutErrorCode,
];

export const outputContentTypeRoot = "root";
export const outputContentTypeMessages = "messages";
export const outputContentTypeResultsetMeta = "resultsetsMeta";
export const outputContentTypeColumns = "columns";
export const outputContentTypeRows = "rows";
export const outputContentTypeConfig = "config";
export const outputContentTypeSaveResults = "saveResults";
export const outputContentTypeOpenLink = "openLink";
export const outputContentTypeCopy = "copyResults";
export const outputContentTypeEditorSelection = "setEditorSelection";
export const outputContentTypeShowError = "showError";
export const outputContentTypeShowWarning = "showWarning";
export const outputServiceLocalhost = "http://localhost:";
export const localhost = "localhost";
export const defaultSqlServerContainerName = "sql_server_container";
export const containerConnectionMaxAttempts = 3;
export const containerConnectionRetryDelayMs = 3000;
export const msgContentProviderSqlOutputHtml = "dist/html/sqlOutput.ejs";
export const contentProviderMinFile = "dist/js/app.min.js";
export const timeToWaitForLanguageModeChange = 10000.0;

export const dotnetAcquireCommand = "dotnet.acquire";
export const databaseString = "Database";
export const localizedTexts = "localizedTexts";
export const ipAddressRegex =
    /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/;
export const xml = "xml";
export const json = "json";
export const queryPlan = "Query Plan";
export const queryPlanXmlStart = "<ShowPlanXML";
export const https = "https://";

export const configAzureAccount = "azureAccount";
export const azureAccountProviderCredentials = "azureAccountProviderCredentials";
export const msalCacheFileName = "accessTokenCache";

// Configuration Constants
export const copyIncludeHeaders = "yast.copyIncludeHeaders";
export const configLogDebugInfo = "logDebugInfo";
export const configMyConnections = "connections";
export const configSaveAsCsv = "saveAsCsv";
export const configSaveAsJson = "saveAsJson";
export const configSaveAsExcel = "saveAsExcel";
export const configResultsOpenAfterSave = "results.openAfterSave";
export const configRecentConnections = "recentConnections";
export const configMaxRecentConnections = "maxRecentConnections";
export const configCopyRemoveNewLine = "copyRemoveNewLine";
export const configSplitPaneSelection = "splitPaneSelection";
export const configShowBatchTime = "showBatchTime";
export const configResultsShowBatchMessages = "results.showBatchMessages";
export const configMessagesCopyIncludeTimestamps = "messages.copyIncludeTimestamps";
export const configPreventAutoExecuteScript = "yast.query.preventAutoExecuteScript";
export enum extConfigResultKeys {
    Shortcuts = "shortcuts",
    MessagesDefaultOpen = "messagesDefaultOpen",
    ResultsFontSize = "resultsFontSize",
    ResultsFontFamily = "resultsFontFamily",
}
export const sqlToolsServiceInstallDirConfigKey = "installDir";
export const sqlToolsServiceExecutableFilesConfigKey = "executableFiles";
export const sqlToolsServiceVersionConfigKey = "version";
export const sqlToolsServiceDownloadUrlConfigKey = "downloadUrl";
export const extConfigResultFontFamily = "resultsFontFamily";
export const configPersistQueryResultTabs = "persistQueryResultTabs";
export const configQueryHistoryLimit = "queryHistoryLimit";
export const configEnableQueryHistoryCapture = "enableQueryHistoryCapture";
export const configEnableQueryHistoryFeature = "enableQueryHistoryFeature";
export const configQueryCompletionSoundEnabled = "query.playCompletionSound";
export const configQueryCompletionSoundFile = "query.completionSoundFile";
export const configEnableExperimentalFeatures = "yast.enableExperimentalFeatures";
export const configUseMsalEntraMfaAuth = "yast.useMsalEntraMfaAuth";
export const configOpenQueryResultsInTabByDefault = "yast.openQueryResultsInTabByDefault";
export const configOpenQueryResultsInTabByDefaultDoNotShowPrompt =
    "yast.openQueryResultsInTabByDefaultDoNotShowPrompt";
export const configAutoColumnSizingMode = "resultsGrid.autoSizeColumnsMode";
export const configInMemoryDataProcessingThreshold =
    "yast.resultsGrid.inMemoryDataProcessingThreshold";
export const configResultsGridAlternatingRowColors = "resultsGrid.alternatingRowColors";
export const configResultsGridFreezeFirstColumnByDefault = "resultsGrid.freezeFirstColumnByDefault";
export const configResultsGridShowGridLines = "resultsGrid.showGridLines";
export const configResultsGridRowPadding = "resultsGrid.rowPadding";
export const configResultsGridRightAlignNumbers = "resultsGrid.rightAlignNumbers";
export const configAutoDisableNonTSqlLanguageService = "yast.autoDisableNonTSqlLanguageService";
export const configShowActiveConnectionAsCodeLensSuggestion =
    "yast.query.showActiveConnectionAsCodeLensSuggestion";
export const configStatusBarConnectionInfoMaxLength = "statusBar.connectionInfoMaxLength";
export const configStatusBarEnableConnectionColor = "yast.statusBar.enableConnectionColor";
export const configStatusBarShowQueryExecutionStatus = "statusBar.showQueryExecutionStatus";
export const configStatusBarShowServerProcessId = "statusBar.showServerProcessId";
export const configDabCliPackageFeedUrl = "yast.dab.cliPackageFeedUrl";
export const configSchemaDesignerEnableExpandCollapseButtons =
    "yast.schemaDesigner.enableExpandCollapseButtons";
export const configSchemaDesignerEnableDeploymentsView =
    "yast.schemaDesigner.enableDeploymentsView";
export const configSavePasswordsUntilRestart =
    "yast.connectionManagement.rememberPasswordsUntilRestart";
export const configAutoRevealResultsPanel = "yast.autoRevealResultsPanel";
export const configShortcuts = "yast.shortcuts";
export const configQuickQueries = "yast.quickQueries";
// ToolsService Constants
export const serviceInstallingTo = "Installing SQL tools service to";
export const serviceInstalling = "Installing";
export const serviceDownloading = "Downloading";
export const serviceInstalled = "Sql Tools Service installed";

export const sqlToolsServiceName = "SQLToolsService";
export const sqlToolsServiceConfigKey = "service";
export const v1SqlToolsServiceConfigKey = "v1Service";
export const scriptSelectText = "SELECT TOP (1000) * FROM ";
export const tenantDisplayName = "Microsoft";
export const sqlPlanLanguageId = "sqlplan";
export const showPlanXmlColumnName = "Microsoft SQL Server 2005 XML Showplan";
export enum Platform {
    Windows = "win32",
    Mac = "darwin",
    Linux = "linux",
}
export const sa = "SA";
export const x64 = "x64";
export const simple = "Simple";
export const allFileTypes = ["*.*"];

// Backup+Restore Constants
export const defaultBackupFileTypes = [".bak", ".log", ".trn"];
export const disk = "Disk";
export const url = "URL";

// Flat File Import Constants
export const flatFileImportFileTypes = ["csv", "txt"];

// Deployment Constants
export const windowsDockerDesktopExecutable = "Docker Desktop.exe";
export const docker = "docker";
export const dockerDeploymentLoggerChannelName = "Docker Deployment";

/**
 * Error substrings from Docker daemon stderr that indicate a socket permission
 * problem (not a stopped daemon). These are system-level strings from Linux/Docker
 * and are not locale-dependent.
 */
export const dockerPermissionErrorPatterns = ["permission denied", "eacces"];

// SQL Database Projects Constants
export const DSP_PREFIX = "Microsoft.Data.Tools.Schema.Sql.Sql";
export const DSP_SUFFIX = "DatabaseSchemaProvider";
export const sqlServerDockerRepository = "mssql/server";
export const dockerImageDefaultTag = "latest";
export const AzureSqlDbFullDockerImageName = "Azure SQL Database (Edge emulation)";
export const SqlServerDockerImageName = "SQL Server";
export const MAX_PORT_NUMBER = 65535;
export const SqlServerName = "SQL server";
export const AzureSqlServerName = "Azure SQL server";
export const DefaultSqlPortNumber = "1433";
export const DefaultAdminUsername = "sa";
export const DBProjectConfigurationKey = "sqlDatabaseProjects";
export const enableSqlProjPreviewFeaturesKey = "enablePreviewFeatures";
export const AzureSqlV12 = "AzureV12";
export const PublishProfileExtension = "publish.xml";
export const DacpacExtension = ".dacpac";
export const SqlPackagePublishAction = "Publish";
export const TargetServerName = "TargetServerName";
export const dotnet = "dotnet";
export const build = "build";
export const sqlProjBuildTaskType = "sqlproj-build";
export const msBuildProblemMatcher = "$msCompile";
export const buildDirectory = "BuildDirectory";
export const user = "User";
export const activeDirectory = "ActiveDirectory";
// Regex pattern to match and replace database names in connection strings. Matches: (Initial Catalog|Database)
export const catalogPairPattern =
    /(^|;)\s*(Initial\s+Catalog|Database)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*?))\s*(?=;|$)/gi;

// DacFx operation IDs (as reported by SQL Tools Service via taskOperation field)
export const operationIdExportBacpac = "ExportOperation";
export const operationIdExtractDacpac = "ExtractOperation";
export const operationIdImportBacpac = "ImportOperation";
export const operationIdDeployDacpac = "DeployOperation";

// Code Analysis Constants
export const codeAnalysisViewId = "codeAnalysis";
