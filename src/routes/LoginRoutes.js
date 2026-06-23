const express = require("express");
const router = express.Router();
const { otpgenerate, otpverify, setpassword, getlogin, register, refreshAccessToken, logout } = require("../controllers/loginController.js");
const { loginLimiter } = require("../middleware/ratelimiter.js");
const authenticate = require("../middleware/auth.js");

router.post("/register", loginLimiter, register);
router.post("/user-login", loginLimiter, getlogin);
router.post("/refresh-token", refreshAccessToken);
router.post("/reset-password", loginLimiter, setpassword);
router.post("/otp-verify", loginLimiter, otpverify);
router.post("/otp-create", loginLimiter, otpgenerate);
router.post("/logout", authenticate, logout);

module.exports = router;