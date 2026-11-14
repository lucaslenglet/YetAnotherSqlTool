import { describe, expect, it } from "vitest";
import { getMssqlStatementAt, mssqlStatementSpans } from "../../../src/drivers/mssql/statements";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { statementAt, withCursor } from "../../sql/statementCases";

const at = (marked: string) => statementAt(getMssqlStatementAt, marked);
const lines = (...l: string[]) => l.join("\n");

/** Statements the heuristic finds in a batch. */
const split = (script: string) =>
    mssqlStatementSpans(script).map((s) => script.slice(s.start, s.end));

/** [what, script with a "|" cursor, statement expected to run]. */
const cases: [string, string, string | undefined][] = [
    // -- basics -------------------------------------------------------------------------------
    ["empty script", "|", undefined],
    ["whitespace only", "  \n | \n", undefined],
    ["comment only", "-- nothing | here", undefined],
    ["single statement", "SELECT | 1", "SELECT  1"],
    ["cursor at the start", "|SELECT 1", "SELECT 1"],
    ["cursor after the last character", "SELECT 1|", "SELECT 1"],
    ["cursor after the statement on its line", "SELECT 1   |", "SELECT 1"],
    ["cursor before the statement on its line", "  |  SELECT 1", "SELECT 1"],
    ["the semicolon belongs to the statement", "SELECT 1|;", "SELECT 1;"],
    ["after the semicolon", "SELECT 1;|", "SELECT 1;"],
    ["SSMS style, no semicolons, first", "SELECT |1\nSELECT 2\nSELECT 3", "SELECT 1"],
    ["SSMS style, no semicolons, second", "SELECT 1\nSELECT |2\nSELECT 3", "SELECT 2"],
    ["SSMS style, no semicolons, last", "SELECT 1\nSELECT 2\nSEL|ECT 3", "SELECT 3"],
    ["blank line between statements", "SELECT 1\n|\nSELECT 2", undefined],
    ["semicolons on one line, first", "SELECT 1; SEL|ECT 2; SELECT 3;", "SELECT 2;"],
    ["several statements on one line, no semicolons", "SELECT 1 SELECT |2", "SELECT 2"],
    ["cursor between two statements of a line", "SELECT 1; | SELECT 2;", undefined],
    ["touching statements: the one ending at the cursor", "SELECT 1;|SELECT 2;", "SELECT 1;"],
    ["CRLF line endings", "SELECT 1\r\nSELECT |2\r\nSELECT 3\r\n", "SELECT 2"],
    [
        "multi-line statement, cursor on a middle line",
        lines("SELECT a,", "  |  b", "FROM t", "WHERE a = 1", "SELECT 2"),
        lines("SELECT a,", "    b", "FROM t", "WHERE a = 1"),
    ],
    [
        "multi-line statement, cursor after its end on its last line",
        lines("SELECT a", "FROM t   |", "SELECT 2"),
        lines("SELECT a", "FROM t"),
    ],
    [
        "leading and trailing comments are not part of it",
        lines("-- the customers", "SELECT * FROM customers -- all |of them", "SELECT 2"),
        "SELECT * FROM customers",
    ],
    [
        "a comment inside is part of it",
        lines("SELECT a, -- first", "  b /* SELECT */", "FROM |t"),
        lines("SELECT a, -- first", "  b /* SELECT */", "FROM t"),
    ],
    [
        "keywords in strings",
        "SELECT 'UPDATE t SET a = 1' AS |x\nSELECT 2",
        "SELECT 'UPDATE t SET a = 1' AS x",
    ],
    ["keywords in comments", "SELECT 1 /* SELECT 2 */ + |1", "SELECT 1 /* SELECT 2 */ + 1"],
    [
        "keywords in quoted identifiers",
        'SELECT [select], "update" FROM |t',
        'SELECT [select], "update" FROM t',
    ],
    ["unterminated string", "SELECT 1\nSELECT '|abc\nSELECT 3", "SELECT 'abc\nSELECT 3"],

    // -- batches ----------------------------------------------------------------------------
    ["only the batch of the cursor", "SELECT 1\nGO\nSELECT |2\nGO\nSELECT 3", "SELECT 2"],
    ["cursor on a GO line", "SELECT 1\nG|O\nSELECT 2", undefined],
    [
        "procedure body ends at GO",
        lines("CREATE PROCEDURE p AS", "SELECT 1", "SELECT |2", "GO", "EXEC p"),
        lines("CREATE PROCEDURE p AS", "SELECT 1", "SELECT 2"),
    ],

    // -- SELECT ---------------------------------------------------------------------------------
    ["UNION", "SELECT 1\nUNION\nSELECT |2", "SELECT 1\nUNION\nSELECT 2"],
    ["UNION ALL", "SELECT 1 UNION ALL SELECT |2\nSELECT 3", "SELECT 1 UNION ALL SELECT 2"],
    [
        "EXCEPT and INTERSECT",
        "SELECT 1 EXCEPT SELECT 2 INTERSECT SELECT |3",
        "SELECT 1 EXCEPT SELECT 2 INTERSECT SELECT 3",
    ],
    [
        "subquery",
        "SELECT * FROM (SELECT 1 AS a) |x WHERE a IN (SELECT 1)",
        "SELECT * FROM (SELECT 1 AS a) x WHERE a IN (SELECT 1)",
    ],
    [
        "table hint WITH (NOLOCK)",
        "SELECT * FROM t WITH (NOLOCK)\nWHERE |a = 1\nSELECT 2",
        "SELECT * FROM t WITH (NOLOCK)\nWHERE a = 1",
    ],
    [
        "TOP WITH TIES",
        "SELECT TOP 1 WITH TIES a FROM t ORDER |BY a",
        "SELECT TOP 1 WITH TIES a FROM t ORDER BY a",
    ],
    ["SELECT INTO", "SELECT a INTO #t FROM t\nSELECT * FROM |#t", "SELECT * FROM #t"],
    [
        "FOR XML",
        "SELECT a FROM t FOR XML PATH(''), |TYPE\nSELECT 2",
        "SELECT a FROM t FOR XML PATH(''), TYPE",
    ],
    ["FOR JSON", "SELECT a FROM t FOR JSON AUTO|\nSELECT 2", "SELECT a FROM t FOR JSON AUTO"],
    [
        "OPTION",
        "SELECT a FROM t OPTION (RECOMPILE)|\nSELECT 2",
        "SELECT a FROM t OPTION (RECOMPILE)",
    ],
    [
        "OFFSET FETCH",
        "SELECT a FROM t ORDER BY a OFFSET 0 ROWS FETCH NEXT 5 ROWS |ONLY",
        "SELECT a FROM t ORDER BY a OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY",
    ],
    [
        "CASE ... END",
        "SELECT CASE WHEN a = 1 THEN 'x' ELSE 'y' END |FROM t\nSELECT 2",
        "SELECT CASE WHEN a = 1 THEN 'x' ELSE 'y' END FROM t",
    ],
    [
        "OPENJSON WITH",
        "SELECT * FROM OPENJSON(@j) WITH (a int) |AS j\nSELECT 2",
        "SELECT * FROM OPENJSON(@j) WITH (a int) AS j",
    ],
    [
        "keyword used as a column name",
        "UPDATE t SET open = 1, [close] = |2",
        "UPDATE t SET open = 1, [close] = 2",
    ],
    ["qualified name ending with a keyword", "EXEC dbo.|Update 1\nSELECT 2", "EXEC dbo.Update 1"],
    [
        "temp tables and variables",
        "DECLARE @x int\nSELECT @x = a FROM ##g|lobal",
        "SELECT @x = a FROM ##global",
    ],

    // -- CTE ------------------------------------------------------------------------------------
    [
        "CTE then SELECT",
        lines("SELECT 0", "WITH c AS (SELECT 1 AS a)", "SELECT * FROM |c", "SELECT 2"),
        lines("WITH c AS (SELECT 1 AS a)", "SELECT * FROM c"),
    ],
    [
        "CTE, cursor in the CTE",
        lines("WITH c (a) AS (SELECT |1), d AS (SELECT 2)", "DELETE FROM c"),
        lines("WITH c (a) AS (SELECT 1), d AS (SELECT 2)", "DELETE FROM c"),
    ],
    [
        ";WITH",
        "SELECT 0\n;WITH c AS (SELECT 1 AS a) UPDATE c SET a = |2",
        "WITH c AS (SELECT 1 AS a) UPDATE c SET a = 2",
    ],
    [
        "CTE then MERGE",
        "WITH s AS (SELECT 1 a) MERGE t USING s ON t.a = s.a WHEN MATCHED THEN |DELETE;",
        "WITH s AS (SELECT 1 a) MERGE t USING s ON t.a = s.a WHEN MATCHED THEN DELETE;",
    ],
    [
        "WITH XMLNAMESPACES",
        "SELECT 0\nWITH XMLNAMESPACES ('u' AS x) SELECT |1",
        "WITH XMLNAMESPACES ('u' AS x) SELECT 1",
    ],

    // -- INSERT / UPDATE / DELETE / MERGE -------------------------------------------------------
    [
        "INSERT VALUES",
        "INSERT INTO t (a) VALUES (1), (|2)\nSELECT 2",
        "INSERT INTO t (a) VALUES (1), (2)",
    ],
    [
        "INSERT SELECT",
        "INSERT INTO t (a)\nSELECT a FROM |u\nSELECT 2",
        "INSERT INTO t (a)\nSELECT a FROM u",
    ],
    ["INSERT SELECT then SELECT", "INSERT INTO t SELECT 1\nSELECT |2", "SELECT 2"],
    ["INSERT VALUES then SELECT", "INSERT t VALUES (1)\nSELECT |2", "SELECT 2"],
    ["INSERT EXEC", "INSERT INTO t\nEXEC |p 1\nSELECT 2", "INSERT INTO t\nEXEC p 1"],
    ["INSERT EXECUTE", "INSERT t EXECUTE ('SELECT |1')", "INSERT t EXECUTE ('SELECT 1')"],
    [
        "INSERT OUTPUT INTO",
        "INSERT INTO t (a) OUTPUT inserted.a INTO @ids SELECT |1",
        "INSERT INTO t (a) OUTPUT inserted.a INTO @ids SELECT 1",
    ],
    ["INSERT DEFAULT VALUES then SELECT", "INSERT t DEFAULT VALUES\nSELECT |1", "SELECT 1"],
    [
        "INSERT with a table hint",
        "INSERT INTO t WITH (TABLOCK) SELECT |1",
        "INSERT INTO t WITH (TABLOCK) SELECT 1",
    ],
    [
        "UPDATE SET",
        "UPDATE t\nSET a = |1\nWHERE b = 2\nSELECT 2",
        "UPDATE t\nSET a = 1\nWHERE b = 2",
    ],
    ["UPDATE SET then SET", "UPDATE t SET a = 1\nSET |NOCOUNT ON", "SET NOCOUNT ON"],
    [
        "UPDATE FROM JOIN",
        "UPDATE t SET a = u.a FROM t JOIN u ON t.id = u.id WHERE |u.b = 1",
        "UPDATE t SET a = u.a FROM t JOIN u ON t.id = u.id WHERE u.b = 1",
    ],
    ["UPDATE STATISTICS then SET", "UPDATE STATISTICS t\nSET |NOCOUNT ON", "SET NOCOUNT ON"],
    [
        "DELETE OUTPUT",
        "DELETE FROM t OUTPUT deleted.* WHERE |a = 1\nSELECT 2",
        "DELETE FROM t OUTPUT deleted.* WHERE a = 1",
    ],
    [
        "MERGE",
        lines(
            "MERGE INTO t AS tgt",
            "USING s ON tgt.id = s.id",
            "WHEN MATCHED THEN UPDATE SET a = s.a",
            "WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)",
            "WHEN NOT MATCHED BY SOURCE THEN |DELETE",
            "OUTPUT $action;",
            "SELECT 2",
        ),
        lines(
            "MERGE INTO t AS tgt",
            "USING s ON tgt.id = s.id",
            "WHEN MATCHED THEN UPDATE SET a = s.a",
            "WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)",
            "WHEN NOT MATCHED BY SOURCE THEN DELETE",
            "OUTPUT $action;",
        ),
    ],
    [
        "MERGE with a hint",
        "MERGE t WITH (HOLDLOCK) USING s ON 1 = 1 WHEN MATCHED THEN |DELETE;",
        "MERGE t WITH (HOLDLOCK) USING s ON 1 = 1 WHEN MATCHED THEN DELETE;",
    ],

    // -- variables, cursors, SET ----------------------------------------------------------------
    ["DECLARE then SET then SELECT", "DECLARE @x int\nSET @x = |1\nSELECT @x", "SET @x = 1"],
    [
        "SET with a subquery",
        "SET @x = (SELECT |MAX(a) FROM t)\nSELECT @x",
        "SET @x = (SELECT MAX(a) FROM t)",
    ],
    ["SET options", "SET NOCOUNT ON\nSET |XACT_ABORT ON\nSELECT 1", "SET XACT_ABORT ON"],
    [
        "SET TRANSACTION ISOLATION LEVEL",
        "SET TRANSACTION ISOLATION LEVEL READ |COMMITTED\nSELECT 1",
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    ],
    [
        "DECLARE with a subquery",
        "DECLARE @x int = (SELECT |1)\nPRINT @x",
        "DECLARE @x int = (SELECT 1)",
    ],
    [
        "DECLARE table variable",
        "DECLARE @t TABLE (a int)\nINSERT @t VALUES (|1)",
        "INSERT @t VALUES (1)",
    ],
    [
        "DECLARE CURSOR FOR SELECT",
        "DECLARE c CURSOR LOCAL FOR\nSELECT a FROM |t\nOPEN c",
        "DECLARE c CURSOR LOCAL FOR\nSELECT a FROM t",
    ],
    [
        "cursor FOR UPDATE OF",
        "DECLARE c CURSOR FOR SELECT a FROM t FOR UPDATE OF |a\nOPEN c",
        "DECLARE c CURSOR FOR SELECT a FROM t FOR UPDATE OF a",
    ],
    [
        "OPEN FETCH CLOSE DEALLOCATE",
        "OPEN c\nFETCH NEXT FROM c |INTO @x\nCLOSE c\nDEALLOCATE c",
        "FETCH NEXT FROM c INTO @x",
    ],
    ["compound assignment", "SET @i += 1\nSELECT |@i", "SELECT @i"],

    // -- control flow ---------------------------------------------------------------------------
    [
        "IF with a single statement body",
        "IF @x = 1\n  SELECT |1\nSELECT 2",
        "IF @x = 1\n  SELECT 1",
    ],
    ["IF cursor in the condition", "IF @x |= 1 SELECT 1\nSELECT 2", "IF @x = 1 SELECT 1"],
    [
        "IF ELSE",
        "IF @x = 1\n  SELECT 1\nELSE\n  SELECT |2\nSELECT 3",
        "IF @x = 1\n  SELECT 1\nELSE\n  SELECT 2",
    ],
    [
        "IF ; ELSE",
        "IF @x = 1 SELECT 1;\nELSE SELECT |2;\nSELECT 3",
        "IF @x = 1 SELECT 1;\nELSE SELECT 2;",
    ],
    [
        "IF BEGIN END ELSE BEGIN END",
        lines(
            "IF EXISTS (SELECT 1)",
            "BEGIN",
            "  SELECT |1",
            "  SELECT 2",
            "END",
            "ELSE",
            "BEGIN",
            "  SELECT 3",
            "END",
            "SELECT 4",
        ),
        lines(
            "IF EXISTS (SELECT 1)",
            "BEGIN",
            "  SELECT 1",
            "  SELECT 2",
            "END",
            "ELSE",
            "BEGIN",
            "  SELECT 3",
            "END",
        ),
    ],
    ["statement after IF BEGIN END", "IF 1 = 1 BEGIN SELECT 1 END\nSELECT |2", "SELECT 2"],
    [
        "ELSE IF chain",
        "IF @a = 1 SELECT 1 ELSE IF @a = 2 SELECT 2 ELSE SELECT |3\nPRINT 'x'",
        "IF @a = 1 SELECT 1 ELSE IF @a = 2 SELECT 2 ELSE SELECT 3",
    ],
    [
        "nested IF with ELSE",
        "IF @a = 1 IF @b = 1 SELECT 1 ELSE SELECT 2 ELSE SELECT |3",
        "IF @a = 1 IF @b = 1 SELECT 1 ELSE SELECT 2 ELSE SELECT 3",
    ],
    [
        "IF UPDATE(column)",
        "IF UPDATE(a) OR UPDATE(b) PRINT |'changed'",
        "IF UPDATE(a) OR UPDATE(b) PRINT 'changed'",
    ],
    [
        "IF NOT EXISTS DROP",
        "IF OBJECT_ID('t') IS NOT NULL DROP TABLE |t\nCREATE TABLE t (a int)",
        "IF OBJECT_ID('t') IS NOT NULL DROP TABLE t",
    ],
    [
        "IF with a CASE in its body",
        "IF @x = 1 SELECT CASE WHEN a = 1 THEN 1 ELSE 2 END FROM t ELSE SELECT |3",
        "IF @x = 1 SELECT CASE WHEN a = 1 THEN 1 ELSE 2 END FROM t ELSE SELECT 3",
    ],
    [
        "WHILE BEGIN END",
        lines("WHILE @i < 10", "BEGIN", "  SET @i += |1", "  IF @i = 5 BREAK", "END", "SELECT @i"),
        lines("WHILE @i < 10", "BEGIN", "  SET @i += 1", "  IF @i = 5 BREAK", "END"),
    ],
    ["WHILE with a single statement", "WHILE @i < 10 SET @i += 1\nSELECT |@i", "SELECT @i"],
    [
        "BEGIN END block",
        "BEGIN\n  SELECT 1\n  SELECT |2\nEND\nSELECT 3",
        "BEGIN\n  SELECT 1\n  SELECT 2\nEND",
    ],
    ["BEGIN END;", "BEGIN SELECT 1 END|; SELECT 2", "BEGIN SELECT 1 END;"],
    [
        "TRY CATCH",
        lines(
            "BEGIN TRY",
            "  SELECT 1/0",
            "END TRY",
            "BEGIN CATCH",
            "  SELECT ERROR_|MESSAGE()",
            "END CATCH",
            "SELECT 2",
        ),
        lines(
            "BEGIN TRY",
            "  SELECT 1/0",
            "END TRY",
            "BEGIN CATCH",
            "  SELECT ERROR_MESSAGE()",
            "END CATCH",
        ),
    ],
    [
        "TRY CATCH with THROW",
        "BEGIN TRY SELECT 1 END TRY BEGIN CATCH THROW; END |CATCH\nSELECT 2",
        "BEGIN TRY SELECT 1 END TRY BEGIN CATCH THROW; END CATCH",
    ],
    ["label and GOTO", "retry:\nSELECT |1\nGOTO retry", "SELECT 1"],
    ["RETURN then SELECT", "IF @x = 1 RETURN\nSELECT |1", "SELECT 1"],
    ["RETURN with a value", "RETURN |@x\nSELECT 1", "RETURN @x"],
    ["WAITFOR", "WAITFOR DELAY '00:00:01'\nSELECT |1", "SELECT 1"],

    // -- transactions ---------------------------------------------------------------------------
    ["BEGIN TRAN is a statement", "BEGIN TRAN\nUPDATE t SET a = |1\nCOMMIT", "UPDATE t SET a = 1"],
    ["BEGIN TRANSACTION", "BEGIN TRANSACTION |t1\nSELECT 1", "BEGIN TRANSACTION t1"],
    ["BEGIN DISTRIBUTED TRAN", "BEGIN DISTRIBUTED TRAN|\nSELECT 1", "BEGIN DISTRIBUTED TRAN"],
    ["COMMIT TRAN", "SELECT 1\nCOMMIT |TRAN", "COMMIT TRAN"],
    ["ROLLBACK TRANSACTION", "ROLLBACK TRANSACTION| sp1\nSELECT 1", "ROLLBACK TRANSACTION sp1"],
    ["SAVE TRAN", "SAVE TRAN |sp1\nSELECT 1", "SAVE TRAN sp1"],
    [
        "IF @@TRANCOUNT > 0 ROLLBACK",
        "IF @@TRANCOUNT > 0 ROLLBACK|\nSELECT 1",
        "IF @@TRANCOUNT > 0 ROLLBACK",
    ],

    // -- EXEC -----------------------------------------------------------------------------------
    ["EXEC with named parameters", "EXEC p @a = 1, @b = |'x'\nSELECT 1", "EXEC p @a = 1, @b = 'x'"],
    ["EXEC with a return code", "EXEC @rc = p |1\nSELECT @rc", "EXEC @rc = p 1"],
    ["EXEC (@sql)", "SET @sql = 'SELECT 1'\nEXEC (|@sql)", "EXEC (@sql)"],
    [
        "EXEC WITH RESULT SETS",
        "EXEC p WITH RESULT SETS ((a int))|\nSELECT 1",
        "EXEC p WITH RESULT SETS ((a int))",
    ],
    ["EXECUTE AS", "EXECUTE AS USER = |'u'\nSELECT USER_NAME()\nREVERT", "EXECUTE AS USER = 'u'"],
    ["procedure without EXEC first in the batch", "sp_who|\nSELECT 1", "sp_who"],

    // -- DDL ------------------------------------------------------------------------------------
    [
        "CREATE TABLE then INSERT",
        "CREATE TABLE t (a int, b int)\nINSERT t VALUES (|1, 2)",
        "INSERT t VALUES (1, 2)",
    ],
    [
        "CREATE TABLE, cursor in it",
        "CREATE TABLE t (\n  a int |NOT NULL\n)\nINSERT t VALUES (1)",
        "CREATE TABLE t (\n  a int NOT NULL\n)",
    ],
    [
        "CREATE TABLE AS SELECT",
        "CREATE TABLE t2 WITH (DISTRIBUTION = ROUND_ROBIN) AS SELECT |1 a",
        "CREATE TABLE t2 WITH (DISTRIBUTION = ROUND_ROBIN) AS SELECT 1 a",
    ],
    [
        "CREATE TABLE with ON DELETE",
        "CREATE TABLE c (p int REFERENCES p (id) ON DELETE CASCADE)\nSELECT |1",
        "SELECT 1",
    ],
    [
        "ALTER TABLE ADD FOREIGN KEY ON DELETE ON UPDATE",
        "ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY (p) REFERENCES p (id) ON DELETE CASCADE ON UPDATE NO |ACTION\nSELECT 1",
        "ALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY (p) REFERENCES p (id) ON DELETE CASCADE ON UPDATE NO ACTION",
    ],
    ["CREATE INDEX WITH", "CREATE INDEX i ON t (a) WITH (ONLINE = ON)\nSELECT |1", "SELECT 1"],
    [
        "CREATE VIEW takes the rest of the batch",
        "CREATE VIEW v AS\nSELECT 1 AS a\nUNION SELECT |2",
        "CREATE VIEW v AS\nSELECT 1 AS a\nUNION SELECT 2",
    ],
    [
        "CREATE OR ALTER PROCEDURE",
        "CREATE OR ALTER PROCEDURE p AS\nBEGIN\n  SELECT 1\nEND\nSELECT |2",
        "CREATE OR ALTER PROCEDURE p AS\nBEGIN\n  SELECT 1\nEND\nSELECT 2",
    ],
    [
        "ALTER FUNCTION",
        "ALTER FUNCTION f() RETURNS TABLE AS RETURN SELECT |1 a",
        "ALTER FUNCTION f() RETURNS TABLE AS RETURN SELECT 1 a",
    ],
    [
        "CREATE TRIGGER",
        "CREATE TRIGGER tr ON t AFTER INSERT, UPDATE AS\nIF UPDATE(a) PRINT 1\nSELECT |1",
        "CREATE TRIGGER tr ON t AFTER INSERT, UPDATE AS\nIF UPDATE(a) PRINT 1\nSELECT 1",
    ],
    [
        "DROP TABLE IF EXISTS",
        "DROP TABLE IF EXISTS |t\nCREATE TABLE t (a int)",
        "DROP TABLE IF EXISTS t",
    ],
    [
        "DROP then IF EXISTS",
        "DROP TABLE t\nIF EXISTS (SELECT 1) PRINT |1",
        "IF EXISTS (SELECT 1) PRINT 1",
    ],
    [
        "ALTER TABLE DROP COLUMN",
        "ALTER TABLE t DROP COLUMN |c\nSELECT 1",
        "ALTER TABLE t DROP COLUMN c",
    ],
    [
        "ALTER TABLE DROP CONSTRAINT IF EXISTS",
        "ALTER TABLE t DROP CONSTRAINT IF EXISTS |c",
        "ALTER TABLE t DROP CONSTRAINT IF EXISTS c",
    ],
    ["ALTER TABLE then DROP TABLE", "ALTER TABLE t ADD c int\nDROP TABLE |u", "DROP TABLE u"],
    [
        "ALTER TABLE ALTER COLUMN",
        "ALTER TABLE t ALTER COLUMN c |bigint\nSELECT 1",
        "ALTER TABLE t ALTER COLUMN c bigint",
    ],
    [
        "ALTER TABLE then ALTER TABLE",
        "ALTER TABLE t ADD c int\nALTER TABLE t ADD |d int",
        "ALTER TABLE t ADD d int",
    ],
    [
        "ALTER TABLE SET",
        "ALTER TABLE t SET (LOCK_ESCALATION = |AUTO)\nSELECT 1",
        "ALTER TABLE t SET (LOCK_ESCALATION = AUTO)",
    ],
    [
        "ALTER DATABASE SET WITH ROLLBACK",
        "ALTER DATABASE d SET SINGLE_USER WITH ROLLBACK |IMMEDIATE\nSELECT 1",
        "ALTER DATABASE d SET SINGLE_USER WITH ROLLBACK IMMEDIATE",
    ],
    [
        "ALTER DATABASE SET then SET",
        "ALTER DATABASE d SET RECOVERY SIMPLE\nSET |NOCOUNT ON",
        "SET NOCOUNT ON",
    ],
    [
        "ALTER TABLE ENABLE TRIGGER",
        "ALTER TABLE t ENABLE TRIGGER |ALL\nSELECT 1",
        "ALTER TABLE t ENABLE TRIGGER ALL",
    ],
    ["ENABLE TRIGGER", "SELECT 1\nENABLE TRIGGER tr ON |t", "ENABLE TRIGGER tr ON t"],
    ["TRUNCATE TABLE", "TRUNCATE TABLE |t\nSELECT 1", "TRUNCATE TABLE t"],
    [
        "CREATE VIEW WITH CHECK OPTION",
        "CREATE VIEW v AS SELECT a FROM t WITH CHECK |OPTION",
        "CREATE VIEW v AS SELECT a FROM t WITH CHECK OPTION",
    ],
    [
        "CREATE PROCEDURE WITH RECOMPILE",
        "CREATE PROC p WITH RECOMPILE AS SELECT |1",
        "CREATE PROC p WITH RECOMPILE AS SELECT 1",
    ],

    // -- security -------------------------------------------------------------------------------
    [
        "GRANT",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON t TO |u\nSELECT 1",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON t TO u",
    ],
    [
        "GRANT EXECUTE",
        "GRANT EXECUTE ON SCHEMA::dbo TO |u WITH GRANT OPTION\nSELECT 1",
        "GRANT EXECUTE ON SCHEMA::dbo TO u WITH GRANT OPTION",
    ],
    ["GRANT then SELECT", "GRANT SELECT ON t TO u\nSELECT |1", "SELECT 1"],
    ["DENY", "DENY DELETE ON t TO |u\nSELECT 1", "DENY DELETE ON t TO u"],
    ["REVOKE", "REVOKE INSERT ON t FROM |u\nSELECT 1", "REVOKE INSERT ON t FROM u"],
    ["GRANT CREATE TABLE", "GRANT CREATE TABLE TO |u", "GRANT CREATE TABLE TO u"],

    // -- other statements -----------------------------------------------------------------------
    ["USE", "USE master\nSELECT |1", "SELECT 1"],
    ["PRINT", "PRINT 'a'\nPRINT |'b'", "PRINT 'b'"],
    [
        "RAISERROR WITH NOWAIT",
        "RAISERROR ('x', 0, 1) WITH NOWAIT|\nSELECT 1",
        "RAISERROR ('x', 0, 1) WITH NOWAIT",
    ],
    ["THROW", "SELECT 1;\nTHROW 50000, 'x', |1;", "THROW 50000, 'x', 1;"],
    [
        "BACKUP",
        "BACKUP DATABASE d TO DISK = 'f' WITH |INIT\nSELECT 1",
        "BACKUP DATABASE d TO DISK = 'f' WITH INIT",
    ],
    ["DBCC", "DBCC CHECKDB (d) WITH NO_INFOMSGS|\nSELECT 1", "DBCC CHECKDB (d) WITH NO_INFOMSGS"],
    [
        "BULK INSERT",
        "BULK INSERT t FROM 'f' WITH (FIRSTROW = |2)\nSELECT 1",
        "BULK INSERT t FROM 'f' WITH (FIRSTROW = 2)",
    ],
    ["KILL", "KILL |52\nSELECT 1", "KILL 52"],
    ["END CONVERSATION", "SELECT 1\nEND CONVERSATION |@h", "END CONVERSATION @h"],
    ["CHECKPOINT", "CHECKPOINT|\nSELECT 1", "CHECKPOINT"],
    ["SET option ON then DELETE", "SET NOCOUNT ON\nDELETE FROM |t", "DELETE FROM t"],
    ["SET option ON then UPDATE", "SET ANSI_NULLS ON\nUPDATE t SET a = |1", "UPDATE t SET a = 1"],
    [
        "OFFSET without FETCH then SELECT",
        "SELECT a FROM t ORDER BY a OFFSET 5 ROWS\nSELECT |2",
        "SELECT 2",
    ],
    [
        "OFFSET then FETCH from a cursor",
        "SELECT a FROM t ORDER BY a OFFSET 5 ROWS\nFETCH NEXT FROM |c",
        "FETCH NEXT FROM c",
    ],
    ["unknown statement continues the previous one", "SELECT 1\nFOO |BAR", "SELECT 1\nFOO BAR"],
];

