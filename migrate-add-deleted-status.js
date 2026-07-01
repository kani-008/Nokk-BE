// Run once: node migrate-add-deleted-status.js
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  try {
    // ADD VALUE is non-transactional in PostgreSQL — must be run outside a transaction block
    // Check if 'deleted' already exists before adding
    const check = await client.query(`
      SELECT 1 FROM pg_enum
      WHERE enumlabel = 'deleted'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_status')
    `);
    if (check.rows.length > 0) {
      console.log("✓ 'deleted' enum value already exists — skipping");
    } else {
      await client.query(`ALTER TYPE user_status ADD VALUE 'deleted'`);
      console.log("✓ 'deleted' enum value added to user_status");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => { console.error("Migration failed:", err.message); process.exit(1); });
