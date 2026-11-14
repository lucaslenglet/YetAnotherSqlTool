import { inject } from "vitest";

// Where the integration tests find the databases started by globalSetup.ts. The port and the
// passwords change on every run: take them from here, never write them in a test.

/** Address and credentials of one test database (see containers.mjs). */
export interface DatabaseInfo {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

/** The PostgreSQL that takes Microsoft Entra ID sign-ins (test/fixtures/postgres-entra). */
export interface EntraDatabaseInfo extends DatabaseInfo {
    /** The server's self-signed certificate, PEM. */
    certificate: string;
}

declare module "vitest" {
    export interface ProvidedContext {
        mssql: DatabaseInfo;
        pg: DatabaseInfo;
        pgEntra: EntraDatabaseInfo;
    }
}

type Options = Record<string, string | number | boolean>;

function database<Name extends "mssql" | "pg" | "pgEntra">(name: Name) {
    const info = inject(name);
    if (!info) {
        throw new Error(
            "No test database: tests that need one must be named *.integration.test.ts (npm run test:integration)",
        );
    }
    return info;
}

/** Port of the SQL Server test database on the host. */
export const mssqlPort = () => database("mssql").port;

/** The SQL Server test database as the user types it and as the Object Explorer shows it: "host,port". */
export function mssqlServer(): string {
    const { host, port } = database("mssql");
    return `${host},${port}`;
}

/** Connection options of the mssql driver for the SQL Server test database. */
export function mssqlOptions(overrides: Options = {}) {
    const { user, password, database: name } = database("mssql");
    return {
        server: mssqlServer(),
        database: name,
        authenticationType: "SqlLogin",
        user,
        password,
        encrypt: "Mandatory",
        trustServerCertificate: true,
        ...overrides,
    };
}

/** Port of the PostgreSQL test database on the host. */
export const pgPort = () => database("pg").port;

/** The PostgreSQL test database as the Object Explorer shows it: "host:port". */
export function pgServer(): string {
    const { host, port } = database("pg");
    return `${host}:${port}`;
}

/** Connection options of the pg driver for the PostgreSQL test database. */
export function pgOptions(overrides: Options = {}) {
    const { host, port, user, password, database: name } = database("pg");
    return {
        server: host,
        port,
        database: name,
        user,
        password,
        authenticationType: "SqlLogin",
        ...overrides,
    };
}

/**
 * Address, superuser and certificate of the PostgreSQL that takes Microsoft Entra ID sign-ins.
 * Its other database is `sales`; Entra roles must be members of `azure_ad_user`.
 */
export const pgEntra = () => database("pgEntra");
