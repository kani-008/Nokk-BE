const jwt  = require("jsonwebtoken");
const db   = require("../config/db");

const ACCESS_TOKEN_SECRET  = process.env.ACCESS_TOKEN_SECRET  || "dev_access_secret_change_me";
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || "dev_refresh_secret_change_me";
const ACCESS_TOKEN_EXPIRY  = "15m";
const REFRESH_TOKEN_TTL_DAYS = 30;

if (!process.env.ACCESS_TOKEN_SECRET || !process.env.REFRESH_TOKEN_SECRET) {
  console.warn("[jwtToken] WARNING: Using default JWT secrets — set ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET in .env");
}

// ── Sign ────────────────────────────────────────────────────────────
function signAccessToken(payload) {
  return jwt.sign(payload, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` });
}

// ── Verify ──────────────────────────────────────────────────────────
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, ACCESS_TOKEN_SECRET);
  } catch (err) {
    const error = new Error("Invalid access token");
    error.name  = err.name;   // TokenExpiredError | JsonWebTokenError
    throw error;
  }
}

function verifyRefreshTokenSignature(token) {
  try {
    return jwt.verify(token, REFRESH_TOKEN_SECRET);
  } catch (err) {
    const error = new Error("Invalid refresh token");
    error.name  = err.name;
    throw error;
  }
}

// ── refresh_tokens table helpers ────────────────────────────────────

// Revoke all active refresh tokens for a user (call before issuing a new one).
async function invalidateRefreshTokens(userId) {
  await db.query(
    "DELETE FROM refresh_tokens WHERE user_id = $1",
    [userId]
  );
}

// Store a new refresh token in the DB (invalidates previous ones first).
async function createRefreshSession({ userId, refreshToken }) {
  await invalidateRefreshTokens(userId);

  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.query(
    "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
    [userId, refreshToken, expiresAt]
  );
}

// Validate a refresh token against the DB — returns the stored row or null.
async function verifyRefreshToken(refreshToken) {
  const res = await db.query(
    "SELECT id, user_id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()",
    [refreshToken]
  );
  return res.rows[0] || null;
}

// Delete a single refresh token (logout one session).
async function revokeRefreshToken(refreshToken, userId) {
  await db.query(
    "DELETE FROM refresh_tokens WHERE token = $1 AND user_id = $2",
    [refreshToken, userId]
  );
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshTokenSignature,
  createRefreshSession,
  verifyRefreshToken,
  invalidateRefreshTokens,
  revokeRefreshToken,
};
