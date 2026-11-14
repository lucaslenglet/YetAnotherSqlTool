-- Run by test/vscode/queries.e2e.ts against the tables of test/fixtures/postgres.
SELECT name, email FROM customers ORDER BY id;
