import { mssqlDriver } from "./mssql";
import { pgDriver } from "./pg";
import type { Driver, DriverId } from "./types";

const drivers: Record<DriverId, Driver> = {
    mssql: mssqlDriver,
    pg: pgDriver,
};

/** Driver for a connection profile's `provider`. Profiles without one are SQL Server ones. */
export function getDriver(provider: DriverId | undefined): Driver {
    const driver = drivers[provider ?? "mssql"];
    if (!driver) {
        throw new Error(`Unknown database provider '${provider}'.`);
    }
    return driver;
}

export function getDrivers(): Driver[] {
    return Object.values(drivers);
}
