/**
 * The "Dashboard" command: from the context menu of a connected server in the Object Explorer,
 * or from the command palette (which asks for a connection). One panel per connection: asking
 * again shows the panel already open.
 */

import * as vscode from "vscode";
import * as Constants from "../constants/constants";
import * as ConnInfo from "../models/connectionInfo";
import { ConnectionStore } from "../connections/connectionStore";
import { Connector } from "../connections/connector";
import { getDriver } from "../drivers";
import type { DriverConnection } from "../drivers/types";
import type { IConnectionProfile } from "../models/interfaces";
import { TreeNodeInfo } from "../objectExplorer/nodes/treeNodeInfo";
import { DASHBOARD_REFRESH_INTERVALS } from "../sharedInterfaces/dashboard";
import { hasDashboard } from "./dashboardSupport";
import { DashboardWebviewController, type DashboardTarget } from "./dashboardWebviewController";

/** globalState key of the interval last picked in a dashboard. */
export const LAST_INTERVAL_KEY = "yast.dashboard.lastRefreshInterval";
const DEFAULT_INTERVAL = 5000;

/** The open dashboards of the window, by connection. */
export class Dashboards implements vscode.Disposable {
    private readonly _panels = new Map<string, DashboardWebviewController>();

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _connector: Pick<Connector, "openDashboard">,
    ) {}

    /** Opens the dashboard of a connection, or shows the one already open. */
    public open(profile: IConnectionProfile, serverInfo?: DriverConnection["serverInfo"]): void {
        const key = dashboardKey(profile);
        const existing = this._panels.get(key);
        if (existing && !existing.isDisposed) {
            existing.revealToForeground();
            return;
        }
        const driver = getDriver(profile.provider);
        const target: DashboardTarget = {
            profile,
            serverName: ConnInfo.getConnectionDisplayName(profile),
            engine: driver.displayName,
            version: serverInfo
                ? [serverInfo.serverVersion, serverInfo.edition].filter(Boolean).join(" ")
                : "",
        };
        const controller = new DashboardWebviewController(
            this._context,
            target,
            (p) => this._connector.openDashboard(p),
            this.settings(),
        );
        this._panels.set(key, controller);
        controller.onDisposed(() => {
            if (this._panels.get(key) === controller) {
                this._panels.delete(key);
            }
        });
    }

    /** Closes every dashboard and waits for their connections to be closed. */
    public async closeAll(): Promise<void> {
        const controllers = [...this._panels.values()];
        this._panels.clear();
        for (const controller of controllers) {
            if (!controller.isDisposed) {
                controller.panel.dispose();
            }
        }
        await Promise.all(controllers.map((c) => c.closed));
    }

    public dispose(): void {
        void this.closeAll();
    }

    private settings() {
        const configured =
            vscode.workspace
                .getConfiguration(Constants.extensionName)
                .get<number>("dashboard.refreshInterval", 0) * 1000;
        const remembered = this._context.globalState.get<number>(LAST_INTERVAL_KEY);
        const autoRefresh = DASHBOARD_REFRESH_INTERVALS.includes(configured);
        const interval = autoRefresh
            ? configured
            : remembered !== undefined && DASHBOARD_REFRESH_INTERVALS.includes(remembered)
              ? remembered
              : DEFAULT_INTERVAL;
        return {
            autoRefresh,
            interval,
            rememberInterval: (value: number) =>
                void this._context.globalState.update(LAST_INTERVAL_KEY, value),
        };
    }
}

/** One dashboard per saved connection; a profile without an id by where it goes and as whom. */
function dashboardKey(profile: IConnectionProfile): string {
    return profile.id
        ? `id:${profile.id}`
        : JSON.stringify([
              profile.provider ?? "mssql",
              profile.server,
              profile.port,
              profile.database,
              profile.authenticationType,
              profile.user,
          ]);
}

export function registerDashboards(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    connector: Connector,
    getSession: (node: TreeNodeInfo) => DriverConnection | undefined,
): Dashboards {
    const dashboards = new Dashboards(context, connector);
    context.subscriptions.push(
        dashboards,
        vscode.commands.registerCommand(Constants.cmdOpenDashboard, async (node?: unknown) => {
            if (node instanceof TreeNodeInfo) {
                const profile = node.connectionProfile;
                if (profile && hasDashboard(profile)) {
                    dashboards.open(profile, getSession(node)?.serverInfo);
                }
                return;
            }
            const profile = await pickDashboardProfile(store);
            if (profile) {
                dashboards.open(profile);
            }
        }),
    );
    return dashboards;
}

/** Quick pick of the saved connections whose engine has a dashboard. */
async function pickDashboardProfile(
    store: ConnectionStore,
): Promise<IConnectionProfile | undefined> {
    const profiles = (await store.connectionConfig.getConnections()).filter(hasDashboard);
    if (profiles.length === 0) {
        void vscode.window.showInformationMessage(
            vscode.l10n.t("No saved connection has a server dashboard."),
        );
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        profiles.map((profile) => ({
            label: ConnInfo.getSimpleConnectionDisplayName(profile),
            description: ConnInfo.getPicklistDescription(profile),
            profile,
        })),
        {
            placeHolder: vscode.l10n.t("Connection whose server dashboard to open"),
            matchOnDescription: true,
        },
    );
    return picked?.profile;
}
