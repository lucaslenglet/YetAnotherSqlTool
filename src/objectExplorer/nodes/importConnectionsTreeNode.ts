import * as vscode from "vscode";
import * as Constants from "../../constants/constants";

/** Shown below "Add Connection" when there is no connection yet. */
export class ImportConnectionsTreeNode extends vscode.TreeItem {
    constructor() {
        const label = vscode.l10n.t("Import Connections from SQL Server Extension");
        super(label, vscode.TreeItemCollapsibleState.None);
        this.command = { title: label, command: Constants.cmdImportMssqlConnections };
        this.iconPath = new vscode.ThemeIcon("cloud-download");
    }
}
