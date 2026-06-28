const express  = require("express");
const router   = express.Router();
const { getCart, addToCart, updateCartItem, removeCartItem, clearCart } = require("../controllers/cartController.js");
const authenticate = require("../middleware/auth.js");

// Public log endpoint to print cart movements (for guests and logged-in users alike)
router.post("/log", (req, res) => {
  const { actionType, message, details, userId } = req.body;
  const colors = {
    add: "\x1b[32m",    // Green
    update: "\x1b[34m", // Blue
    remove: "\x1b[31m", // Red
    clear: "\x1b[90m",  // Gray
    coupon: "\x1b[35m", // Magenta
    sync: "\x1b[33m"    // Yellow
  };
  const color = colors[actionType] || "\x1b[0m";
  console.log(
    `[Cart Backend Log] User: ${userId || "GUEST"} | ${color}${actionType?.toUpperCase() || "ACTION"}\x1b[0m: ${message}`,
    details || ""
  );

  // Specific requirement: clear messages for adding/deleting items
  if (actionType === "add") {
    const itemCode = details?.variantId || "N/A";
    console.log(`[Cart Backend Log] Item added with item code: ${itemCode} (User: ${userId || "GUEST"})`);
  } else if (actionType === "remove") {
    const itemCode = details?.variantId || "N/A";
    console.log(`[Cart Backend Log] Item is deleted with item code: ${itemCode} (User: ${userId || "GUEST"})`);
  }

  return res.json({ success: true });
});

router.use(authenticate); // all cart routes require login
router.get   ("/get-cart",     getCart);
router.post  ("/add-item",     addToCart);
router.put   ("/update-item",  updateCartItem);   // itemId -> body
router.delete("/remove-item",  removeCartItem);   // itemId -> body
router.delete("/clear-cart",   clearCart);

module.exports = router;