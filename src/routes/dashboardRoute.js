const express = require("express");
const router = express.Router();

const {
  getSummary,
  getRevenueChart,
  getTopProducts,
  getTopCustomers,
  getOutOfStock,
  getRecentOrders,
  getSalesByCategory,
  getReplacementRequests,
} = require("../controllers/dashboardController.js");

const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");

// Every dashboard route is admin-only.
// authenticate verifies the JWT, isAdmin checks role = 'admin'.
router.use(authenticate, isAdmin);

// KPI summary cards
router.get("/summary", getSummary);

// Revenue + order count chart  ?period=daily|weekly|monthly
router.get("/revenue-chart", getRevenueChart);

// Top selling products          ?limit=10
router.get("/top-products", getTopProducts);

// Top customers by spend        ?limit=10
router.get("/top-customers", getTopCustomers);

// Out of stock variants          ?limit=20
router.get("/out-of-stock", getOutOfStock);

// Recent orders feed            ?limit=10
router.get("/recent-orders", getRecentOrders);

// Revenue by category
router.get("/sales-by-category", getSalesByCategory);

// Replacement requests           ?status=requested&limit=20
router.get("/replacement-requests", getReplacementRequests);

module.exports = router;