const db = require("../config/db.js");

// settings schema: key TEXT PK, value TEXT NOT NULL, updated_at
// Auto-cast value: "true"/"false" → boolean, numeric strings → number.
function castValue(val) {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val !== "" && !isNaN(val)) return Number(val);
  return val;
}

// ==================================================================
// PUBLIC — GET /api/settings
// Returns all settings as a flat key→value object.
// Used by: Home page (delivery thresholds, contact info, social links).
// ==================================================================
async function getSettings(req, res) {
  console.log({ route: "GET /api/settings", status: "fetching all settings" });
  try {
    const result = await db.query(`SELECT key, value FROM settings ORDER BY key ASC`);
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = castValue(r.value); });
    console.log({ route: "GET /api/settings", status: 200, count: result.rows.length });
    return res.json({ success: true, settings });
  } catch (err) {
    console.error({ route: "GET /api/settings", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/settings
// Upsert any number of key/value pairs in one call.
// Body: { websiteName: "...", flatDeliveryCharge: "50", ... }
// ==================================================================
async function updateSettings(req, res) {
  const adminId = req.user?.id;
  const keys = Object.keys(req.body);
  console.log({ route: "PUT /api/settings", adminId, keys, status: "updating settings" });

  const entries = Object.entries(req.body);
  if (entries.length === 0) {
    console.log({ route: "PUT /api/settings", adminId, status: 400, message: "No settings provided" });
    return res.status(400).json({ success: false, message: "No settings provided" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    for (const [key, value] of entries) {
      // Reject empty or suspicious keys (only allow word chars + underscore)
      if (!/^\w+$/.test(key)) continue;
      await client.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, String(value)]
      );
    }

    await client.query("COMMIT");

    // Return the full updated settings (can use pool — transaction is done)
    const result = await db.query(`SELECT key, value FROM settings ORDER BY key ASC`);
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = castValue(r.value); });
    console.log({ route: "PUT /api/settings", adminId, status: 200 });
    return res.json({ success: true, message: "Settings updated", settings });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error({ route: "PUT /api/settings", adminId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// ADMIN — GET /api/settings/:key
// Read a single setting by key.
// ==================================================================
async function getSetting(req, res) {
  const { key } = req.query;
  console.log({ route: "GET /api/settings/get-one", key, status: "fetching setting" });
  try {
    const result = await db.query(
      "SELECT key, value FROM settings WHERE key = $1", [key]
    );
    if (result.rows.length === 0) {
      console.log({ route: "GET /api/settings/get-one", key, status: 404, message: "Setting not found" });
      return res.status(404).json({ success: false, message: "Setting not found" });
    }
    console.log({ route: "GET /api/settings/get-one", key, status: 200 });
    return res.json({
      success: true,
      key: result.rows[0].key,
      value: castValue(result.rows[0].value)
    });
  } catch (err) {
    console.error({ route: "GET /api/settings/get-one", key, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getSettings, updateSettings, getSetting };