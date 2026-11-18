import { getDriver } from "../drivers";
import type { IConnectionProfile } from "../models/interfaces";

/** True when the engine of the profile has a server dashboard (`Driver.openDashboard`). */
export function hasDashboard(profile: IConnectionProfile | undefined): boolean {
    try {
        return !!profile && getDriver(profile.provider).openDashboard !== undefined;
    } catch {
        // A provider no driver knows: no dashboard, as no connection.
        return false;
    }
}
