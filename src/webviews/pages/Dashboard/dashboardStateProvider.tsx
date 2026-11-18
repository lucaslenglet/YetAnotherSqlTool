/**
 * Commands of the dashboard page, and the store of its points: the history is requested once,
 * then each notification appends the new points. The charts subscribe to that store directly,
 * so that a new point redraws them without a React render of the page.
 */

import * as React from "react";
import { createContext, useEffect, useMemo } from "react";
import {
    DashboardPointsNotification,
    GetDashboardHistoryRequest,
    type DashboardReducers,
    type DashboardState,
} from "../../../sharedInterfaces/dashboard";
import { useVscodeWebview } from "../../common/vscodeWebviewProvider";
import { useVscodeSelector } from "../../common/useVscodeSelector";
import { DashboardPointsStore } from "./dashboardPointsStore";

export interface DashboardContextProps {
    points: DashboardPointsStore;
    refresh(): void;
    setAutoRefresh(enabled: boolean): void;
    setRefreshInterval(interval: number): void;
    reconnect(): void;
}

export const DashboardContext = createContext<DashboardContextProps | undefined>(undefined);

export function useDashboardSelector<T>(
    selector: (state: DashboardState) => T,
    equals?: (a: T, b: T) => boolean,
): T {
    return useVscodeSelector<DashboardState, DashboardReducers, T>(selector, equals);
}

export const DashboardStateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { extensionRpc } = useVscodeWebview<DashboardState, DashboardReducers>();
    const historyId = useDashboardSelector((s) => s?.historyId);
    const points = useMemo(() => new DashboardPointsStore(), []);

    const loadHistory = useMemo(() => {
        let loading: Promise<void> | undefined;
        return () => {
            loading ??= extensionRpc
                .sendRequest(GetDashboardHistoryRequest.type, undefined)
                .then((history) => points.reset(history))
                .catch(() => undefined)
                .finally(() => (loading = undefined));
            return loading;
        };
    }, [extensionRpc, points]);

    useEffect(() => {
        const subscription = extensionRpc.onNotification(
            DashboardPointsNotification.type,
            (update) => {
                if (!points.append(update)) {
                    void loadHistory();
                }
            },
        );
        return () => subscription.dispose();
    }, [extensionRpc, points, loadHistory]);

    useEffect(() => {
        if (historyId !== undefined && historyId !== points.historyId) {
            void loadHistory();
        }
    }, [historyId, points, loadHistory]);

    const commands = useMemo<DashboardContextProps>(
        () => ({
            points,
            refresh: () => extensionRpc.action("refresh"),
            setAutoRefresh: (enabled) => extensionRpc.action("setAutoRefresh", { enabled }),
            setRefreshInterval: (interval) =>
                extensionRpc.action("setRefreshInterval", { interval }),
            reconnect: () => extensionRpc.action("reconnect"),
        }),
        [extensionRpc, points],
    );

    return <DashboardContext.Provider value={commands}>{children}</DashboardContext.Provider>;
};
