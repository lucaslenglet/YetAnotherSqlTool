import { buildConnectionString, parseConnectionString } from "./connectionString";
import type { Batch, ConnectParams, Driver } from "../types";
import { PgConnection } from "./connection";
import { openPgDashboard } from "./dashboard";
import { pgLanguage } from "./language";
import { getPgConnectionOptions } from "./options";
import { quoteIdentifier, toSqlLiteral } from "./sqlText";
import { getPgStatementAt, tokenizePg } from "./statements";

function splitBatches(script: string): Batch[] {
    // The whole script is one batch; execute() splits it into statements.
    return script.trim() === "" ? [] : [{ text: script, startLine: 0 }];
}

/** Folded to lower case when unquoted, so anything else (upper case, spaces...) needs quotes. */
const PLAIN_IDENTIFIER = /^[a-z_\u0080-￿][a-z0-9_$\u0080-￿]*$/;

/** The name as written in a script: quoted only when it would not survive unquoted (like quote_ident). */
function formatIdentifier(name: string): string {
    return PLAIN_IDENTIFIER.test(name) &&
        name === name.toLowerCase() &&
        !pgLanguage.reservedKeywords.has(name.toUpperCase())
        ? name
        : quoteIdentifier(name);
}

export const pgDriver: Driver = {
    id: "pg",
    displayName: "PostgreSQL",
    getConnectionOptions: getPgConnectionOptions,
    connect: (params: ConnectParams) => PgConnection.open(params),
    openDashboard: openPgDashboard,
    splitBatches,
    tokenize: tokenizePg,
    language: pgLanguage,
    getStatementAt: getPgStatementAt,
    parseConnectionString,
    buildConnectionString,
    quoteIdentifier,
    formatIdentifier,
    toSqlLiteral,
};
