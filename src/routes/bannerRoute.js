const express  = require("express");
const router   = express.Router();
const { getBanners, getAllBanners, createBanner, updateBanner, deleteBanner } = require("../controllers/bannerController.js");
const { authenticate, isAdmin } = require("../middleware/auth.js");
const { upload } = require("../controllers/uploadController.js");

// image + video fields for create / update
const bannerUpload = upload.fields([
  { name: "imageFile", maxCount: 1 },
  { name: "videoFile", maxCount: 1 },
]);

router.get   ("/get-banners",   getBanners);
router.get   ("/get-all",       authenticate, isAdmin, getAllBanners);
router.post  ("/create-banner", authenticate, isAdmin, bannerUpload, createBanner);
router.put   ("/update-banner", authenticate, isAdmin, bannerUpload, updateBanner);
router.delete("/delete-banner", authenticate, isAdmin, deleteBanner);

module.exports = router;
