const db = require("../config/db.js");
const { invalidateMaintenanceCache } = require("../middleware/maintenance.js");

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

  // Validation for known numeric settings
  for (const [key, value] of entries) {
    if (key === "shippingCharge") {
      const numVal = Number(value);
      if (isNaN(numVal) || numVal <= 0) {
        return res.status(400).json({ success: false, message: "Standard Delivery Fee (shippingCharge) must be greater than 0" });
      }
    }
    if (key === "freeShippingThreshold") {
      const numVal = Number(value);
      if (isNaN(numVal) || numVal < 0) {
        return res.status(400).json({ success: false, message: "Free Shipping Above (freeShippingThreshold) cannot be negative" });
      }
    }
    if (key === "minOrderValue") {
      const numVal = Number(value);
      if (isNaN(numVal) || numVal < 0) {
        return res.status(400).json({ success: false, message: "Minimum Order Value (minOrderValue) cannot be negative" });
      }
    }
    if (key === "maxCartItems") {
      const numVal = Number(value);
      if (isNaN(numVal) || !Number.isInteger(numVal) || numVal < 1) {
        return res.status(400).json({ success: false, message: "Max Items per Cart (maxCartItems) must be an integer greater than or equal to 1" });
      }
    }
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

    // Flush the in-process maintenance mode cache so changes take effect immediately
    invalidateMaintenanceCache();

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

// ==================================================================
// PUBLIC — GET /api/settings/get-public?key=<key>
// Exposes a small allowlist of settings to unauthenticated callers.
// Currently used by the frontend to fetch razorpayKeyId for the
// Razorpay Checkout widget. The key SECRET is never in this list.
// ==================================================================
const PUBLIC_SETTING_ALLOWLIST = ["razorpayKeyId"];

async function getPublicSetting(req, res) {
  const { key } = req.query;
  if (!key || !PUBLIC_SETTING_ALLOWLIST.includes(key)) {
    return res.status(403).json({ success: false, message: "This setting is not publicly accessible" });
  }
  try {
    const result = await db.query(
      "SELECT key, value FROM settings WHERE key = $1", [key]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Setting not found" });
    }
    return res.json({
      success: true,
      key:   result.rows[0].key,
      value: castValue(result.rows[0].value),
    });
  } catch (err) {
    console.error({ route: "GET /api/settings/get-public", key, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getSettings, updateSettings, getSetting, getPublicSetting };