describe("mssql getStatementAt", () => {
    it.each(cases)("%s", (_what, marked, expected) => {
        expect(at(marked)).toBe(expected);
    });

    it("is the driver's getStatementAt", () => {
        const { script, position } = withCursor("SELECT 1\nSELECT |2");
        expect(mssqlDriver.getStatementAt(script, position)).toEqual({
            start: { line: 1, column: 0 },
            end: { line: 1, column: 8 },
        });
    });

    it("reports positions relative to the whole script, after GO", () => {
        const { script, position } = withCursor("SELECT 1\nGO\n  SELECT 2;  SELECT |3\nGO");
        expect(getMssqlStatementAt(script, position)).toEqual({
            start: { line: 2, column: 13 },
            end: { line: 2, column: 21 },
        });
    });
});

describe("mssqlStatementSpans", () => {
    it("splits an SSMS script without semicolons", () => {
        const script = lines(
            "SET NOCOUNT ON",
            "DECLARE @n int = 0",
            "WHILE @n < 3",
            "BEGIN",
            "    INSERT INTO t (n) VALUES (@n)",
            "    SET @n += 1",
            "END",
            "IF @@ROWCOUNT > 0",
            "    PRINT 'done'",
            "ELSE",
            "    RAISERROR ('none', 16, 1)",
            "SELECT * FROM t",
        );
        expect(split(script)).toEqual([
            "SET NOCOUNT ON",
            "DECLARE @n int = 0",
            lines(
                "WHILE @n < 3",
                "BEGIN",
                "    INSERT INTO t (n) VALUES (@n)",
                "    SET @n += 1",
                "END",
            ),
            lines("IF @@ROWCOUNT > 0", "    PRINT 'done'", "ELSE", "    RAISERROR ('none', 16, 1)"),
            "SELECT * FROM t",
        ]);
    });

    it("keeps stray semicolons out of statements", () => {
        expect(split(";;SELECT 1;;\n;SELECT 2")).toEqual(["SELECT 1;", "SELECT 2"]);
    });

    it("never throws on unbalanced text", () => {
        for (const script of [
            "END END",
            "BEGIN",
            "(((",
            ")))",
            "IF",
            "ELSE",
            "CASE",
            "WITH",
            "BEGIN TRY",
        ]) {
            expect(() => split(script)).not.toThrow();
            expect(split(script).join(" ")).toBe(script);
        }
    });
});
