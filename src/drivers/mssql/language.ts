/**
 * Vocabulary of T-SQL. Generated lists (language.generated.ts, tools/gen-sql-language.mjs) come
 * from a real SQL Server and from the word lists of Microsoft's T-SQL grammar, which is what
 * users of the mssql extension see colored; this file adds the documented lists and removes the
 * few words of that grammar that are not T-SQL.
 */

import type { SqlLanguage } from "../types";
import { GO_LINE } from "./batches";
import {
    grammarFunctions,
    grammarGlobalVariables,
    grammarKeywords,
    mssqlSystemTypes,
} from "./language.generated";

const words = (list: string): string[] => list.trim().split(/\s+/);

/** https://learn.microsoft.com/sql/t-sql/language-elements/reserved-keywords-transact-sql */
export const mssqlReservedKeywords = words(`
    ADD ALL ALTER AND ANY AS ASC AUTHORIZATION BACKUP BEGIN BETWEEN BREAK BROWSE BULK BY CASCADE
    CASE CHECK CHECKPOINT CLOSE CLUSTERED COALESCE COLLATE COLUMN COMMIT COMPUTE CONSTRAINT
    CONTAINS CONTAINSTABLE CONTINUE CONVERT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME
    CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DBCC DEALLOCATE DECLARE DEFAULT DELETE DENY
    DESC DISK DISTINCT DISTRIBUTED DOUBLE DROP DUMP ELSE END ERRLVL ESCAPE EXCEPT EXEC EXECUTE
    EXISTS EXIT EXTERNAL FETCH FILE FILLFACTOR FOR FOREIGN FREETEXT FREETEXTTABLE FROM FULL
    FUNCTION GOTO GRANT GROUP HAVING HOLDLOCK IDENTITY IDENTITY_INSERT IDENTITYCOL IF IN INDEX
    INNER INSERT INTERSECT INTO IS JOIN KEY KILL LEFT LIKE LINENO LOAD MERGE NATIONAL NOCHECK
    NONCLUSTERED NOT NULL NULLIF OF OFF OFFSETS ON OPEN OPENDATASOURCE OPENQUERY OPENROWSET
    OPENXML OPTION OR ORDER OUTER OVER PERCENT PIVOT PLAN PRECISION PRIMARY PRINT PROC PROCEDURE
    PUBLIC RAISERROR READ READTEXT RECONFIGURE REFERENCES REPLICATION RESTORE RESTRICT RETURN
    REVERT REVOKE RIGHT ROLLBACK ROWCOUNT ROWGUIDCOL RULE SAVE SCHEMA SECURITYAUDIT SELECT
    SEMANTICKEYPHRASETABLE SEMANTICSIMILARITYDETAILSTABLE SEMANTICSIMILARITYTABLE SESSION_USER SET
    SETUSER SHUTDOWN SOME STATISTICS SYSTEM_USER TABLE TABLESAMPLE TEXTSIZE THEN TO TOP TRAN
    TRANSACTION TRIGGER TRUNCATE TRY_CONVERT TSEQUAL UNION UNIQUE UNPIVOT UPDATE UPDATETEXT USE
    USER VALUES VARYING VIEW WAITFOR WHEN WHERE WHILE WITH WITHIN WRITETEXT
`);

/**
 * Words of the grammar's generic SQL patterns that T-SQL does not have (MySQL's LIMIT and
 * STRAIGHT_JOIN, NATURAL JOIN, INSERT IGNORE), and GO, which is a keyword only alone on its line.
 */
const notKeywords = new Set(words("LIMIT STRAIGHT_JOIN NATURAL IGNORE GO"));

/**
 * ISO synonyms (https://learn.microsoft.com/sql/t-sql/data-types/data-type-synonyms-transact-sql),
 * ROWVERSION, and the types newer than the SQL Server the list was generated from.
 */
const typeAliases = [
    ...words("ROWVERSION INTEGER DEC CHARACTER JSON VECTOR"),
    "DOUBLE PRECISION",
    "CHARACTER VARYING",
    "CHAR VARYING",
    "BINARY VARYING",
    "NATIONAL CHARACTER",
    "NATIONAL CHAR",
    "NATIONAL CHARACTER VARYING",
    "NATIONAL CHAR VARYING",
    "NATIONAL TEXT",
];

/** Documented built-in functions that the grammar does not list. */
const moreFunctions = words(`
    DATEDIFF_BIG CONCAT_WS CURRENT_TIMEZONE CURRENT_TIMEZONE_ID SESSIONPROPERTY EVENTDATA
    COLUMNS_UPDATED TRIGGER_NESTLEVEL HAS_DBACCESS PUBLISHINGSERVERNAME LOGINPROPERTY
    FILEPROPERTYEX
`);

/**
 * In the grammar's function patterns, but not SQL Server functions: GROUP BY, xml.nodes(), the
 * JSON type, and SESSION_ID of Azure Synapse Analytics.
 */
const notFunctions = new Set(words("GROUP NODES JSON SESSION_ID"));

/** Special values (NULL, and the niladic functions written without parentheses). */
const constants = words(`
    NULL CURRENT_TIMESTAMP CURRENT_DATE CURRENT_TIME CURRENT_USER SESSION_USER SYSTEM_USER USER
`);

export const mssqlLanguage: SqlLanguage = {
    keywords: new Set(
        [...mssqlReservedKeywords, ...grammarKeywords].filter((word) => !notKeywords.has(word)),
    ),
    reservedKeywords: new Set(mssqlReservedKeywords),
    dataTypes: new Set([...mssqlSystemTypes, ...typeAliases]),
    functions: new Set(
        [...grammarFunctions, ...grammarGlobalVariables, ...moreFunctions].filter(
            (name) => !notFunctions.has(name),
        ),
    ),
    constants: new Set(constants),
    batchSeparatorLine: GO_LINE,
};
