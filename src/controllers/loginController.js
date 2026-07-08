const bcrypt = require("bcryptjs");
const { createNotification } = require("./notificationController.js");
const jwt = require("jsonwebtoken");
const db = require("../config/db.js");
const { generateAndSendOtp, verifyOtpHash } = require("../services/whatsappService.js");
const { OAuth2Client } = require("google-auth-library");

// ------------------------------------------------------------------
// Config (read from .env)
// ------------------------------------------------------------------
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
  throw new Error(
    "FATAL: ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET env vars must be set",
  );
}
const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_DAYS = 7;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

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
  if (typeof p !== "string" || p.length < 6)
    return "Password must be at least 6 characters";
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
    { expiresIn: ACCESS_TOKEN_TTL },
  );
}
function signRefreshToken(user) {
  return jwt.sign({ id: user.id, type: "refresh" }, REFRESH_TOKEN_SECRET, {
    expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d`,
  });
}
function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    name: u.full_name,
    role: u.role,
    status: u.status,
    gender: u.gender || null,
  };
}

// ==================================================================
// POST /user-login   -> getlogin
// Body: { identifier, password }  (identifier = email OR phone)
// Returns access + refresh tokens.
// ==================================================================
async function getlogin(req, res) {
  const rawId =
    req.body.identifier ?? req.body.email ?? req.body.phone ?? req.body.login;
  const password = req.body.password;
  console.log({
    route: "POST /user-login",
    identifier: normalizeIdentifier(rawId),
    status: "logging in",
  });

  if (!rawId || !password) {
    console.log({
      route: "POST /user-login",
      status: 400,
      message: "Email/phone and password are required",
    });
    return res
      .status(400)
      .json({
        success: false,
        message: "Email/phone and password are required",
      });
  }

  const identifier = normalizeIdentifier(rawId);

  try {
    const result = await db.query(
      "SELECT * FROM users WHERE email = $1 OR phone = $1 LIMIT 1",
      [identifier],
    );
    if (result.rows.length === 0) {
      console.log({
        route: "POST /user-login",
        identifier,
        status: 401,
        message: "Invalid credentials",
      });
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    const user = result.rows[0];
    if (user.status === "blocked") {
      console.log({
        route: "POST /user-login",
        identifier,
        status: 403,
        message: "Account blocked",
      });
      return res
        .status(403)
        .json({
          success: false,
          message: "This account has been blocked. Please contact support.",
        });
    }
    if (user.status === "deactivated") {
      const ok = await bcrypt.compare(password, user.password_hash || "");
      if (!ok) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }
      console.log({ route: "POST /user-login", identifier, status: 200, message: "DEACTIVATED" });
      return res.json({ success: false, code: "DEACTIVATED", userId: user.id });
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      console.log({
        route: "POST /user-login",
        identifier,
        status: 401,
        message: "Invalid credentials",
      });
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    const expiresAt = new Date(
      Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    // Store the refresh token so we can validate it on /refresh-token and revoke it on /logout.
    await db.query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, refreshToken, expiresAt],
    );

    console.log({
      route: "POST /user-login",
      identifier,
      userId: user.id,
      status: 200,
    });
    return res.json({
      success: true,
      message: "Signed in successfully",
      accessToken,
      refreshToken,
      user: publicUser(user),
    });
  } catch (err) {
    console.error({
      route: "POST /user-login",
      identifier,
      status: 500,
      error: err.message,
    });
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /refresh-token   -> refreshAccessToken
// Body: { refreshToken }
// Validates the stored refresh token and issues a fresh access token.
// ==================================================================
async function refreshAccessToken(req, res) {
  const refreshToken = req.body.refreshToken;
  console.log({
    route: "POST /refresh-token",
    status: "refreshing access token",
  });
  if (!refreshToken) {
    console.log({
      route: "POST /refresh-token",
      status: 400,
      message: "refreshToken is required",
    });
    return res
      .status(400)
      .json({ success: false, message: "refreshToken is required" });
  }

  try {
    // Must exist in DB and still be valid.
    const stored = await db.query(
      "SELECT id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()",
      [refreshToken],
    );
    if (stored.rows.length === 0) {
      console.log({
        route: "POST /refresh-token",
        status: 401,
        message: "Invalid or expired refresh token",
      });
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired refresh token" });
    }

    let payload;
    try {
      payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
      console.log({ message: "Refresh token payload", payload });
    } catch (e) {
      console.log({
        route: "POST /refresh-token",
        status: 401,
        message: "jwt verification failed",
      });
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired refresh token" });
    }

    const userRes = await db.query(
      "SELECT id, email, phone, full_name, role, status FROM users WHERE id = $1",
      [payload.id],
    );
    if (userRes.rows.length === 0) {
      console.log({
        route: "POST /refresh-token",
        userId: payload.id,
        status: 401,
        message: "User no longer exists",
      });
      return res
        .status(401)
        .json({ success: false, message: "User no longer exists" });
    }

    const user = userRes.rows[0];
    if (user.status === "blocked") {
      console.log({
        route: "POST /refresh-token",
        userId: user.id,
        status: 403,
        message: "Account blocked",
      });
      return res
        .status(403)
        .json({ success: false, message: "Account blocked" });
    }

    const accessToken = signAccessToken(user);
    console.log({ route: "POST /refresh-token", userId: user.id, status: 200 });
    return res.json({ success: true, accessToken });
  } catch (err) {
    console.error({
      route: "POST /refresh-token",
      status: 500,
      error: err.message,
    });
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /logout   -> logout   (protected by authenticate middleware)
// Body: { refreshToken? }
// With a refreshToken: revoke that one session. Without: revoke all.
// ==================================================================
async function logout(req, res) {
  const refreshToken = req.body.refreshToken;
  console.log({
    route: "POST /logout",
    userId: req.user.id,
    hasRefreshToken: !!refreshToken,
    status: "logging out",
  });
  try {
    if (refreshToken) {
      await db.query(
        "DELETE FROM refresh_tokens WHERE token = $1 AND user_id = $2",
        [refreshToken, req.user.id],
      );
    } else {
      await db.query("DELETE FROM refresh_tokens WHERE user_id = $1", [
        req.user.id,
      ]);
    }
    console.log({ route: "POST /logout", userId: req.user.id, status: 200 });
    return res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    console.error({
      route: "POST /logout",
      userId: req.user.id,
      status: 500,
      error: err.message,
    });
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /check-phone   -> checkPhone
// Body: { phone }
// Returns 409 if the phone is already registered, 200 if available.
// Called by the frontend at step 1 of registration before sending OTP.
// ==================================================================
async function checkPhone(req, res) {
  const phone = req.body.phone ? String(req.body.phone).trim() : "";
  console.log({ route: "POST /check-phone", phone, status: "checking" });
  if (!phone) {
    console.log({ route: "POST /check-phone", status: 400, message: "phone is required" });
    return res.status(400).json({ success: false, message: "phone is required" });
  }

  try {
    const result = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (result.rows.length > 0) {
      console.log({ route: "POST /check-phone", phone, status: 409, message: "phone already registered" });
      return res.status(409).json({ success: false, message: "This phone number is already registered" });
    }
    console.log({ route: "POST /check-phone", phone, status: 200, message: "phone available" });
    return res.json({ success: true, message: "Phone available" });
  } catch (err) {
    console.error({ route: "POST /check-phone", phone, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ── PAUSED: WhatsApp OTP endpoint (registerOtpCreate) ──────────────
// Meta Business verification is not complete yet. This calls the real
// WhatsApp Cloud API and will fail against Meta until that's done.
// Uncomment once Meta approves the WhatsApp Business number.
/*
// ==================================================================
// POST /register-otp   -> registerOtpCreate
// Body: { phone }
// Sends a Twilio OTP to a phone that is NOT yet registered.
// Separate from /otp-create (which is for password-reset and requires
// the user to already exist).
// ==================================================================
async function registerOtpCreate(req, res) {
  const phone = req.body.phone ? String(req.body.phone).trim() : "";
  console.log({
    route: "POST /register-otp",
    phone,
    status: "sending registration OTP",
  });
  if (!phone) {
    return res
      .status(400)
      .json({ success: false, message: "phone is required" });
  }

  try {
    const existing = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (existing.rows.length > 0) {
      console.log({ route: "POST /register-otp", phone, status: 409, message: "phone already registered" });
      return res.status(409).json({ success: false, message: "This phone number is already registered" });
    }

    let otpHash, messageId;
    try {
      const result = await generateAndSendOtp(phone);
      otpHash = result.otpHash;
      messageId = result.messageId;
    } catch (sendErr) {
      console.error({ route: "POST /register-otp", phone, status: 502, error: sendErr.message });
      return res.status(502).json({ success: false, message: "Could not send OTP right now. Please try again." });
    }

    await db.query(
      "DELETE FROM otp_verifications WHERE phone = $1 AND user_id IS NULL",
      [phone]
    );
    await db.query(
      `INSERT INTO otp_verifications (user_id, phone, otp_code, verified, expires_at, session_id)
       VALUES (NULL, $1, $2, FALSE, $3, $4)`,
      [phone, otpHash, new Date(Date.now() + 10 * 60 * 1000), messageId]
    );

    console.log({ route: "POST /register-otp", phone, status: 200, message: "OTP sent via WhatsApp" });
    return res.json({ success: true, message: "OTP sent" });
  } catch (err) {
    console.error({ route: "POST /register-otp", phone, status: 500, error: err.message });
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}
*/

// ── PAUSED: WhatsApp OTP endpoint (otpgenerate) ──────────────
// Meta Business verification is not complete yet. This calls the real
// WhatsApp Cloud API and will fail against Meta until that's done.
// Uncomment once Meta approves the WhatsApp Business number.
/*
// ==================================================================
// POST /otp-create   -> otpgenerate
// Body: { phone }
// Triggers Twilio Verify to generate and SMS the OTP to the user.
// Requires the phone to already have an account (password-reset flow).
// ==================================================================
async function otpgenerate(req, res) {
  const phone = req.body.phone ? String(req.body.phone).trim() : "";
  console.log({ route: "POST /otp-create", phone, status: "generating OTP" });
  if (!phone) {
    console.log({
      route: "POST /otp-create",
      status: 400,
      message: "phone is required",
    });
    return res
      .status(400)
      .json({ success: false, message: "phone is required" });
  }

  try {
    const userRes = await db.query("SELECT id FROM users WHERE phone = $1", [
      phone,
    ]);
    if (userRes.rows.length === 0) {
      console.log({
        route: "POST /otp-create",
        phone,
        status: 404,
        message: "No account found with this phone number",
      });
      return res
        .status(404)
        .json({
          success: false,
          message: "No account found with this phone number",
        });
    }
    const userId = userRes.rows[0].id;

    let otpHash, messageId;
    try {
      const result = await generateAndSendOtp(phone);
      otpHash = result.otpHash;
      messageId = result.messageId;
    } catch (sendErr) {
      console.error({ route: "POST /otp-create", phone, status: 502, error: sendErr.message });
      return res.status(502).json({ success: false, message: "Could not send OTP right now. Please try again." });
    }

    await db.query("DELETE FROM otp_verifications WHERE user_id = $1", [userId]);
    await db.query(
      `INSERT INTO otp_verifications (user_id, phone, otp_code, verified, expires_at, session_id)
       VALUES ($1, $2, $3, FALSE, $4, $5)`,
      [userId, phone, otpHash, new Date(Date.now() + 10 * 60 * 1000), messageId]
    );

    console.log({
      route: "POST /otp-create",
      phone,
      status: 200,
      message: "WhatsApp OTP sent",
    });
    return res.json({ success: true, message: "OTP sent" });
  } catch (err) {
    console.error({
      route: "POST /otp-create",
      phone,
      status: 500,
      error: err.message,
    });
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}
*/

// ── PAUSED: WhatsApp OTP endpoint (otpverify) ──────────────
// Meta Business verification is not complete yet. This calls the real
// WhatsApp Cloud API and will fail against Meta until that's done.
// Uncomment once Meta approves the WhatsApp Business number.
/*
// ==================================================================
// POST /otp-verify   -> otpverify
// Body: { phone, otp }
// Checks the OTP via Twilio Verify, then records a verified session in
// the DB so /reset-password can proceed.
// ==================================================================
async function otpverify(req, res) {
  const phone = req.body.phone ? String(req.body.phone).trim() : "";
  const otp = req.body.otp ? String(req.body.otp).trim() : "";
  console.log({ route: "POST /otp-verify", phone, status: "verifying OTP" });

  if (!phone || !otp) {
    console.log({
      route: "POST /otp-verify",
      phone,
      status: 400,
      message: "phone and otp are required",
    });
    return res
      .status(400)
      .json({ success: false, message: "phone and otp are required" });
  }

  try {
    const userRes = await db.query("SELECT id FROM users WHERE phone = $1", [
      phone,
    ]);
    if (userRes.rows.length === 0) {
      console.log({
        route: "POST /otp-verify",
        phone,
        status: 400,
        message: "No account found",
      });
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired OTP" });
    }
    const user = userRes.rows[0];

    const pendingRow = await db.query(
      `SELECT otp_code FROM otp_verifications
       WHERE user_id = $1 AND verified = FALSE AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [user.id]
    );
    if (!pendingRow.rows.length || !pendingRow.rows[0].otp_code) {
      console.log({ route: "POST /otp-verify", phone, status: 400, message: "OTP session not found or expired" });
      return res.status(400).json({ success: false, message: "OTP expired or not found. Please request a new one." });
    }
    const isValid = await verifyOtpHash(otp, pendingRow.rows[0].otp_code);
    if (!isValid) {
      console.log({ route: "POST /otp-verify", phone, status: 400, message: "OTP mismatch" });
      return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }

    // Write a verified record so /reset-password has a DB gate to check.
    // Clear any old sessions first so only this one is valid.
    await db.query("DELETE FROM otp_verifications WHERE user_id = $1", [
      user.id,
    ]);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min to reset password
    await db.query(
      "INSERT INTO otp_verifications (user_id, phone, otp_code, verified, expires_at) VALUES ($1, $2, $3, TRUE, $4)",
      [user.id, phone, pendingRow.rows[0].otp_code, expiresAt],
    );

    console.log({ route: "POST /otp-verify", phone, status: 200 });
    return res.json({
      success: true,
      message: "OTP verified. You can now set a new password.",
    });
  } catch (err) {
    console.error({
      route: "POST /otp-verify",
      phone,
      status: 500,
      error: err.message,
    });
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}
*/

// ==================================================================
// POST /reset-password   -> setpassword
// Body: { phone, newPassword }
// Requires a recently VERIFIED, still-valid OTP for the phone.
// ==================================================================
async function setpassword(req, res) {
  const phone = req.body.phone ? String(req.body.phone).trim() : "";
  const newPassword = req.body.newPassword ?? req.body.password;
  console.log({
    route: "POST /reset-password",
    phone,
    status: "setting password",
  });

  if (!phone || !newPassword) {
    console.log({
      route: "POST /reset-password",
      phone,
      status: 400,
      message: "phone and newPassword are required",
    });
    return res
      .status(400)
      .json({ success: false, message: "phone and newPassword are required" });
  }
  const pwErr = validatePassword(newPassword);
  if (pwErr) {
    console.log({
      route: "POST /reset-password",
      phone,
      status: 400,
      message: pwErr,
    });
    return res.status(400).json({ success: false, message: pwErr });
  }

  try {
    const userRes = await db.query("SELECT id FROM users WHERE phone = $1", [
      phone,
    ]);
    if (userRes.rows.length === 0) {
      console.log({
        route: "POST /reset-password",
        phone,
        status: 400,
        message: "User not found",
      });
      return res
        .status(400)
        .json({ success: false, message: "Invalid request" });
    }
    const user = userRes.rows[0];

    // There must be a verified, still-valid OTP (from /otp-verify).
    /* --- Temporarily disabled for both dev and production until WhatsApp OTP is ready ---
    const otpRes = await db.query(
      `SELECT id FROM otp_verifications
       WHERE user_id = $1 AND phone = $2 AND verified = TRUE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, phone],
    );
    if (otpRes.rows.length === 0) {
      console.log({
        route: "POST /reset-password",
        phone,
        status: 400,
        message: "OTP not verified",
      });
      return res
        .status(400)
        .json({ success: false, message: "Please verify the OTP first" });
    }
    ------------------------------------------------------------------------------------- */

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.query(
      "UPDATE users SET password_hash = $1, phone_verified = TRUE WHERE id = $2",
      [passwordHash, user.id],
    );

    // Consume the OTP so it can't be reused.
    /* --- Temporarily commented out until WhatsApp OTP is ready ---
    await db.query("DELETE FROM otp_verifications WHERE id = $1", [
      otpRes.rows[0].id,
    ]);
    ----------------------------------------------------------------- */
    // Log out all existing sessions after a password change (best practice).
    await db.query("DELETE FROM refresh_tokens WHERE user_id = $1", [user.id]);

    console.log({
      route: "POST /reset-password",
      phone,
      userId: user.id,
      status: 200,
    });
    return res.json({
      success: true,
      message: "Password reset successfully. Please log in.",
    });
  } catch (err) {
    console.error({
      route: "POST /reset-password",
      phone,
      status: 500,
      error: err.message,
    });
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /register   -> register
// Body: { fullName, phone, password, otp?, email? }
// Creates a new customer account and returns tokens (auto-login).
//
// OTP TOGGLE: real Twilio OTP verification is written below but
// commented out. To turn it ON, uncomment the "REAL OTP CHECK" block.
// While it's commented out, registration is unverified (dev bypass).
// ==================================================================
async function register(req, res) {
  const { email, fullName, password, phone, otp } = req.body;
  console.log({
    route: "POST /register",
    email,
    phone,
    status: "registering customer",
  });

  // Check registrationsEnabled setting — default true (fail open if setting absent)
  try {
    const regRes = await db.query("SELECT value FROM settings WHERE key = 'registrationsEnabled'");
    if (regRes.rows.length > 0 && regRes.rows[0].value === "false") {
      console.log({ route: "POST /register", status: 403, message: "Registrations disabled by admin" });
      return res.status(403).json({ success: false, message: "New sign-ups are temporarily paused. Please try again later." });
    }
  } catch (settingErr) {
    console.error({ route: "POST /register", message: "Failed to read registrationsEnabled setting", error: settingErr.message });
    // Fail open — if we can't read the setting, allow registration
  }

  if (fullName && String(fullName).trim().length > 100) {
    return res.status(400).json({ success: false, message: "Name must be 100 characters or fewer" });
  }
  if (phone && String(phone).trim().length > 15) {
    return res.status(400).json({ success: false, message: "Invalid phone number" });
  }
  if (email && String(email).trim().length > 254) {
    return res.status(400).json({ success: false, message: "Invalid email address" });
  }

  if (!fullName || !password || !phone) {
    console.log({
      route: "POST /register",
      status: 400,
      message: "fullName, phone and password are required",
    });
    return res
      .status(400)
      .json({
        success: false,
        message: "fullName, phone and password are required",
      });
  }
  if (email && !isEmail(email)) {
    console.log({
      route: "POST /register",
      status: 400,
      message: "Invalid email",
    });
    return res
      .status(400)
      .json({ success: false, message: "Invalid email address" });
  }
  const pwErr = validatePassword(password);
  if (pwErr) {
    console.log({ route: "POST /register", status: 400, message: pwErr });
    return res.status(400).json({ success: false, message: pwErr });
  }

  const normalizedEmail = email ? email.trim().toLowerCase() : null;
  const normalizedPhone = String(phone).trim();

  try {
    const existing = await db.query(
      "SELECT id FROM users WHERE phone = $1 OR ($2::text IS NOT NULL AND email = $2)",
      [normalizedPhone, normalizedEmail],
    );
    if (existing.rows.length > 0) {
      console.log({
        route: "POST /register",
        email: normalizedEmail,
        phone: normalizedPhone,
        status: 409,
        message: "Account already exists",
      });
      return res
        .status(409)
        .json({
          success: false,
          message: "An account with this email or phone already exists",
        });
    }

    /* --- Temporarily disabled for both dev and production until WhatsApp OTP is ready ---
    if (process.env.NODE_ENV === "production") {
      if (!otp) {
        console.log({ route: "POST /register", phone: normalizedPhone, status: 400, message: "otp is required" });
        return res.status(400).json({ success: false, message: "otp is required" });
      }
      const regRow = await db.query(
        `SELECT otp_code FROM otp_verifications
         WHERE phone = $1 AND user_id IS NULL AND verified = FALSE AND expires_at > NOW()
         ORDER BY expires_at DESC LIMIT 1`,
        [normalizedPhone]
      );
      if (!regRow.rows.length || !regRow.rows[0].otp_code) {
        console.log({ route: "POST /register", phone: normalizedPhone, status: 400, message: "OTP session not found or expired" });
        return res.status(400).json({ success: false, message: "OTP expired or not found. Please request a new one." });
      }
      const isValid = await verifyOtpHash(otp, regRow.rows[0].otp_code);
      if (!isValid) {
        console.log({ route: "POST /register", phone: normalizedPhone, status: 400, message: "OTP mismatch" });
        return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
      }
      await db.query(
        "DELETE FROM otp_verifications WHERE phone = $1 AND user_id IS NULL",
        [normalizedPhone]
      );
    } else {
      console.warn({ route: "POST /register", phone: normalizedPhone, message: "OTP verification SKIPPED (dev mode)" });
    }
    ------------------------------------------------------------------------------------- */
    console.warn({ route: "POST /register", phone: normalizedPhone, message: "OTP verification SKIPPED (temporary bypass)" });

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (email, phone, full_name, role, status, password_hash)
       VALUES ($1::text, $2, $3, 'customer', 'active', $4)
       RETURNING *`,
      [normalizedEmail ?? null, normalizedPhone, fullName.trim(), passwordHash],
    );

    const user = result.rows[0];
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    const expiresAt = new Date(
      Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    await db.query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, refreshToken, expiresAt],
    );

    createNotification({
      eventType: "new_signup",
      priority: "low",
      title: "New Customer Signup",
      message: `${fullName.trim()} (${normalizedPhone}) just registered`,
      entityType: "users",
      entityId: String(user.id),
      link: `/admin/customers/${user.id}`,
    });

    console.log({
      route: "POST /register",
      phone: normalizedPhone,
      userId: user.id,
      status: 201,
    });
    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      accessToken,
      refreshToken,
      user: publicUser(user),
    });
  } catch (err) {
    console.error({
      route: "POST /register",
      phone: normalizedPhone,
      status: 500,
      error: err.message,
    });
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}
// ==================================================================
// POST /auth/reactivate   -> reactivate
// Body: { identifier, password }
// Reactivates a deactivated account after verifying credentials.
// ==================================================================
async function reactivate(req, res) {
  const { identifier: rawId, password } = req.body;
  if (!rawId || !password) {
    return res.status(400).json({ success: false, message: "identifier and password are required" });
  }
  const identifier = normalizeIdentifier(rawId);
  try {
    const result = await db.query(
      "SELECT * FROM users WHERE (email = $1 OR phone = $1) AND status = 'deactivated' LIMIT 1",
      [identifier]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "No deactivated account found with those credentials" });
    }
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }
    await db.query("UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1", [user.id]);

    const accessToken = signAccessToken({ ...user, status: "active" });
    const refreshToken = signRefreshToken(user);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, refreshToken, expiresAt]
    );

    console.log({ route: "POST /auth/reactivate", userId: user.id, status: 200 });
    return res.json({
      success: true,
      message: "Account reactivated successfully",
      accessToken,
      refreshToken,
      user: publicUser({ ...user, status: "active" }),
    });
  } catch (err) {
    console.error({ route: "POST /auth/reactivate", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ------------------------------------------------------------------
// Google ID token verification helper (shared by googleLogin and
// googleLinkConfirm). Throws if the token is malformed/expired/wrong
// audience — callers must catch and respond 401.
// ------------------------------------------------------------------
async function verifyGoogleIdToken(credential) {
  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}

// ==================================================================
// POST /google-login   -> googleLogin
// Body: { credential }  (Google ID token from the frontend)
// Signs in an existing account, creates a new one, or asks the
// frontend to collect a password when the email already belongs to
// a password-based account.
// ==================================================================
async function googleLogin(req, res) {
  const { credential } = req.body;
  console.log({ route: "POST /google-login", status: "verifying Google credential" });

  if (!credential) {
    return res.status(400).json({ success: false, message: "credential is required" });
  }

  let payload;
  try {
    payload = await verifyGoogleIdToken(credential);
  } catch (err) {
    console.log({ route: "POST /google-login", status: 401, message: "Google token verification failed", error: err.message });
    return res.status(401).json({ success: false, message: "Invalid Google token" });
  }

  if (payload.email_verified !== true) {
    console.log({ route: "POST /google-login", status: 401, message: "Google email not verified" });
    return res.status(401).json({ success: false, message: "Google account email is not verified" });
  }

  const email = String(payload.email).trim().toLowerCase();

  try {
    const result = await db.query("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);

    if (result.rows.length === 0) {
      // CASE A — no account yet: create one and sign in.
      const fullName = payload.name || email.split("@")[0];
      const insertRes = await db.query(
        `INSERT INTO users (email, phone, full_name, role, status, email_verified, auth_provider, password_hash)
         VALUES ($1, NULL, $2, 'customer', 'active', TRUE, 'google', NULL)
         RETURNING *`,
        [email, fullName],
      );
      const user = insertRes.rows[0];

      const accessToken = signAccessToken(user);
      const refreshToken = signRefreshToken(user);
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
      await db.query(
        "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
        [user.id, refreshToken, expiresAt],
      );

      createNotification({
        eventType: "new_signup",
        priority: "low",
        title: "New Customer Signup",
        message: `${fullName} (${email}) just registered via Google`,
        entityType: "users",
        entityId: String(user.id),
        link: `/admin/customers/${user.id}`,
      });

      console.log({ route: "POST /google-login", email, userId: user.id, status: 200, message: "New Google account created" });
      return res.status(200).json({
        success: true,
        message: "Signed in successfully",
        accessToken,
        refreshToken,
        user: publicUser(user),
      });
    }

    const user = result.rows[0];

    if (user.status === "blocked") {
      console.log({ route: "POST /google-login", email, status: 403, message: "Account blocked" });
      return res.status(403).json({ success: false, message: "This account has been blocked. Please contact support." });
    }

    if (user.status === "deactivated") {
      if (user.auth_provider === "google") {
        // A Google-only account has no password to check — the verified
        // Google token itself is sufficient proof, same bar used to create
        // a brand-new Google account above. Reactivate transparently.
        const reactivateRes = await db.query(
          "UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING *",
          [user.id],
        );
        const reactivatedUser = reactivateRes.rows[0];
        const accessToken = signAccessToken(reactivatedUser);
        const refreshToken = signRefreshToken(reactivatedUser);
        const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
        await db.query(
          "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
          [reactivatedUser.id, refreshToken, expiresAt],
        );

        console.log({ route: "POST /google-login", email, userId: reactivatedUser.id, status: 200, message: "Reactivated Google-only account transparently" });
        return res.status(200).json({
          success: true,
          message: "Signed in successfully",
          accessToken,
          refreshToken,
          user: publicUser(reactivatedUser),
        });
      }

      // Email/password account: reactivation still requires the password,
      // so surface DEACTIVATED and let the frontend collect it via
      // /auth/google-link-confirm (which reactivates on a successful match).
      console.log({ route: "POST /google-login", email, status: 200, message: "DEACTIVATED" });
      return res.status(200).json({ success: false, code: "DEACTIVATED", userId: user.id });
    }

    if (user.auth_provider === "google") {
      // CASE D — returning Google user.
      const accessToken = signAccessToken(user);
      const refreshToken = signRefreshToken(user);
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
      await db.query(
        "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
        [user.id, refreshToken, expiresAt],
      );

      console.log({ route: "POST /google-login", email, userId: user.id, status: 200 });
      return res.status(200).json({
        success: true,
        message: "Signed in successfully",
        accessToken,
        refreshToken,
        user: publicUser(user),
      });
    }

    // CASE E — email/password account with the same email: confirm identity first.
    console.log({ route: "POST /google-login", email, userId: user.id, status: 200, message: "NEEDS_PASSWORD_CONFIRM" });
    return res.status(200).json({ success: false, code: "NEEDS_PASSWORD_CONFIRM" });
  } catch (err) {
    console.error({ route: "POST /google-login", email, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /google-link-confirm   -> googleLinkConfirm
// Body: { credential, password }
// Confirms a Google sign-in attempt against an existing password
// account with the same email, updating auth_provider to 'google'.
// ==================================================================
async function googleLinkConfirm(req, res) {
  const { credential, password } = req.body;
  console.log({ route: "POST /google-link-confirm", status: "verifying Google credential" });

  if (!credential || !password) {
    return res.status(400).json({ success: false, message: "credential and password are required" });
  }

  let payload;
  try {
    payload = await verifyGoogleIdToken(credential);
  } catch (err) {
    console.log({ route: "POST /google-link-confirm", status: 401, message: "Google token verification failed", error: err.message });
    return res.status(401).json({ success: false, message: "Invalid Google token" });
  }

  if (payload.email_verified !== true) {
    console.log({ route: "POST /google-link-confirm", status: 401, message: "Google email not verified" });
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }

  const email = String(payload.email).trim().toLowerCase();

  try {
    const result = await db.query("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);
    if (result.rows.length === 0) {
      console.log({ route: "POST /google-link-confirm", email, status: 401, message: "Invalid credentials" });
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const user = result.rows[0];

    if (user.status === "blocked") {
      console.log({ route: "POST /google-link-confirm", email, status: 403, message: "Account blocked" });
      return res.status(403).json({ success: false, message: "This account has been blocked. Please contact support." });
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      console.log({ route: "POST /google-link-confirm", email, status: 401, message: "Invalid credentials" });
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    let user2 = user;
    if (user.status === "deactivated") {
      // Password confirmed: reactivate as part of this same successful
      // link-confirm, mirroring reactivate()'s behavior. Also set auth_provider to 'google'
      // to record the successful Google link.
      const reactivateRes = await db.query(
        "UPDATE users SET status = 'active', auth_provider = 'google', updated_at = NOW() WHERE id = $1 RETURNING *",
        [user.id],
      );
      user2 = reactivateRes.rows[0];
    } else {
      // Unconditionally set auth_provider to 'google' to record successful Google link.
      const updateRes = await db.query(
        "UPDATE users SET auth_provider = 'google', updated_at = NOW() WHERE id = $1 RETURNING *",
        [user.id],
      );
      user2 = updateRes.rows[0];
    }

    const accessToken = signAccessToken(user2);
    const refreshToken = signRefreshToken(user2);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user2.id, refreshToken, expiresAt],
    );

    console.log({ route: "POST /google-link-confirm", email, userId: user2.id, status: 200 });
    return res.status(200).json({
      success: true,
      message: "Signed in successfully",
      accessToken,
      refreshToken,
      user: publicUser(user2),
    });
  } catch (err) {
    console.error({ route: "POST /google-link-confirm", email, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getlogin,
  register,
  checkPhone,
  // registerOtpCreate, // PAUSED — Meta not ready, restore when approved
  // otpgenerate,       // PAUSED — Meta not ready, restore when approved
  // otpverify,         // PAUSED — Meta not ready, restore when approved
  setpassword,
  refreshAccessToken,
  logout,
  reactivate,
  googleLogin,
  googleLinkConfirm,
};
