// Container definitions of the test databases (SQL Server and PostgreSQL), shared by the
// integration tests (test/support/globalSetup.ts) and by `npm run dev:db` (scripts/dev-db.mjs).
// The integration tests also get a PostgreSQL that takes Microsoft Entra ID sign-ins.
// Plain JavaScript so that the dev script can import it without a TypeScript loader.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MSSQLServerContainer } from "@testcontainers/mssqlserver";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";

/**
 * @typedef {object} DatabaseInfo
 * @property {string} host
 * @property {number} port Port on the host
 * @property {string} user
 * @property {string} password
 * @property {string} database
 *
 * @typedef {object} StartOptions
 * @property {number} [mssqlPort] Host port of SQL Server; a random free port when omitted
 * @property {number} [pgPort] Host port of PostgreSQL; a random free port when omitted
 * @property {string} [password] Password of both databases; one is generated for each when omitted
 * @property {string} [namePrefix] Names the containers `<prefix>-mssql` and `<prefix>-postgres`
 * @property {boolean} [entra] Also starts the PostgreSQL that takes Microsoft Entra ID sign-ins
 *
 * @typedef {object} StartedDatabases
 * @property {DatabaseInfo} mssql
 * @property {DatabaseInfo} pg
 * @property {DatabaseInfo & { certificate: string }} [pgEntra] Only with the `entra` option
 * @property {() => Promise<void>} stop Stops and removes the containers and their volumes
 */

export const MSSQL_IMAGE = "mcr.microsoft.com/mssql/server:2022-latest";
export const POSTGRES_IMAGE = "postgres:17";

/** Database, and PostgreSQL role, holding the tables of test/fixtures. */
const DATABASE = "yast";
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Set on our containers to the pid of the process that started them; see removeContainers. */
const OWNER_LABEL = "yast.owner-pid";

// Ryuk is the helper container Testcontainers normally starts to remove containers once the
// process is gone. Its control port is published on every network interface, and whoever
// reaches it can make it delete containers. It stays off, and this file does the cleaning:
//   - stop() removes the containers at the end of a normal run;
//   - removeOnExit() removes them when the process ends before that (Ctrl+C, crash);
//   - the next start removes those of a process that was killed outright.
process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

/**
 * Publishes the ports of a container on 127.0.0.1 only. Testcontainers publishes them on every
 * interface, and ports published by Docker are not filtered by firewalls such as ufw.
 * @template {new (...args: any[]) => any} T
 * @param {T} Base
 * @returns {T}
 */
function loopbackOnly(Base) {
    return class extends Base {
        async beforeContainerCreated() {
            await super.beforeContainerCreated?.();
            for (const bindings of Object.values(this.hostConfig.PortBindings ?? {})) {
                for (const binding of bindings) binding.HostIp = "127.0.0.1";
            }
        }
    };
}

/** Meets SQL Server's password policy and has no character a shell or a connection string treats specially. */
function generatePassword() {
    return `Yast_1${randomBytes(12).toString("hex")}`;
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code !== "ESRCH";
    }
}

/**
 * Removes, with their volumes, the database containers whose owner matches. Only containers
 * carrying our label are ever considered.
 * @param {(ownerPid: number) => boolean} isTarget
 */
export async function removeContainers(isTarget) {
    const { dockerode } = (await getContainerRuntimeClient()).container;
    const ours = await dockerode.listContainers({ all: true, filters: { label: [OWNER_LABEL] } });
    const targets = ours.filter((info) => isTarget(Number(info.Labels[OWNER_LABEL])));
    await Promise.all(
        targets.map(async (info) => {
            try {
                await dockerode.getContainer(info.Id).remove({ force: true, v: true });
            } catch (error) {
                // Already gone, or being removed by someone else: nothing left to do.
                if (error.statusCode !== 404 && error.statusCode !== 409) throw error;
            }
        }),
    );
}

/**
 * "exit" handler: removes the containers of this process, including one that is still starting.
 * An exit handler cannot wait for the Docker API, so a child process does the work meanwhile.
 */
function removeOnExit() {
    const script = fileURLToPath(new URL("./removeContainers.mjs", import.meta.url));
    spawnSync(process.execPath, [script, String(process.pid)], { stdio: "ignore", timeout: 30000 });
}

/** Applies what both containers have in common. */
function configure(container, containerPort, hostPort, name) {
    container.withLabels({ [OWNER_LABEL]: String(process.pid) });
    if (hostPort) container.withExposedPorts({ container: containerPort, host: hostPort });
    if (name) container.withName(name);
    return container;
}

