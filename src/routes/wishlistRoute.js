const express = require("express");
const router = express.Router();
const {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  clearWishlist,
  mergeWishlist,
} = require("../controllers/wishlistController.js");
const authenticate = require("../middleware/auth.js");

router.use(authenticate); // all wishlist routes require login

router.get("/get-wishlist", getWishlist);
router.post("/add-item", addToWishlist);
router.post("/merge", mergeWishlist);
router.delete("/remove-item", removeFromWishlist); // productId -> body
router.delete("/clear", clearWishlist);
module.exports = router;
