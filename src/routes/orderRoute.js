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

// Customer (login required)
router.post("/checkout", authenticate, checkout);
router.get("/get-my-orders", authenticate, getMyOrders);
router.get("/get-my-order", authenticate, getMyOrderById); // ?id=
router.post("/cancel-my-order", authenticate, cancelMyOrder); // id -> body
router.post("/request-return", authenticate, requestReturn); // id -> body

// Admin
router.get("/admin/get-all", authenticate, isAdmin, adminGetAllOrders);
router.get("/admin/get-returns", authenticate, isAdmin, adminGetReturns);
router.get("/admin/get-order", authenticate, isAdmin, adminGetOrderById); // ?id=
router.put("/admin/update-status", authenticate, isAdmin, adminUpdateStatus); // id -> body
router.put("/admin/update-return", authenticate, isAdmin, adminUpdateReturn); // requestId -> body
module.exports = router;
