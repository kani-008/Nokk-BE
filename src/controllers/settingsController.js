const db     = require("../config/db.js");
const logger = require("../utils/logger.js");

// settings schema: key TEXT PK, value TEXT NOT NULL, updated_at
// Auto-cast value: "true"/"false" → boolean, numeric strings → number.
function castValue(val) {
  if (val === "true")  return true;
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
  try {
    const result = await db.query(`SELECT key, value FROM settings ORDER BY key ASC`);
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = castValue(r.value); });
    return res.json({ success: true, settings });
  } catch (err) {
    logger.error("Get settings error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/settings
// Upsert any number of key/value pairs in one call.
// Body: { websiteName: "...", flatDeliveryCharge: "50", ... }
// ==================================================================
async function updateSettings(req, res) {
  const entries = Object.entries(req.body);
  if (entries.length === 0) {
    return res.status(400).json({ success: false, message: "No settings provided" });
  }

  try {
    await db.query("BEGIN");

    for (const [key, value] of entries) {
      // Reject empty or suspicious keys (only allow word chars + underscore)
      if (!/^\w+$/.test(key)) continue;
      await db.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, String(value)]
      );
    }

    await db.query("COMMIT");

    // Return the full updated settings
    const result = await db.query(`SELECT key, value FROM settings ORDER BY key ASC`);
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = castValue(r.value); });
    return res.json({ success: true, message: "Settings updated", settings });
  } catch (err) {
    await db.query("ROLLBACK");
    logger.error("Update settings error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/settings/:key
// Read a single setting by key.
// ==================================================================
async function getSetting(req, res) {
  try {
    const result = await db.query(
      "SELECT key, value FROM settings WHERE key = $1", [req.params.key]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Setting not found" });
    }
    return res.json({
      success: true,
      key:   result.rows[0].key,
      value: castValue(result.rows[0].value)
    });
  } catch (err) {
    logger.error("Get setting error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getSettings, updateSettings, getSetting };