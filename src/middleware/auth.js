const jwt    = require("jsonwebtoken");

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
if (!ACCESS_TOKEN_SECRET) {
  throw new Error("FATAL: ACCESS_TOKEN_SECRET env var must be set");
}

// Verifies the Bearer access token. Used by ALL protected routes.
function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    console.log(`[auth] no token  ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ success: false, message: "Access denied: no token provided" });
  }

  // Development/Testing mock bypass mapping to real seeded DB users
  if (process.env.NODE_ENV !== "production" && (token === "dev-token" || token.startsWith("dev-token-"))) {
    const role = token === "dev-token-admin" ? "admin" : "customer";
    const devUserId = role === "admin"
      ? "9323573c-3c6a-4022-a5dc-7eb671a82c64"
      : "5cf629c4-26dd-4f8c-b357-8d5e145a8cb9";
    const devEmail = role === "admin"
      ? "kanishkar.m06@gmail.com"
      : "customer@gmail.com";

    req.user = { id: devUserId, email: devEmail, role: role };
    console.log(`[auth] Dev bypass active | user: ${req.user.id} | role: ${req.user.role}`);
    return next();
  }

  try {
    req.user = jwt.verify(token, ACCESS_TOKEN_SECRET);
    console.log("Token verified | user:", req.user.id, "role:", req.user.role);
    next();
  } catch (err) {
    console.error(`[auth] token rejected  ${req.method} ${req.originalUrl} | ${err.message}`);
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

// Admin guard — must run AFTER verifyToken.
function isAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    console.log(`[auth] not admin  ${req.method} ${req.originalUrl} | role="${req.user?.role}"`);
    return res.status(403).json({ success: false, message: "Access denied: admin privileges required" });
  }
  next();
}

// Support BOTH import styles used across the project:
//   const { verifyToken, isAdmin } = require("../middleware/auth");   <- Antigravity IDE style
//   const authenticate = require("../middleware/auth");               <- loginRoute style
module.exports = verifyToken;           // default export (authenticate alias)
module.exports.verifyToken = verifyToken;
module.exports.isAdmin = isAdmin;
module.exports.authenticate = verifyToken;  // alias used in loginRoute