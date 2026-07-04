require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  try {
    console.log("Starting combo_images migration...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS combo_images (
        id SERIAL PRIMARY KEY,
        combo_id UUID NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        is_primary BOOLEAN DEFAULT FALSE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("✓ combo_images table created (or already exists)");

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_combo_images_combo_id ON combo_images(combo_id)
    `);
    console.log("✓ index idx_combo_images_combo_id created (or already exists)");

    console.log("Migration complete!");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
