/**
 * Vocabulary of PostgreSQL's SQL. Most of it comes from a real server (language.generated.ts,
 * tools/gen-sql-language.mjs); this file adds what the catalogs do not list.
 */

import type { SqlLanguage } from "../types";
import {
    pgDataTypes,
    pgFunctions,
    pgReservedKeywords,
    pgUnreservedKeywords,
} from "./language.generated";

const words = (list: string): string[] => list.trim().split(/\s+/);

/**
 * Type names the grammar knows besides those of pg_type
 * (https://www.postgresql.org/docs/current/datatype.html, table 8.1 "Aliases").
 */
const typeAliases = [
    ...words(`
        INT DEC DECIMAL FLOAT CHAR NCHAR SERIAL SERIAL2 SERIAL4 SERIAL8 SMALLSERIAL BIGSERIAL
    `),
    "CHAR VARYING",
    "NATIONAL CHARACTER",
    "NATIONAL CHAR",
    "NATIONAL CHARACTER VARYING",
    "NATIONAL CHAR VARYING",
];

/**
 * Called like functions but parsed by the grammar, so not in pg_proc (or not under that name):
 * the keywords of pg_get_keywords() documented in "Functions and Operators".
 */
export const pgGrammarFunctions = words(`
    CAST COALESCE NULLIF GREATEST LEAST EXTRACT POSITION SUBSTRING TRIM OVERLAY NORMALIZE TREAT
    GROUPING MERGE_ACTION XMLCONCAT XMLELEMENT XMLEXISTS XMLFOREST XMLPARSE XMLPI XMLROOT
    XMLSERIALIZE XMLTABLE JSON JSON_ARRAY JSON_ARRAYAGG JSON_EXISTS JSON_OBJECT JSON_OBJECTAGG
    JSON_QUERY JSON_SCALAR JSON_SERIALIZE JSON_TABLE JSON_VALUE
`);

/** SQL value functions and literals (https://www.postgresql.org/docs/current/functions-info.html). */
const constants = words(`
    NULL TRUE FALSE CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP LOCALTIME LOCALTIMESTAMP
    CURRENT_USER CURRENT_ROLE SESSION_USER SYSTEM_USER USER CURRENT_CATALOG CURRENT_SCHEMA
`);

export const pgLanguage: SqlLanguage = {
    keywords: new Set([...pgReservedKeywords, ...pgUnreservedKeywords]),
    reservedKeywords: new Set(pgReservedKeywords),
    dataTypes: new Set([...pgDataTypes, ...typeAliases]),
    functions: new Set([...pgFunctions, ...pgGrammarFunctions]),
    constants: new Set(constants),
};
