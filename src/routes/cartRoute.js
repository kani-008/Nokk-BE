const express  = require("express");
const router   = express.Router();
const { getCart, addToCart, updateCartItem, removeCartItem, clearCart } = require("../controllers/cartController.js");
const authenticate = require("../middleware/auth.js");

router.use(authenticate); // all cart routes require login
router.get   ("/get-cart",     getCart);
router.post  ("/add-item",     addToCart);
router.put   ("/update-item",  updateCartItem);   // itemId -> body
router.delete("/remove-item",  removeCartItem);   // itemId -> body
router.delete("/clear-cart",   clearCart);

module.exports = router;