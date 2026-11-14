-- Best customers by revenue, cancelled orders excluded
SELECT TOP 8
    c.name,
    c.email,
    COUNT(o.id)   AS orders,
    SUM(o.amount) AS total_spent
FROM customers AS c
JOIN orders AS o ON o.customer_id = c.id
WHERE o.status <> 'cancelled'
GROUP BY c.name, c.email
ORDER BY total_spent DESC;
