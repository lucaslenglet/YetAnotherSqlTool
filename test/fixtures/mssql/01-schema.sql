IF DB_ID('yast') IS NULL CREATE DATABASE yast;
GO
USE yast;
GO
IF OBJECT_ID('dbo.orders') IS NULL AND OBJECT_ID('dbo.customers') IS NULL
BEGIN
  CREATE TABLE customers (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    -- Nullable, unlike in the other engines' fixtures: docs/reference/mssql-object-explorer-tree.json
    -- was captured on a database where it was, and the Object Explorer test compares with it.
    name       NVARCHAR(100) NULL,
    email      NVARCHAR(255) NOT NULL UNIQUE,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE TABLE orders (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id),
    amount      DECIMAL(10,2) NOT NULL,
    status      NVARCHAR(20) NOT NULL DEFAULT 'pending'
  );
  INSERT INTO customers (name, email) VALUES
    ('Alice', 'alice@example.com'), ('Bob', 'bob@example.com'), ('Chloé', 'chloe@example.com');
  INSERT INTO orders (customer_id, amount, status) VALUES
    (1, 42.50, 'paid'), (1, 13.00, 'pending'), (2, 99.99, 'paid'), (3, 7.25, 'cancelled');
END
GO
