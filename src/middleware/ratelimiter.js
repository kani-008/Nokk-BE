const rateLimit = require("express-rate-limit");

// Throttles sensitive auth endpoints to slow down brute-force / OTP-spam.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // max 10 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." }
});

module.exports = { loginLimiter };