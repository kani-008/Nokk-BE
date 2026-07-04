// Run once: node migrate-add-offers-combos.js
require("dotenv").config();
const { Pool } = require("pg");
const { OFFER_MATCH_LATERAL_SQL } = require("./src/config/offerMatching.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function columnExists(client, table, column) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return res.rows.length > 0;
}

async function tableExists(client, table) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
    [table]
  );
  return res.rows.length > 0;
}

async function run() {
  const client = await pool.connect();
  try {
    // ── 1. offers.code — no longer used, coupons own the code-based flow ──
    if (await columnExists(client, "offers", "code")) {
      await client.query(`ALTER TABLE offers DROP COLUMN code`);
      console.log("✓ 'code' column dropped from offers");
    } else {
      console.log("✓ 'code' column already absent from offers — skipping");
    }

    // ── 2. combos table ──────────────────────────────────────────────
    if (await tableExists(client, "combos")) {
      console.log("✓ 'combos' table already exists — skipping");
    } else {
      await client.query(`
        CREATE TABLE combos (
          id          UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
          name        TEXT NOT NULL,
          description TEXT,
          image_url   TEXT,
          combo_price NUMERIC(10,2) NOT NULL,
          is_active   BOOLEAN DEFAULT TRUE,
          start_date  TIMESTAMPTZ,
          end_date    TIMESTAMPTZ,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          updated_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log("✓ 'combos' table created");
    }

    // ── 3. combo_items table + index ─────────────────────────────────
    if (await tableExists(client, "combo_items")) {
      console.log("✓ 'combo_items' table already exists — skipping");
    } else {
      await client.query(`
        CREATE TABLE combo_items (
          id          UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
          combo_id    UUID NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
          product_id  UUID REFERENCES products(id),
          variant_id  UUID REFERENCES product_variants(id),
          quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
          created_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log("✓ 'combo_items' table created");
    }
    await client.query(`CREATE INDEX IF NOT EXISTS idx_combo_items_combo_id ON combo_items(combo_id)`);
    console.log("✓ index on combo_items(combo_id) ensured");

    // ── 4. cart_items.combo_id ───────────────────────────────────────
    if (await columnExists(client, "cart_items", "combo_id")) {
      console.log("✓ 'combo_id' already exists on cart_items — skipping");
    } else {
      await client.query(`ALTER TABLE cart_items ADD COLUMN combo_id UUID REFERENCES combos(id)`);
      console.log("✓ 'combo_id' column added to cart_items");
    }

    // ── 4b. order_items.combo_id / combo_name ────────────────────────
    if (await columnExists(client, "order_items", "combo_id")) {
      console.log("✓ 'combo_id' already exists on order_items — skipping");
    } else {
      await client.query(`ALTER TABLE order_items ADD COLUMN combo_id UUID REFERENCES combos(id)`);
      console.log("✓ 'combo_id' column added to order_items");
    }
    if (await columnExists(client, "order_items", "combo_name")) {
      console.log("✓ 'combo_name' already exists on order_items — skipping");
    } else {
      await client.query(`ALTER TABLE order_items ADD COLUMN combo_name TEXT`);
      console.log("✓ 'combo_name' column added to order_items");
    }

    // ── 5. orders.combo_discount / store_wide_discount ───────────────
    if (await columnExists(client, "orders", "combo_discount")) {
      console.log("✓ 'combo_discount' already exists on orders — skipping");
    } else {
      await client.query(`ALTER TABLE orders ADD COLUMN combo_discount NUMERIC(10,2) NOT NULL DEFAULT 0`);
      console.log("✓ 'combo_discount' column added to orders");
    }
    if (await columnExists(client, "orders", "store_wide_discount")) {
      console.log("✓ 'store_wide_discount' already exists on orders — skipping");
    } else {
      await client.query(`ALTER TABLE orders ADD COLUMN store_wide_discount NUMERIC(10,2) NOT NULL DEFAULT 0`);
      console.log("✓ 'store_wide_discount' column added to orders");
    }

    // ── 6. Recreate v_products_with_price with offer-matching columns ─
    // Existing SELECT list captured verbatim from the live DB (pg_get_viewdef)
    // — every pre-existing column unchanged — plus 5 new offer-derived columns.
    await client.query(`DROP VIEW IF EXISTS v_products_with_price`);
    await client.query(`
      CREATE VIEW v_products_with_price AS
      SELECT
        p.id,
        p.name_en,
        p.name_ta,
        p.slug,
        p.description,
        p.how_to_use,
        p.storage_tips,
        p.is_bestseller,
        p.is_new,
        p.is_active,
        p.category_id,
        c.name_en AS category_name,
        c.slug AS category_slug,
        p.created_at,
        p.updated_at,
        pi.image_url AS primary_image,
        COALESCE(v.min_price, 0) AS min_price,
        COALESCE(v.min_compare_price, 0) AS min_compare_price,
        COALESCE(v.total_stock, 0) AS total_stock,
        COALESCE(r.avg_rating, 0) AS avg_rating,
        COALESCE(r.review_count, 0) AS review_count,
        ao.id AS active_offer_id,
        ao.offer_type AS active_offer_type,
        ao.discount_value AS active_offer_discount_value,
        ao.max_discount AS active_offer_max_discount,
        CASE
          WHEN ao.id IS NULL THEN COALESCE(v.min_price, 0)
          WHEN ao.offer_type = 'percentage' THEN GREATEST(
            COALESCE(v.min_price, 0) - LEAST(
              COALESCE(v.min_price, 0) * ao.discount_value / 100,
              COALESCE(ao.max_discount, COALESCE(v.min_price, 0) * ao.discount_value / 100)
            ),
            0
          )
          WHEN ao.offer_type = 'flat' THEN GREATEST(COALESCE(v.min_price, 0) - ao.discount_value, 0)
          ELSE COALESCE(v.min_price, 0)
        END AS effective_min_price
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = TRUE
      LEFT JOIN (
        SELECT
          product_id,
          MIN(price) AS min_price,
          MIN(compare_price) AS min_compare_price,
          SUM(stock_qty) AS total_stock
        FROM product_variants
        WHERE is_active = TRUE
        GROUP BY product_id
      ) v ON v.product_id = p.id
      LEFT JOIN (
        SELECT
          product_id,
          AVG(rating) AS avg_rating,
          COUNT(id) AS review_count
        FROM product_reviews
        WHERE is_approved = TRUE
        GROUP BY product_id
      ) r ON r.product_id = p.id
      ${OFFER_MATCH_LATERAL_SQL}
    `);
    console.log("✓ v_products_with_price recreated with offer-matching columns");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => { console.error("Migration failed:", err.message); process.exit(1); });
