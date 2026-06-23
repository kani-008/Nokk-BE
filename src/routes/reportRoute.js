const express = require("express");
const router  = express.Router();

const {
  getOrderReport,
  getRevenueReport,
  getProductReport,
  getCustomerReport,
  getInventoryReport
} = require("../controllers/reportController.js");

const authenticate = require("../middleware/auth.js");
const { isAdmin }  = require("../middleware/auth.js");

// All report endpoints are admin-only.
router.use(authenticate, isAdmin);

// Detailed order list            ?from= ?to= ?status= ?payment= ?page= ?limit=
router.get("/orders",    getOrderReport);

// Revenue breakdown by period    ?from= ?to= ?period=daily|weekly|monthly
router.get("/revenue",   getRevenueReport);

// Per-product sales performance  ?from= ?to= ?category= ?limit=
router.get("/products",  getProductReport);

// Customer spend summary         ?from= ?to= ?limit=
router.get("/customers", getCustomerReport);

// Inventory snapshot             ?category= ?status=in_stock|low_stock|out_of_stock
router.get("/inventory", getInventoryReport);

module.exports = router;
