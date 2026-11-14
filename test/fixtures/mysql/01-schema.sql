CREATE TABLE customers (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  email      VARCHAR(255) NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE orders (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
INSERT INTO customers (name, email) VALUES
  ('Alice', 'alice@example.com'), ('Bob', 'bob@example.com'), ('Chloé', 'chloe@example.com');
INSERT INTO orders (customer_id, amount, status) VALUES
  (1, 42.50, 'paid'), (1, 13.00, 'pending'), (2, 99.99, 'paid'), (3, 7.25, 'cancelled');
