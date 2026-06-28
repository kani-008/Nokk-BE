const express = require("express");
const router  = express.Router();
const { upload, uploadProduct, uploadBannerFile, uploadProductImage, deleteUploadedFile } = require("../controllers/uploadController.js");
const { authenticate, isAdmin } = require("../middleware/auth.js");

// POST /api/upload/banner  — field: "file", kind: "video"|"image", max 100 MB
router.post("/banner",  authenticate, isAdmin, upload.single("file"),        uploadBannerFile);

// POST /api/upload/product — fields: "file" (JPEG/PNG/WebP, max 5 MB), "slug" (required, sets folder: product/{slug}/)
router.post("/product", authenticate, isAdmin, uploadProduct.single("file"), uploadProductImage);

// DELETE /api/upload/delete-file — body: { url }
router.delete("/delete-file", authenticate, isAdmin, deleteUploadedFile);

module.exports = router;