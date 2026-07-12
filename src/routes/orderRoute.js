const express = require("express");
const router = express.Router();

const {
  checkout,
  submitUpiReference,
  getMyOrders,
  getMyOrderById,
  cancelMyOrder,
  requestReplacement,
  adminGetAllOrders,
  adminGetOrderById,
  adminUpdateStatus,
  adminGetReplacements,
  adminUpdateReplacement,
  createRazorpayOrder,
  verifyRazorpayPayment,
} = require("../controllers/orderController.js");

const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");

// Customer (login required)
router.post("/checkout", authenticate, checkout);
router.post("/submit-upi-reference", authenticate, submitUpiReference); // id, upiRefId -> body
router.get("/get-my-orders", authenticate, getMyOrders);
router.get("/get-my-order", authenticate, getMyOrderById); // ?id=
router.post("/cancel-my-order", authenticate, cancelMyOrder); // id -> body
router.post("/request-replacement", authenticate, requestReplacement); // id -> body

// Razorpay (login required)
// Note: POST /api/orders/razorpay/webhook is mounted in server.js BEFORE
//       express.json() so it receives the raw body for signature verification.
router.post("/razorpay/create-order", authenticate, createRazorpayOrder);
router.post("/razorpay/verify-payment", authenticate, verifyRazorpayPayment);

// Admin
router.get("/admin/get-all", authenticate, isAdmin, adminGetAllOrders);
router.get("/admin/get-replacements", authenticate, isAdmin, adminGetReplacements);
router.get("/admin/get-order", authenticate, isAdmin, adminGetOrderById); // ?id=
router.put("/admin/update-status", authenticate, isAdmin, adminUpdateStatus); // id -> body
router.put("/admin/update-replacement", authenticate, isAdmin, adminUpdateReplacement); // requestId -> body

module.exports = router;