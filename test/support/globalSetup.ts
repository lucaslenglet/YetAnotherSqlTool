import type { TestProject } from "vitest/node";
import { startDatabases } from "./containers.mjs";

/**
 * Runs once before the integration tests: starts the databases in Docker (Testcontainers) and
 * hands their address and credentials to the tests, which read them through test/support/databases.ts.
 * The returned function runs after the last test and removes the containers.
 */
export default async function setup(project: TestProject) {
    const databases = await startDatabases({ entra: true });
    project.provide("mssql", databases.mssql);
    project.provide("pg", databases.pg);
    project.provide("pgEntra", databases.pgEntra!);
    return () => databases.stop();
}
