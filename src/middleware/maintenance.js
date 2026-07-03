const db = require("../config/db.js");

// Simple in-process cache so we don't hit the DB on every request.
// TTL: 30 seconds — fast enough for the admin to see maintenance mode take effect,
// slow enough to not add DB load.
let _cache = null;
let _cacheAt = 0;
const TTL_MS = 30_000;

async function getMaintenanceMode() {
  if (_cache !== null && Date.now() - _cacheAt < TTL_MS) return _cache;
  try {
    const res = await db.query("SELECT value FROM settings WHERE key = 'maintenanceMode'");
    _cache = res.rows.length > 0 && res.rows[0].value === "true";
    _cacheAt = Date.now();
  } catch {
    _cache = false; // fail-open: don't accidentally lock everyone out
  }
  return _cache;
}

// Call this when the admin saves settings so the cache flushes immediately.
function invalidateMaintenanceCache() {
  _cache = null;
}

// Express middleware — blocks non-admin customer API calls when maintenance mode is on.
// Safe routes that must always work (auth flow, settings read, sitemap) are excluded.
async function maintenanceGuard(req, res, next) {
  // Always pass-through: settings read (the frontend reads this to show the maintenance page),
  // auth routes (so the admin can still log in), and sitemap.
  const alwaysOpen = [
    "/api/settings/get-all",
    "/api/settings/get-public",
    "/api/auth/",
    "/sitemap.xml",
    "/health",
  ];
  if (alwaysOpen.some((p) => req.path === p || req.originalUrl.startsWith(p))) {
    return next();
  }

  const on = await getMaintenanceMode();
  if (!on) return next();

  // Admins can still use all endpoints during maintenance
  if (req.user?.role === "admin") return next();

  return res.status(503).json({
    success: false,
    message: "We're undergoing maintenance. Please try again shortly.",
  });
}

module.exports = { maintenanceGuard, invalidateMaintenanceCache };
