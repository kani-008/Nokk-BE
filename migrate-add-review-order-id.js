// Run once: node migrate-add-review-order-id.js
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  try {
    const check = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'product_reviews' AND column_name = 'order_id'
    `);
    if (check.rows.length > 0) {
      console.log("✓ 'order_id' column already exists on product_reviews — skipping");
    } else {
      await client.query(`
        ALTER TABLE product_reviews
        ADD COLUMN order_id TEXT REFERENCES orders(id)
      `);
      console.log("✓ 'order_id' column added to product_reviews (FK -> orders.id)");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => { console.error("Migration failed:", err.message); process.exit(1); });
