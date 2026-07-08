const rateLimit = require("express-rate-limit");

// Throttles sensitive auth endpoints to slow down brute-force / OTP-spam.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // max 10 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`[ratelimit] blocked  ${req.method} ${req.originalUrl} | ip=${req.ip}`);
    res.status(429).json({ success: false, message: "Too many attempts. Please try again later." });
  }
});

// Throttles the public pincode/reverse-geocode lookups so a single client
// can't burn through the (rate-limited, sometimes-paid) third-party quotas.
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // max 30 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`[ratelimit] blocked  ${req.method} ${req.originalUrl} | ip=${req.ip}`);
    res.status(429).json({ success: false, message: "Too many requests. Please try again shortly." });
  }
});

// Throttles newsletter subscriptions to prevent email/spam attacks.
const newsletterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                   // max 5 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`[ratelimit] blocked  ${req.method} ${req.originalUrl} | ip=${req.ip}`);
    res.status(429).json({ success: false, message: "Too many attempts. Please try again later." });
  }
});

module.exports = { loginLimiter, lookupLimiter, newsletterLimiter };