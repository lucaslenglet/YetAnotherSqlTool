import type { Batch, DriverConnection, ExecuteEvent } from "../../../src/drivers/types";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { mssqlOptions } from "../../support/databases";

// Helpers of the integration tests that talk to the SQL Server test container.

/** Connection options for the SQL Server container started by test/support/globalSetup.ts. */
export const dockerOptions = mssqlOptions;

export function connectToDocker(
    overrides: Record<string, string | number | boolean> = {},
): Promise<DriverConnection> {
    return mssqlDriver.connect({ options: dockerOptions(overrides) });
}

/** Runs a script batch by batch (like the extension does) and collects every event. */
export async function runScript(
    connection: DriverConnection,
    script: string,
    signal = new AbortController().signal,
): Promise<ExecuteEvent[]> {
    const events: ExecuteEvent[] = [];
    for (const batch of mssqlDriver.splitBatches(script)) {
        await connection.execute(batch, (event) => events.push(event), signal);
    }
    return events;
}

export async function runBatch(
    connection: DriverConnection,
    text: string,
    signal = new AbortController().signal,
): Promise<ExecuteEvent[]> {
    const events: ExecuteEvent[] = [];
    const batch: Batch = { text, startLine: 0 };
    await connection.execute(batch, (event) => events.push(event), signal);
    return events;
}
