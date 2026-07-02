const express = require("express");
const router  = express.Router();
const {
  getAllProducts, getProductBySlug, getWeightLabels, getSimilarProducts,
  createProduct, updateProduct, deleteProduct,
  addVariant, updateVariant, deleteVariant,
  addImage, addImages, deleteImage,
} = require("../controllers/productController.js");
const { authenticate, isAdmin } = require("../middleware/auth.js");
const { uploadProduct } = require("../controllers/uploadController.js");

const productImageUpload = uploadProduct.single("imageFile");
const productImagesUpload = uploadProduct.array("imageFiles", 5); // max 5 per request

// Public
router.get("/get-all",       getAllProducts);
router.get("/get-by-slug",   getProductBySlug);
router.get("/weight-labels", getWeightLabels);
router.get("/similar",       getSimilarProducts);

// Admin — product
router.post  ("/create-product", authenticate, isAdmin, createProduct);
router.put   ("/update-product", authenticate, isAdmin, updateProduct);
router.delete("/delete-product", authenticate, isAdmin, deleteProduct);

// Admin — variants
router.post  ("/add-variant",    authenticate, isAdmin, addVariant);
router.put   ("/update-variant", authenticate, isAdmin, updateVariant);
router.delete("/delete-variant", authenticate, isAdmin, deleteVariant);

// Admin — images
router.post  ("/add-image",    authenticate, isAdmin, productImageUpload,  addImage);
router.post  ("/add-images",   authenticate, isAdmin, productImagesUpload, addImages); // bulk, 3-5 typical
router.delete("/delete-image", authenticate, isAdmin, deleteImage);

// Review routes (add/update/delete-my/get-my/delete) now live in
// reviewRoute.js, mounted separately at /api/products in server.js.

module.exports = router;
