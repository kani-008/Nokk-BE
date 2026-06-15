const express  = require("express");
const router   = express.Router();
const { getWishlist, addToWishlist, removeFromWishlist, clearWishlist } = require("../controllers/wishlistController.js");
const authenticate = require("../middleware/auth.js");

router.use(authenticate); // all wishlist routes require login

router.get   ("/",              getWishlist);
router.post  ("/",              addToWishlist);
router.delete("/:productId",    removeFromWishlist);
router.delete("/",              clearWishlist);

module.exports = router;