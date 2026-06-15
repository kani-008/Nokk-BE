const express  = require("express");
const router   = express.Router();
const { getBanners, getAllBanners, createBanner, updateBanner, deleteBanner } = require("../controllers/bannerController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin }  = require("../middleware/auth.js");

router.get("/",        getBanners);                              // public  — active only
router.get("/all",     authenticate, isAdmin, getAllBanners);    // admin   — all including inactive
router.post("/",       authenticate, isAdmin, createBanner);
router.put("/:id",     authenticate, isAdmin, updateBanner);
router.delete("/:id",  authenticate, isAdmin, deleteBanner);

module.exports = router;