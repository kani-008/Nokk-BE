// Run once: node migrate-sync-offers-banners.js
require("dotenv").config();
const { Pool } = require("pg");

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

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Add show_as_banner to offers if not exists
    if (await columnExists(client, "offers", "show_as_banner")) {
      console.log("✓ 'show_as_banner' column already exists in offers");
    } else {
      await client.query("ALTER TABLE offers ADD COLUMN show_as_banner BOOLEAN DEFAULT FALSE");
      console.log("✓ 'show_as_banner' column added to offers table");
    }

    // 2. Add show_in_announcement to offers if not exists
    if (await columnExists(client, "offers", "show_in_announcement")) {
      console.log("✓ 'show_in_announcement' column already exists in offers");
    } else {
      await client.query("ALTER TABLE offers ADD COLUMN show_in_announcement BOOLEAN DEFAULT FALSE");
      console.log("✓ 'show_in_announcement' column added to offers table");
    }

    // 3. Add linked_offer_id to banners if not exists
    if (await columnExists(client, "banners", "linked_offer_id")) {
      console.log("✓ 'linked_offer_id' column already exists in banners");
    } else {
      await client.query("ALTER TABLE banners ADD COLUMN linked_offer_id UUID REFERENCES offers(id) ON DELETE CASCADE");
      console.log("✓ 'linked_offer_id' column added to banners table referencing offers.id (ON DELETE CASCADE)");
    }

    // 4. Ensure announcement_offer_owner key exists in settings
    const settingsOwnerExists = await client.query(
      "SELECT 1 FROM settings WHERE key = 'announcement_offer_owner'"
    );
    if (settingsOwnerExists.rows.length > 0) {
      console.log("✓ 'announcement_offer_owner' key already exists in settings");
    } else {
      await client.query(
        "INSERT INTO settings (key, value, updated_at) VALUES ('announcement_offer_owner', '', NOW())"
      );
      console.log("✓ 'announcement_offer_owner' key inserted into settings");
    }

    await client.query("COMMIT");
    console.log("✓ Migration completed successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Fatal: Migration execution crashed:", err.message);
  process.exit(1);
});
