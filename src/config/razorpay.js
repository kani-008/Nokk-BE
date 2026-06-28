const Razorpay = require("razorpay");

const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn("[Razorpay] RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set — Razorpay endpoints will be unavailable until these are configured.");
}

// Lazy singleton: instantiated on first use so missing env vars don't crash startup.
let _client = null;
function getRazorpayClient() {
  if (_client) return _client;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env");
  }
  _client = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
  return _client;
}

module.exports = { getRazorpayClient, RAZORPAY_KEY_ID };
