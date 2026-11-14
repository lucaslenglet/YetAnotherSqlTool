CREATE TABLE customers (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  email      VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE orders (
  id          SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  amount      NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending'
);
INSERT INTO customers (name, email) VALUES
  ('Alice', 'alice@example.com'), ('Bob', 'bob@example.com'), ('Chloé', 'chloe@example.com');
INSERT INTO orders (customer_id, amount, status) VALUES
  (1, 42.50, 'paid'), (1, 13.00, 'pending'), (2, 99.99, 'paid'), (3, 7.25, 'cancelled');
