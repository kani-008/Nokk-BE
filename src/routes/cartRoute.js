const express  = require("express");
const router   = express.Router();
const { getCart, addToCart, updateCartItem, removeCartItem, clearCart } = require("../controllers/cartController.js");
const authenticate = require("../middleware/auth.js");

router.use(authenticate); // all cart routes require login

router.get   ("/",          getCart);
router.post  ("/",          addToCart);
router.put   ("/:itemId",   updateCartItem);
router.delete("/:itemId",   removeCartItem);
router.delete("/",          clearCart);

module.exports = router;