const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/db.js");
const twilio = require("twilio");

const log = (data) => console.log(data);
const lerr = (data) => console.error(data);

// ------------------------------------------------------------------
// Config (read from .env)
// ------------------------------------------------------------------
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
  throw new Error("FATAL: ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET env vars must be set");
}
const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_DAYS = 7;

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
  if (typeof p !== "string" || p.length < 6) return "Password must be at least 6 characters";
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
// Twilio Verify — handles OTP generation, delivery, and checking
// ------------------------------------------------------------------
const twilioClient = require("twilio")(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const VERIFY_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

// Convert any Indian phone format to E.164 (+91XXXXXXXXXX)
function toE164(phone) {
  return `+91${phone.replace(/\D/g, "").slice(-10)}`;
}

// ==================================================================
// POST /user-login   -> getlogin
// Body: { identifier, password }  (identifier = email OR phone)
// Returns access + refresh tokens.
// ==================================================================
async function getlogin(req, res) {
  const rawId = req.body.identifier ?? req.body.email ?? req.body.phone ?? req.body.login;
  const password = req.body.password;
  log({ route: "POST /user-login", identifier: normalizeIdentifier(rawId), status: "logging in" });

  if (!rawId || !password) {
    log({ route: "POST /user-login", status: 400, message: "Email/phone and password are required" });
    return res.status(400).json({ success: false, message: "Email/phone and password are required" });
  }

  const identifier = normalizeIdentifier(rawId);

  try {
    const result = await db.query(
      "SELECT * FROM users WHERE email = $1 OR phone = $1 LIMIT 1",
      [identifier]
    );
    if (result.rows.length === 0) {
      log({ route: "POST /user-login", identifier, status: 401, message: "Invalid credentials" });
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const user = result.rows[0];
    if (user.status === "blocked") {
      log({ route: "POST /user-login", identifier, status: 403, message: "Account blocked" });
      return res.status(403).json({ success: false, message: "This account has been blocked. Please contact support." });
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      log({ route: "POST /user-login", identifier, status: 401, message: "Invalid credentials" });
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

    log({ route: "POST /user-login", identifier, userId: user.id, status: 200 });
    return res.json({
      success: true,
      message: "Signed in successfully",
      accessToken,
      refreshToken,
      user: publicUser(user)
    });
  } catch (err) {
    lerr({ route: "POST /user-login", identifier, status: 500, error: err.message });
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
  log({ route: "POST /refresh-token", status: "refreshing access token" });
  if (!refreshToken) {
    log({ route: "POST /refresh-token", status: 400, message: "refreshToken is required" });
    return res.status(400).json({ success: false, message: "refreshToken is required" });
  }

  try {
    // Must exist in DB and still be valid.
    const stored = await db.query(
      "SELECT id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()",
      [refreshToken]
    );
    if (stored.rows.length === 0) {
      log({ route: "POST /refresh-token", status: 401, message: "Invalid or expired refresh token" });
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
    }

    let payload;
    try {
      payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
      log({ message: "Refresh token payload", payload });
    } catch (e) {
      log({ route: "POST /refresh-token", status: 401, message: "jwt verification failed" });
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
    }

    const userRes = await db.query(
      "SELECT id, email, phone, full_name, role, status FROM users WHERE id = $1",
      [payload.id]
    );
    if (userRes.rows.length === 0) {
      log({ route: "POST /refresh-token", userId: payload.id, status: 401, message: "User no longer exists" });
      return res.status(401).json({ success: false, message: "User no longer exists" });
    }

    const user = userRes.rows[0];
    if (user.status === "blocked") {
      log({ route: "POST /refresh-token", userId: user.id, status: 403, message: "Account blocked" });
      return res.status(403).json({ success: false, message: "Account blocked" });
    }

    const accessToken = signAccessToken(user);
    log({ route: "POST /refresh-token", userId: user.id, status: 200 });
    return res.json({ success: true, accessToken });
  } catch (err) {
    lerr({ route: "POST /refresh-token", status: 500, error: err.message });
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
  log({ route: "POST /logout", userId: req.user.id, hasRefreshToken: !!refreshToken, status: "logging out" });
  try {
    if (refreshToken) {
      await db.query(
        "DELETE FROM refresh_tokens WHERE token = $1 AND user_id = $2",
        [refreshToken, req.user.id]
      );
    } else {
      await db.query("DELETE FROM refresh_tokens WHERE user_id = $1", [req.user.id]);
    }
    log({ route: "POST /logout", userId: req.user.id, status: 200 });
    return res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    lerr({ route: "POST /logout", userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /otp-create   -> otpgenerate
// Body: { phone }
// Triggers Twilio Verify to generate and SMS the OTP to the user.
// ==================================================================
async function otpgenerate(req, res) {
  const phone = req.body.phone ? String(req.body.phone).trim() : "";
  log({ route: "POST /otp-create", phone, status: "generating OTP" });
  if (!phone) {
    log({ route: "POST /otp-create", status: 400, message: "phone is required" });
    return res.status(400).json({ success: false, message: "phone is required" });
  }

  try {
    const userRes = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (userRes.rows.length === 0) {
      log({ route: "POST /otp-create", phone, status: 404, message: "No account found with this phone number" });
      return res.status(404).json({ success: false, message: "No account found with this phone number" });
    }

    await twilioClient.verify.v2.services(VERIFY_SID)
      .verifications
      .create({ to: toE164(phone), channel: "sms" });

    log({ route: "POST /otp-create", phone, status: 200, message: "Twilio Verify OTP sent" });
    return res.json({ success: true, message: "OTP sent" });
  } catch (err) {
    lerr({ route: "POST /otp-create", phone, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /otp-verify   -> otpverify
// Body: { phone, otp }
// Checks the OTP via Twilio Verify, then records a verified session in
// the DB so /reset-password can proceed.
// ==================================================================
async function otpverify(req, res) {
  const phone = req.body.phone ? String(req.body.phone).trim() : "";
  const otp = req.body.otp ? String(req.body.otp).trim() : "";
  log({ route: "POST /otp-verify", phone, status: "verifying OTP" });

  if (!phone || !otp) {
    log({ route: "POST /otp-verify", phone, status: 400, message: "phone and otp are required" });
    return res.status(400).json({ success: false, message: "phone and otp are required" });
  }

  try {
    const userRes = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (userRes.rows.length === 0) {
      log({ route: "POST /otp-verify", phone, status: 400, message: "No account found" });
      return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }
    const user = userRes.rows[0];

    const check = await twilioClient.verify.v2.services(VERIFY_SID)
      .verificationChecks
      .create({ to: toE164(phone), code: otp });

    if (check.status !== "approved") {
      log({ route: "POST /otp-verify", phone, status: 400, message: `OTP status: ${check.status}` });
      return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }

    // Write a verified record so /reset-password has a DB gate to check.
    // Clear any old sessions first so only this one is valid.
    await db.query("DELETE FROM otp_verifications WHERE user_id = $1", [user.id]);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min to reset password
    await db.query(
      "INSERT INTO otp_verifications (user_id, phone, otp_code, verified, expires_at) VALUES ($1, $2, $3, TRUE, $4)",
      [user.id, phone, otp, expiresAt]
    );

    log({ route: "POST /otp-verify", phone, status: 200 });
    return res.json({ success: true, message: "OTP verified. You can now set a new password." });
  } catch (err) {
    lerr({ route: "POST /otp-verify", phone, status: 500, error: err.message });
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
  log({ route: "POST /reset-password", phone, status: "setting password" });

  if (!phone || !newPassword) {
    log({ route: "POST /reset-password", phone, status: 400, message: "phone and newPassword are required" });
    return res.status(400).json({ success: false, message: "phone and newPassword are required" });
  }
  const pwErr = validatePassword(newPassword);
  if (pwErr) {
    log({ route: "POST /reset-password", phone, status: 400, message: pwErr });
    return res.status(400).json({ success: false, message: pwErr });
  }

  try {
    const userRes = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (userRes.rows.length === 0) {
      log({ route: "POST /reset-password", phone, status: 400, message: "User not found" });
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
      log({ route: "POST /reset-password", phone, status: 400, message: "OTP not verified" });
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

    log({ route: "POST /reset-password", phone, userId: user.id, status: 200 });
    return res.json({ success: true, message: "Password reset successfully. Please log in." });
  } catch (err) {
    lerr({ route: "POST /reset-password", phone, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /register   -> register
// Body: { email, fullName, password, phone? }
// Creates a new customer account and returns tokens (auto-login).
// ==================================================================
async function register(req, res) {
  const { email, fullName, password, phone } = req.body;
  log({ route: "POST /register", email, phone, status: "registering customer" });

  if (!email || !fullName || !password) {
    log({ route: "POST /register", status: 400, message: "email, fullName and password are required" });
    return res.status(400).json({ success: false, message: "email, fullName and password are required" });
  }
  if (!isEmail(email)) {
    log({ route: "POST /register", status: 400, message: "Invalid email" });
    return res.status(400).json({ success: false, message: "Invalid email address" });
  }
  const pwErr = validatePassword(password);
  if (pwErr) {
    log({ route: "POST /register", status: 400, message: pwErr });
    return res.status(400).json({ success: false, message: pwErr });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedPhone = phone ? String(phone).trim() : null;

  try {
    const existing = await db.query(
      "SELECT id FROM users WHERE email = $1 OR ($2::text IS NOT NULL AND phone = $2)",
      [normalizedEmail, normalizedPhone]
    );
    if (existing.rows.length > 0) {
      log({ route: "POST /register", email: normalizedEmail, phone: normalizedPhone, status: 409, message: "Account already exists" });
      return res.status(409).json({ success: false, message: "An account with this email or phone already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (email, phone, full_name, role, status, password_hash)
       VALUES ($1, $2, $3, 'customer', 'active', $4)
       RETURNING *`,
      [normalizedEmail, normalizedPhone, fullName.trim(), passwordHash]
    );

    const user = result.rows[0];
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    await db.query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, refreshToken, expiresAt]
    );

    log({ route: "POST /register", email: normalizedEmail, userId: user.id, status: 201 });
    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      accessToken,
      refreshToken,
      user: publicUser(user)
    });
  } catch (err) {
    lerr({ route: "POST /register", email: normalizedEmail, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getlogin,
  register,
  otpgenerate,
  otpverify,
  setpassword,
  refreshAccessToken,
  logout
};