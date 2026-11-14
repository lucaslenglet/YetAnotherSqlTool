-- The latest orders, with their customer
SELECT o.id,
       c.name AS customer,
       o.amount,
       o.status,
       o.ordered_at,
       o.amount > 50 AS is_large,
       o.note
FROM orders AS o
JOIN customers AS c ON c.id = o.customer_id
ORDER BY o.ordered_at DESC
LIMIT 20;
