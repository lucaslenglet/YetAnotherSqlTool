/**
 * "Import Connections from SQL Server Extension": copies the connections and groups of
 * vscode-mssql (user settings, read only) into YAST's. What is carried over, left out and
 * refused is decided in mssqlImport.ts; this file reads the settings, asks the user and writes.
 */

import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import { ConnectionConfig } from "../connectionconfig/connectionconfig";
import type { IConnectionGroup, IConnectionProfile } from "../models/interfaces";
import { logger } from "../models/logger";
import { uuid } from "../utils/utils";
import { ConnectionStore } from "./connectionStore";
import {
    analyzeMssqlSettings,
    buildImportPlan,
    formatReport,
    summarize,
    type ExistingState,
} from "./mssqlImport";

const importLogger = logger.withPrefix("ImportConnections");

export function registerImportMssqlConnections(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(Constants.cmdImportMssqlConnections, () =>
            importMssqlConnections(store),
        ),
    );
}

/** The user (global) value of a setting of another extension; never a workspace's. */
function readUserSetting(section: string): unknown {
    return vscode.workspace.getConfiguration("mssql").inspect(section)?.globalValue;
}

async function importMssqlConnections(store: ConnectionStore): Promise<void> {
    const rawConnections = readUserSetting("connections");
    const rawGroups = readUserSetting("connectionGroups");
    if (!Array.isArray(rawConnections) || rawConnections.length === 0) {
        await vscode.window.showInformationMessage(
            vscode.l10n.t(
                "There is no connection to import: the user settings of the SQL Server extension (mssql.connections) have none.",
            ),
        );
        return;
    }

    const config = store.connectionConfig;
    const existing: ExistingState = {
        profiles: await config.getConnections(),
        groups: (await config.getGroups()).map((g: IConnectionGroup) => ({
            id: g.id,
            name: g.name,
            parentId: g.parentId,
            inUserSettings: g.configSource === vscode.ConfigurationTarget.Global,
        })),
        rootGroupId: ConnectionConfig.ROOT_GROUP_ID,
    };
    const analysis = analyzeMssqlSettings(rawConnections, rawGroups, existing);

    if (analysis.candidates.length === 0) {
        importLogger.warn("Nothing to import.");
        for (const line of formatReportOfNothing(analysis)) importLogger.warn(line);
        await offerDetails(
            vscode.l10n.t(
                "None of the {0} connection(s) of the SQL Server extension can be imported.",
                analysis.refused.length,
            ),
            "warning",
        );
        return;
    }

    const items = analysis.candidates.map((c) => ({
        label: c.label,
        description: c.alreadyPresent ? vscode.l10n.t("Already present") : undefined,
        detail: c.groupPath.length > 0 ? c.groupPath.join(" / ") : undefined,
        picked: !c.alreadyPresent,
        key: c.key,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        ignoreFocusOut: true,
        title: vscode.l10n.t("Import Connections from SQL Server Extension"),
        placeHolder: vscode.l10n.t("Choose the connections to import (passwords are not imported)"),
    });
    if (!chosen || chosen.length === 0) {
        // The refusals are not in the list: keep them readable even when nothing is imported.
        for (const line of formatReportOfNothing(analysis)) importLogger.info(line);
        return;
    }

    const plan = buildImportPlan(analysis, new Set(chosen.map((i) => i.key)), existing, uuid);
    const failed: number[] = [];
    // A profile in a group that was not saved would be hidden by the Connections view: not saved either.
    const failedGroups = new Set<string>();
    for (const group of plan.groupsToAdd) {
        try {
            if (failedGroups.has(group.parentId)) throw new Error("its parent group failed");
            await config.addGroup({
                ...group,
                configSource: vscode.ConfigurationTarget.Global,
            } as IConnectionGroup);
        } catch (error) {
            failedGroups.add(group.id);
            importLogger.error(`Group "${group.name}" could not be saved: ${String(error)}`);
        }
    }
    for (let i = 0; i < plan.profilesToAdd.length; i++) {
        try {
            if (failedGroups.has(String(plan.profilesToAdd[i].groupId))) {
                throw new Error("its group could not be saved");
            }
            await store.saveProfile(plan.profilesToAdd[i] as unknown as IConnectionProfile);
        } catch (error) {
            failed.push(plan.imported[i].key);
            importLogger.error(`"${plan.imported[i].label}" could not be saved: ${String(error)}`);
        }
    }

    const outcome = { plan, failed };
    for (const line of formatReport(analysis, outcome)) importLogger.info(line);
    const summary = summarize(analysis, outcome);
    const parts = [
        vscode.l10n.t("{0} connection(s) imported", summary.imported),
        summary.groupsCreated > 0
            ? vscode.l10n.t("{0} group(s) created", summary.groupsCreated)
            : "",
        summary.skipped > 0 ? vscode.l10n.t("{0} skipped", summary.skipped) : "",
        summary.refused + failed.length > 0
            ? vscode.l10n.t("{0} not imported", summary.refused + failed.length)
            : "",
        summary.withWarnings > 0
            ? vscode.l10n.t("{0} with options left out", summary.withWarnings)
            : "",
        summary.withActions > 0
            ? vscode.l10n.t("{0} to complete (password or account)", summary.withActions)
            : "",
    ].filter((part) => part !== "");
    const needsAttention =
        summary.refused + failed.length + summary.withWarnings + summary.withActions > 0;
    await offerDetails(parts.join(", ") + ".", needsAttention ? "warning" : "info");
}

function formatReportOfNothing(analysis: ReturnType<typeof analyzeMssqlSettings>): string[] {
    return [
        ...analysis.notes,
        ...analysis.refused.map((r) => `Not imported: "${r.label}": ${r.reason}`),
    ];
}

/** The detail goes to the output channel, which stays after the notification is gone. */
async function offerDetails(message: string, kind: "info" | "warning"): Promise<void> {
    const showDetails = vscode.l10n.t("Show Details");
    const answer =
        kind === "warning"
            ? await vscode.window.showWarningMessage(message, showDetails)
            : await vscode.window.showInformationMessage(message, showDetails);
    if (answer === showDetails) {
        importLogger.show();
    }
}