/** @returns {Promise<DatabaseInfo>} */
async function startMssql(hostPort, password, name) {
    const definition = new (loopbackOnly(MSSQLServerContainer))(MSSQL_IMAGE)
        .acceptLicense()
        .withPassword(password)
        .withEnvironment({ MSSQL_PID: "Developer" })
        .withCopyDirectoriesToContainer([{ source: `${FIXTURES}mssql`, target: "/fixtures" }]);
    const container = await configure(definition, 1433, hostPort, name).start();

    // SQL Server has no folder of init scripts: run the fixtures with sqlcmd. Logins can still be
    // refused for a moment after the "Recovery is complete" log line the container waits for.
    const sqlcmd =
        'for f in /fixtures/*.sql; do SQLCMDPASSWORD="$MSSQL_SA_PASSWORD" /opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -i "$f" || exit 1; done';
    for (let attempt = 1; ; attempt++) {
        const { exitCode, output } = await container.exec(["bash", "-c", sqlcmd]);
        if (exitCode === 0) break;
        if (attempt === 30) {
            throw new Error(`Could not load test/fixtures/mssql into SQL Server:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return {
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password,
        database: DATABASE,
    };
}

/** @returns {Promise<DatabaseInfo>} */
async function startPostgres(hostPort, password, name) {
    const definition = new (loopbackOnly(PostgreSqlContainer))(POSTGRES_IMAGE)
        .withDatabase(DATABASE)
        .withUsername(DATABASE)
        .withPassword(password)
        // The image runs the scripts of this folder when it creates the database.
        .withCopyDirectoriesToContainer([
            { source: `${FIXTURES}postgres`, target: "/docker-entrypoint-initdb.d" },
        ]);
    const container = await configure(definition, 5432, hostPort, name).start();

    return {
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password,
        database: DATABASE,
    };
}

/**
 * A PostgreSQL that takes Microsoft Entra ID sign-ins like Azure Database for PostgreSQL: TLS,
 * and roles whose password is an access token (test/fixtures/postgres-entra). The user and
 * password returned are those of its superuser, which the tests use to create such roles.
 * `certificate` is the server's self-signed certificate (PEM), made when the container starts.
 * @returns {Promise<DatabaseInfo & { certificate: string }>}
 */
async function startEntraPostgres(password) {
    const definition = new (loopbackOnly(PostgreSqlContainer))(POSTGRES_IMAGE)
        .withDatabase(DATABASE)
        .withUsername(DATABASE)
        .withPassword(password)
        .withCopyDirectoriesToContainer([
            { source: `${FIXTURES}postgres-entra`, target: "/docker-entrypoint-initdb.d" },
        ]);
    const container = await configure(definition, 5432).start();

    const { exitCode, output } = await container.exec(["sh", "-c", 'cat "$PGDATA/server.crt"']);
    if (exitCode !== 0)
        throw new Error(`Could not read the certificate of the Entra ID PostgreSQL:\n${output}`);

    return {
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password,
        database: DATABASE,
        certificate: output,
    };
}

/**
 * Starts SQL Server and PostgreSQL in parallel, each with the `yast` database of test/fixtures,
 * listening on 127.0.0.1 only.
 * @param {StartOptions} [options]
 * @returns {Promise<StartedDatabases>}
 */
export async function startDatabases({ mssqlPort, pgPort, password, namePrefix, entra } = {}) {
    // Left behind by a previous run that was killed before it could remove them.
    await removeContainers((ownerPid) => !isAlive(ownerPid));
    process.on("exit", removeOnExit);

    const removeOwn = () => removeContainers((ownerPid) => ownerPid === process.pid);
    const stop = async () => {
        await removeOwn();
        process.off("exit", removeOnExit);
    };

    try {
        const [mssql, pg, pgEntra] = await Promise.all([
            startMssql(
                mssqlPort,
                password ?? generatePassword(),
                namePrefix && `${namePrefix}-mssql`,
            ),
            startPostgres(
                pgPort,
                password ?? generatePassword(),
                namePrefix && `${namePrefix}-postgres`,
            ),
            entra ? startEntraPostgres(password ?? generatePassword()) : undefined,
        ]);
        return { mssql, pg, pgEntra, stop };
    } catch (error) {
        // One database may have started while the other one failed. If it is still starting,
        // removeOnExit gets it when the process ends.
        await removeOwn();
        throw error;
    }
}
