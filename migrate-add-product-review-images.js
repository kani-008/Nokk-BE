// Run once: node migrate-add-product-review-images.js
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
      SELECT 1 FROM information_schema.tables WHERE table_name = 'product_review_images'
    `);
    if (check.rows.length > 0) {
      console.log("✓ 'product_review_images' table already exists — skipping");
    } else {
      await client.query(`
        CREATE TABLE product_review_images (
          id          UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
          review_id   UUID NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE,
          image_url   TEXT NOT NULL,
          sort_order  INTEGER DEFAULT 0,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log("✓ 'product_review_images' table created");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => { console.error("Migration failed:", err.message); process.exit(1); });
