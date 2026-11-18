import type { ConnectParams, Driver, DriverConnection } from "../types";
import { buildConnectionString, parseConnectionString } from "./connectionString";
import { splitBatches } from "./batches";
import { MssqlConnection } from "./connection";
import { getMssqlConnectionOptions } from "./connectionOptions";
import { parseShowPlanXml, SHOWPLAN_FILE_EXTENSION } from "./executionPlan";
import { mssqlLanguage } from "./language";
import { formatIdentifier, quoteIdentifier, toSqlLiteral } from "./sqlText";
import { getMssqlStatementAt, tokenizeMssql } from "./statements";

/** SQL Server driver, built on the `mssql` package (tedious). */
export const mssqlDriver: Driver = {
    id: "mssql",
    displayName: "Microsoft SQL Server",
    getConnectionOptions: getMssqlConnectionOptions,
    connect: (params: ConnectParams): Promise<DriverConnection> => MssqlConnection.open(params),
    splitBatches,
    tokenize: tokenizeMssql,
    language: mssqlLanguage,
    executionPlan: {
        fileExtension: SHOWPLAN_FILE_EXTENSION,
        documentLanguage: "xml",
        parse: parseShowPlanXml,
    },
    getStatementAt: getMssqlStatementAt,
    parseConnectionString,
    buildConnectionString,
    quoteIdentifier,
    formatIdentifier,
    toSqlLiteral,
};
