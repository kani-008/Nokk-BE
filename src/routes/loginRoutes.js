const express = require("express");
const router = express.Router();
const {
  // otpgenerate, otpverify, registerOtpCreate — still exist in loginController.js,
  // just not wired up while the WhatsApp OTP endpoints are paused (see below).
  setpassword,
  getlogin,
  register,
  checkPhone,
  refreshAccessToken,
  logout,
  reactivate,
  googleLogin,
  googleLinkConfirm,
} = require("../controllers/loginController.js");
const { loginLimiter } = require("../middleware/ratelimiter.js");
const authenticate = require("../middleware/auth.js");

router.post("/register", loginLimiter, register);
router.post("/user-login", loginLimiter, getlogin);
router.post("/refresh-token", refreshAccessToken);
router.post("/reset-password", loginLimiter, setpassword);

// ── PAUSED: WhatsApp OTP endpoints ──────────────────────────────
// Meta Business verification is not complete yet. These call the real
// WhatsApp Cloud API and will fail against Meta until that's done.
// Uncomment once Meta approves the WhatsApp Business number.
// router.post("/otp-verify", loginLimiter, otpverify);
// router.post("/otp-create", loginLimiter, otpgenerate);
// router.post("/register-otp", loginLimiter, registerOtpCreate);

router.post("/check-phone", loginLimiter, checkPhone);
router.post("/logout", authenticate, logout);
router.post("/reactivate", loginLimiter, reactivate);
router.post("/google-login", loginLimiter, googleLogin);
router.post("/google-link-confirm", loginLimiter, googleLinkConfirm);

module.exports = router;
