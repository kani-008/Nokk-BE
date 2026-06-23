const express  = require("express");
const router   = express.Router();
const { getBanners, getAllBanners, createBanner, updateBanner, deleteBanner } = require("../controllers/bannerController.js");
const { authenticate, isAdmin } = require("../middleware/auth.js");

router.get   ("/get-banners",    getBanners);                            // public — active only
router.get   ("/get-all",        authenticate, isAdmin, getAllBanners);  // admin  — incl. inactive
router.post  ("/create-banner",  authenticate, isAdmin, createBanner);
router.put   ("/update-banner",  authenticate, isAdmin, updateBanner);   // id  -> body
router.delete("/delete-banner",  authenticate, isAdmin, deleteBanner);   // id  -> body

module.exports = router;