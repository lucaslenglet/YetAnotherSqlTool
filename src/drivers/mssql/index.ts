import type { ConnectParams, Driver, DriverConnection } from "../types";
import { buildConnectionString, parseConnectionString } from "./connectionString";
import { splitBatches } from "./batches";
import { MssqlConnection } from "./connection";
import { openMssqlDashboard } from "./dashboard";
import { getMssqlConnectionOptions } from "./connectionOptions";
import { mssqlLanguage } from "./language";
import { formatIdentifier, quoteIdentifier, toSqlLiteral } from "./sqlText";
import { getMssqlStatementAt, tokenizeMssql } from "./statements";

/** SQL Server driver, built on the `mssql` package (tedious). */
export const mssqlDriver: Driver = {
    id: "mssql",
    displayName: "Microsoft SQL Server",
    getConnectionOptions: getMssqlConnectionOptions,
    connect: (params: ConnectParams): Promise<DriverConnection> => MssqlConnection.open(params),
    openDashboard: openMssqlDashboard,
    splitBatches,
    tokenize: tokenizeMssql,
    language: mssqlLanguage,
    getStatementAt: getMssqlStatementAt,
    parseConnectionString,
    buildConnectionString,
    quoteIdentifier,
    formatIdentifier,
    toSqlLiteral,
};
