const express  = require("express");
const router   = express.Router();
const { validateCoupon, getAllCoupons, createCoupon, updateCoupon, deleteCoupon } = require("../controllers/couponController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin }  = require("../middleware/auth.js");

router.post  ("/validate",  authenticate, validateCoupon); // customer at checkout
router.get   ("/",          authenticate, isAdmin, getAllCoupons);
router.post  ("/",          authenticate, isAdmin, createCoupon);
router.put   ("/:id",       authenticate, isAdmin, updateCoupon);
router.delete("/:id",       authenticate, isAdmin, deleteCoupon);

module.exports = router;