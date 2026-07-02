// Run once: node migrate-add-shipping-taluk.js
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
      WHERE table_name = 'orders' AND column_name = 'shipping_taluk'
    `);
    if (check.rows.length > 0) {
      console.log("✓ 'shipping_taluk' column already exists on orders — skipping");
    } else {
      await client.query(`ALTER TABLE orders ADD COLUMN shipping_taluk TEXT`);
      console.log("✓ 'shipping_taluk' column added to orders");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => { console.error("Migration failed:", err.message); process.exit(1); });
