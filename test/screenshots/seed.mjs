// Makes the fixture database (test/fixtures) look like a small shop, so that the screenshots show
// realistic rows: more customers and orders, dates, a nullable note, and a products table.
// Run by scripts/screenshots.mjs on both engines; everything is deterministic.

import mssql from "mssql";
import pg from "pg";

// Customers 1 to 3 are those of the fixtures: renamed below. These are 4 onwards.
const renamed = [
    ["Alice Martin", "alice.martin@example.com"],
    ["Bob Chen", "bob.chen@example.com"],
    ["Chloé Dubois", "chloe.dubois@example.com"],
];
const customers = [
    ["Daniel Okafor", "daniel.okafor@example.com"],
    ["Elena Rossi", "elena.rossi@example.com"],
    ["Farid Haddad", "farid.haddad@example.com"],
    ["Grace Nguyen", "grace.nguyen@example.com"],
    ["Hugo Larsen", "hugo.larsen@example.com"],
    ["Ingrid Berg", "ingrid.berg@example.com"],
    ["Jamal Carter", "jamal.carter@example.com"],
    ["Karen Smith", "karen.smith@example.com"],
    ["Luca Bianchi", "luca.bianchi@example.com"],
    ["Mei Tanaka", "mei.tanaka@example.com"],
];
const customerCount = renamed.length + customers.length;

const products = [
    ["Mechanical keyboard", 89.9, true],
    ["USB-C dock", 129.0, true],
    ["27-inch monitor", 249.5, false],
    ["Desk lamp", 34.99, true],
    ["Laptop stand", 45.0, true],
    ["Noise-cancelling headset", 179.0, false],
];

const statuses = ["paid", "paid", "paid", "pending", "shipped", "paid", "cancelled", "shipped"];
const notes = [null, null, "Gift wrap", null, "Leave at the door", null, null, "Express delivery"];

const pad = (n) => String(n).padStart(2, "0");
/** "2025-09-02 14:05:00": the start (ISO, UTC) plus a number of minutes. */
function timestamp(startIso, minutes) {
    const date = new Date(Date.parse(`${startIso}Z`) + minutes * 60_000);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00`;
}

// The orders of the fixtures are 1 to 4; these are 5 onwards.
const orders = Array.from({ length: 28 }, (_, i) => ({
    customer: ((i * 7) % customerCount) + 1,
    amount: (((i * 37) % 180) + 12 + ((i * 13) % 100) / 100).toFixed(2),
    status: statuses[i % statuses.length],
    note: notes[(i * 3) % notes.length],
    orderedAt: timestamp("2025-09-02T09:15:00", i * 2150 + (i % 5) * 97),
}));
const firstOrders = [
    [1, "2025-09-01 10:12:00", null],
    [2, "2025-09-03 16:40:00", "Gift wrap"],
    [3, "2025-09-04 08:55:00", null],
    [4, "2025-09-06 19:20:00", null],
];

const quote = (value) => (value === null ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);

/** The statements, in order; the dialects only differ in what is passed in. */
function statements({ timestampType, boolTrue, boolFalse, text }) {
    const sql = [];
    sql.push(`ALTER TABLE orders ADD ordered_at ${timestampType} NULL`);
    sql.push(`ALTER TABLE orders ADD note ${text(200)} NULL`);
    renamed.forEach(([name, email], i) => {
        sql.push(
            `UPDATE customers SET name = ${quote(name)}, email = ${quote(email)} WHERE id = ${i + 1}`,
        );
    });
    sql.push(
        `INSERT INTO customers (name, email) VALUES ${customers.map(([n, e]) => `(${quote(n)}, ${quote(e)})`).join(", ")}`,
    );
    sql.push(
        `INSERT INTO orders (customer_id, amount, status, ordered_at, note) VALUES ${orders
            .map(
                (o) =>
                    `(${o.customer}, ${o.amount}, ${quote(o.status)}, ${quote(o.orderedAt)}, ${quote(o.note)})`,
            )
            .join(", ")}`,
    );
    for (const [id, at, note] of firstOrders) {
        sql.push(
            `UPDATE orders SET ordered_at = ${quote(at)}, note = ${quote(note)} WHERE id = ${id}`,
        );
    }
    for (let id = 1; id <= customerCount; id++) {
        sql.push(
            `UPDATE customers SET created_at = ${quote(timestamp("2025-01-08T11:30:00", id * 31_000 + (id % 4) * 413))} WHERE id = ${id}`,
        );
    }
    sql.push(
        `INSERT INTO products (name, price, in_stock) VALUES ${products
            .map(([n, p, s]) => `(${quote(n)}, ${p.toFixed(2)}, ${s ? boolTrue : boolFalse})`)
            .join(", ")}`,
    );
    return sql;
}

export async function seedPostgres({ host, port, user, password, database }) {
    const client = new pg.Client({ host, port, user, password, database });
    await client.connect();
    try {
        await client.query(
            "CREATE TABLE products (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, price NUMERIC(10,2) NOT NULL, in_stock BOOLEAN NOT NULL DEFAULT true)",
        );
        for (const statement of statements({
            timestampType: "TIMESTAMP",
            boolTrue: "true",
            boolFalse: "false",
            text: (n) => `VARCHAR(${n})`,
        })) {
            await client.query(statement);
        }
    } finally {
        await client.end();
    }
}

export async function seedMssql({ host, port, user, password, database }) {
    const pool = await mssql.connect({
        server: host,
        port,
        user,
        password,
        database,
        options: { trustServerCertificate: true, encrypt: true },
    });
    try {
        await pool
            .request()
            .batch(
                "CREATE TABLE products (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(100) NOT NULL, price DECIMAL(10,2) NOT NULL, in_stock BIT NOT NULL DEFAULT 1)",
            );
        // One batch each: ALTER TABLE and the statements that use the new columns cannot share one.
        for (const statement of statements({
            timestampType: "DATETIME2",
            boolTrue: "1",
            boolFalse: "0",
            text: (n) => `NVARCHAR(${n})`,
        })) {
            await pool.request().batch(statement);
        }
    } finally {
        await pool.close();
    }
}
