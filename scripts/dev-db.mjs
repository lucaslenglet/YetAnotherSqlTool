// npm run dev:db
//
// Starts the databases used while developing the extension (F5): the same SQL Server and
// PostgreSQL containers as the integration tests, with the tables of test/fixtures, on the fixed
// ports that dev-workspace/.vscode/settings.json connects to. They listen on 127.0.0.1 only, stay
// up until Ctrl+C, and are removed then: every start gives fresh databases.

import { startDatabases } from "../test/support/containers.mjs";

const MSSQL_PORT = 11433;
const PG_PORT = 15432;

// Not a secret: a fixed password for throwaway local databases, so that the connections saved in
// dev-workspace/ keep working from one start to the next. Nobody outside this machine can use it,
// since the containers are published on the loopback interface only. Never reuse it elsewhere.
const DEV_PASSWORD = "YastDevOnly_1";

// Registered before the containers start, so that Ctrl+C during the startup also removes them.
let stopping = false;
const stopRequested = new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.once(signal, () => {
            stopping = true;
            resolve();
        });
    }
});
// Signal handlers alone do not keep Node.js running.
const keepAlive = setInterval(() => {}, 2 ** 30);

console.log("Starting SQL Server and PostgreSQL in Docker (the first run downloads the images)...");
let databases;
try {
    databases = await startDatabases({
        mssqlPort: MSSQL_PORT,
        pgPort: PG_PORT,
        password: DEV_PASSWORD,
        namePrefix: "yast-dev",
    });
} catch (error) {
    console.error(`\nCould not start the databases: ${error.message}`);
    console.error("Is Docker running? Is `npm run dev:db` already running in another terminal?");
    process.exit(1);
}

if (!stopping) {
    const { mssql, pg } = databases;
    console.log(`
The development databases are ready (reachable from this machine only):

  SQL Server   ${mssql.host},${mssql.port}   user ${mssql.user}   password ${mssql.password}   database ${mssql.database}
  PostgreSQL   ${pg.host}:${pg.port}   user ${pg.user}   password ${pg.password}   database ${pg.database}

Press F5 in VS Code: the "Docker" connections of dev-workspace/ point to them.
Press Ctrl+C here to stop and remove them.`);
    await stopRequested;
}
console.log("\nRemoving the databases...");
await databases.stop();
clearInterval(keepAlive);
console.log("Done.");
