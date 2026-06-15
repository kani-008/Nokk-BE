const express  = require("express");
const router   = express.Router();
const {
  getInventory, getInventorySummary,
  updateStock, bulkUpdateStock
} = require("../controllers/inventoryController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin }  = require("../middleware/auth.js");

// All inventory routes — admin only
router.use(authenticate, isAdmin);

router.get("/",                     getInventory);       // ?lowStock= ?outOfStock= ?category= ?search= ?page= ?limit=
router.get("/summary",              getInventorySummary);
router.put("/:variantId",           updateStock);
router.post("/bulk-update",         bulkUpdateStock);

module.exports = router;