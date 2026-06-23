const express = require("express");
const router = express.Router();

const {
  checkout,
  getMyOrders,
  getMyOrderById,
  cancelMyOrder,
  requestReturn,
  adminGetAllOrders,
  adminGetOrderById,
  adminUpdateStatus,
  adminGetReturns,
  adminUpdateReturn,
} = require("../controllers/orderController.js");

const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");

// ── Customer routes (login required) ─────────────────────────────
router.post("/checkout", authenticate, checkout);
router.get("/getMyOrders", authenticate, getMyOrders);
router.get("/my/:id", authenticate, getMyOrderById);
router.post("/my/cancel", authenticate, cancelMyOrder);
router.post("/my/return", authenticate, requestReturn);

// ── Admin routes ──────────────────────────────────────────────────
router.get("/admin/list", authenticate, isAdmin, adminGetAllOrders);
router.get("/admin/returns", authenticate, isAdmin, adminGetReturns);
router.get("/admin/:id", authenticate, isAdmin, adminGetOrderById);
router.put("/admin/:id/status", authenticate, isAdmin, adminUpdateStatus);
router.put("/admin/returns/:requestId",authenticate,isAdmin,adminUpdateReturn,);

module.exports = router;
