const jwt = require("jsonwebtoken");

// Must match ACCESS_TOKEN_SECRET used in the login controller.
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "dev_access_secret_change_me";

// Default export: verifies the access token on protected routes.
// Usage in routes:  const authenticate = require("../middleware/auth.js");
function authenticate(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // "Bearer TOKEN"

  if (!token) {
    return res.status(401).json({ success: false, message: "Access denied: no token provided" });
  }

  try {
    req.user = jwt.verify(token, ACCESS_TOKEN_SECRET);
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: "Invalid or expired token" });
  }
}

// Admin guard — run AFTER authenticate.
// Usage:  const { isAdmin } = require("../middleware/auth.js");
function isAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Access denied: admin privileges required" });
  }
  next();
}

module.exports = authenticate;       // default export = the authenticate function
module.exports.isAdmin = isAdmin;    // also available: require("../middleware/auth.js").isAdmin