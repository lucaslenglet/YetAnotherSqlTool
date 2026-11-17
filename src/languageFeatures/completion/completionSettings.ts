import * as vscode from "vscode";
import * as Constants from "../../constants/constants";

/** yast.intelliSense.enableIntelliSense, ported from mssql.intelliSense.enableIntelliSense. */
export const SETTING_ENABLE = "intelliSense.enableIntelliSense";

/** True when a connected editor's catalog metadata loads (yast.intelliSense.enableIntelliSense). */
export function loadsCompletionMetadata(): boolean {
    return vscode.workspace
        .getConfiguration(Constants.extensionConfigSectionName)
        .get<boolean>(SETTING_ENABLE, true);
}
