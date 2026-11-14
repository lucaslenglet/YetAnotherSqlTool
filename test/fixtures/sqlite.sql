PRAGMA foreign_keys = ON;
CREATE TABLE customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount      REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
);
INSERT INTO customers (name, email) VALUES
  ('Alice', 'alice@example.com'), ('Bob', 'bob@example.com'), ('Chloé', 'chloe@example.com');
INSERT INTO orders (customer_id, amount, status) VALUES
  (1, 42.50, 'paid'), (1, 13.00, 'pending'), (2, 99.99, 'paid'), (3, 7.25, 'cancelled');
