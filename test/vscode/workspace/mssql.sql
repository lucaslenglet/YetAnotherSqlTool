-- Run by test/vscode/queries.e2e.ts against the tables of test/fixtures/mssql.
SELECT name, email FROM customers ORDER BY id;
PRINT 'printed by the smoke test';
