const express = require("express");
const router = express.Router();
const {
  validateCoupon,
  getAllCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  getPublicCoupons,
} = require("../controllers/couponController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");

router.get("/get-public", getPublicCoupons); // no auth — public coupon list
router.post("/validate", authenticate, validateCoupon); // customer at checkout
router.get("/get-all", authenticate, isAdmin, getAllCoupons);
router.post("/create-coupon", authenticate, isAdmin, createCoupon);
router.put("/update-coupon", authenticate, isAdmin, updateCoupon); // id -> body
router.delete("/delete-coupon", authenticate, isAdmin, deleteCoupon); // id -> body

module.exports = router;
