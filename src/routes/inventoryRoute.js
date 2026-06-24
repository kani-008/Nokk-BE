const express = require("express");
const router = express.Router();
const {
  getInventory,
  getInventorySummary,
  updateStock,
  bulkUpdateStock,
} = require("../controllers/inventoryController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");

// All inventory routes — admin only
router.use(authenticate, isAdmin); // admin only

router.get("/get-inventory", getInventory); // ?outOfStock= ?category= ?search= ?page= ?limit=
router.get("/get-summary", getInventorySummary);
router.put("/update-stock", updateStock); // variantId -> body
router.post("/bulk-update", bulkUpdateStock);
module.exports = router;
