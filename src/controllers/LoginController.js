const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const db     = require("../config/db.js");
const logger = require("../utils/logger.js");

// ------------------------------------------------------------------
// Config (read from .env — see notes for the variables to add)
// ------------------------------------------------------------------
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "dev_access_secret_change_me";
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || "dev_refresh_secret_change_me";
const ACCESS_TOKEN_TTL = "15m";          // short-lived access token
const REFRESH_TOKEN_TTL_DAYS = 7;        // long-lived refresh token

// ------------------------------------------------------------------
// Small inline validators
// ------------------------------------------------------------------
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isEmail(v) {
  return typeof v === "string" && EMAIL_REGEX.test(v.trim());
}
// Login uses ONE field: email or phone. Lowercase emails to match storage.
function normalizeIdentifier(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return isEmail(s) ? s.toLowerCase() : s;
}
function validatePassword(p) {
  if (typeof p !== "string" || p.length < 8) return "Password must be at least 8 characters";
  if (p.length > 128) return "Password is too long";
  return null;
}

// ------------------------------------------------------------------
// Token + response helpers
// ------------------------------------------------------------------
function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    ACCESS_TOKEN_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}
function signRefreshToken(user) {
  return jwt.sign({ id: user.id, type: "refresh" }, REFRESH_TOKEN_SECRET, {
    expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d`
  });
}
function publicUser(u) {
  return { id: u.id, email: u.email, phone: u.phone, name: u.full_name, role: u.role, status: u.status };
}

// ------------------------------------------------------------------
// SMS (inline). Right now it only logs to the console so you can read the
// OTP while developing. Plug a provider (MSG91 / Fast2SMS / Twilio) here later.
// ------------------------------------------------------------------
async function sendSms(phone, message) {
  logger.sms(`-> ${phone} | ${message}`);
  return true;
}

// Generate a 5-digit OTP from a cryptographically strong source.
// Leading zeros are kept (e.g. "04821") so it's always 5 digits.
function generateOtp() {
  return String(crypto.randomInt(0, 100000)).padStart(5, "0");
}

// ==================================================================
// POST /user-login   -> getlogin
// Body: { identifier, password }  (identifier = email OR phone)
// Returns access + refresh tokens.
// ==================================================================
async function getlogin(req, res) {
  const rawId = req.body.identifier ?? req.body.email ?? req.body.phone ?? req.body.login;
  const password = req.body.password;

  if (!rawId || !password) {
    return res.status(400).json({ success: false, message: "Email/phone and password are required" });
  }

  const identifier = normalizeIdentifier(rawId);

  try {
    const result = await db.query(
      "SELECT * FROM users WHERE email = $1 OR phone = $1 LIMIT 1",
      [identifier]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const user = result.rows[0];
    if (user.status === "blocked") {
      return res.status(403).json({ success: false, message: "This account has been blocked. Please contact support." });
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    // Store the refresh token so we can validate it on /refresh-token and revoke it on /logout.
    await db.query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, refreshToken, expiresAt]
    );

    return res.json({
      success: true,
      message: "Signed in successfully",
      accessToken,
      refreshToken,
      user: publicUser(user)
    });
  } catch (err) {
    logger.error("Login error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /refresh-token   -> refreshAccessToken
// Body: { refreshToken }
// Validates the stored refresh token and issues a fresh access token.
// ==================================================================
async function refreshAccessToken(req, res) {
  const refreshToken = req.body.refreshToken;
  if (!refreshToken) {
    return res.status(400).json({ success: false, message: "refreshToken is required" });
  }

  try {
    // Must exist in DB and still be valid.
    const stored = await db.query(
      "SELECT id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()",
      [refreshToken]
    );
    if (stored.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
    }

    let payload;
    try {
      payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
      logger.debug("Refresh token payload:", payload);
    } catch (e) {
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
    }

    const userRes = await db.query(
      "SELECT id, email, phone, full_name, role, status FROM users WHERE id = $1",
      [payload.id]
    );
    if (userRes.rows.length === 0) {
      return res.status(401).json({ success: false, message: "User no longer exists" });
    }

    const user = userRes.rows[0];
    if (user.status === "blocked") {
      return res.status(403).json({ success: false, message: "Account blocked" });
    }

    const accessToken = signAccessToken(user);
    return res.json({ success: true, accessToken });
  } catch (err) {
    logger.error("Refresh error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /logout   -> logout   (protected by authenticate middleware)
// Body: { refreshToken? }
// With a refreshToken: revoke that one session. Without: revoke all.
// ==================================================================
async function logout(req, res) {
  const refreshToken = req.body.refreshToken;
  try {
    if (refreshToken) {
      await db.query(
        "DELETE FROM refresh_tokens WHERE token = $1 AND user_id = $2",
        [refreshToken, req.user.id]
      );
    } else {
      await db.query("DELETE FROM refresh_tokens WHERE user_id = $1", [req.user.id]);
    }
    return res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    logger.error("Logout error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /otp-create   -> otpgenerate
// Body: { phone }
// Generates a 5-digit OTP, stores it, and (SIMPLE/DEV MODE) returns it
// to the frontend so you can test without an SMS gateway.
// ==================================================================
async function otpgenerate(req, res) {
  const phone = req.body.phone ? String(req.body.phone).trim() : "";
  if (!phone) {
    return res.status(400).json({ success: false, message: "phone is required" });
  }

  try {
    const userRes = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "No account found with this phone number" });
    }
    const user = userRes.rows[0];

    // Invalidate any earlier unused OTPs so only the newest works.
    await db.query(
      "UPDATE otp_verifications SET verified = TRUE WHERE user_id = $1 AND verified = FALSE",
      [user.id]
    );

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await db.query(
      "INSERT INTO otp_verifications (user_id, phone, otp_code, expires_at) VALUES ($1, $2, $3, $4)",
      [user.id, phone, otp, expiresAt]
    );

    await sendSms(phone, `Your OTP is ${otp}. It expires in 10 minutes.`);

    // SIMPLE/DEV MODE: send the OTP back to the frontend (no SMS gateway yet).
    // >>> In production, DELETE `otp` from this response so it isn't exposed. <<<
    return res.json({ success: true, message: "OTP sent", otp });
  } catch (err) {
    logger.error("OTP create error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /otp-verify   -> otpverify
// Body: { phone, otp }
// Marks the OTP verified so the user may then set a new password.
// ==================================================================
async function otpverify(req, res) {
  const phone = req.body.phone ? String(req.body.phone).trim() : "";
  const otp = req.body.otp ? String(req.body.otp).trim() : "";

  if (!phone || !otp) {
    return res.status(400).json({ success: false, message: "phone and otp are required" });
  }

  try {
    const userRes = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (userRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }
    const user = userRes.rows[0];

    const otpRes = await db.query(
      `SELECT id FROM otp_verifications
       WHERE user_id = $1 AND phone = $2 AND otp_code = $3
         AND verified = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, phone, otp]
    );
    if (otpRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }

    await db.query("UPDATE otp_verifications SET verified = TRUE WHERE id = $1", [otpRes.rows[0].id]);
    return res.json({ success: true, message: "OTP verified. You can now set a new password." });
  } catch (err) {
    logger.error("OTP verify error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /reset-password   -> setpassword
// Body: { phone, newPassword }
// Requires a recently VERIFIED, still-valid OTP for the phone.
// ==================================================================
async function setpassword(req, res) {
  const phone = req.body.phone ? String(req.body.phone).trim() : "";
  const newPassword = req.body.newPassword ?? req.body.password;

  if (!phone || !newPassword) {
    return res.status(400).json({ success: false, message: "phone and newPassword are required" });
  }
  const pwErr = validatePassword(newPassword);
  if (pwErr) {
    return res.status(400).json({ success: false, message: pwErr });
  }

  try {
    const userRes = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (userRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid request" });
    }
    const user = userRes.rows[0];

    // There must be a verified, still-valid OTP (from /otp-verify).
    const otpRes = await db.query(
      `SELECT id FROM otp_verifications
       WHERE user_id = $1 AND phone = $2 AND verified = TRUE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, phone]
    );
    if (otpRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: "Please verify the OTP first" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.query(
      "UPDATE users SET password_hash = $1, phone_verified = TRUE WHERE id = $2",
      [passwordHash, user.id]
    );

    // Consume the OTP so it can't be reused.
    await db.query("DELETE FROM otp_verifications WHERE id = $1", [otpRes.rows[0].id]);
    // Log out all existing sessions after a password change (best practice).
    await db.query("DELETE FROM refresh_tokens WHERE user_id = $1", [user.id]);

    return res.json({ success: true, message: "Password reset successfully. Please log in." });
  } catch (err) {
    logger.error("Set password error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getlogin,
  otpgenerate,
  otpverify,
  setpassword,
  refreshAccessToken,
  logout
};