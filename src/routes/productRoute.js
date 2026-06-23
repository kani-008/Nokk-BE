const express = require("express");
const router = express.Router();

const {
  getAllProducts,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct,
  addVariant,
  updateVariant,
  deleteVariant,
  addImage,
  deleteImage,
  addReview,
  deleteReview,
} = require("../controllers/productController.js");

const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");

// Public
router.get("/get-all", getAllProducts); // ?category= ?search= ?sort= ?inStock= ?isBestseller= ?isNew= ?page= ?limit=
router.get("/get-by-slug", getProductBySlug); // ?slug=

// Customer (login required)
router.post("/add-review", authenticate, addReview); // productId -> body

// Admin — product
router.post("/create-product", authenticate, isAdmin, createProduct);
router.put("/update-product", authenticate, isAdmin, updateProduct); // id -> body
router.delete("/delete-product", authenticate, isAdmin, deleteProduct); // id -> body

// Admin — variants
router.post("/add-variant", authenticate, isAdmin, addVariant); // productId -> body
router.put("/update-variant", authenticate, isAdmin, updateVariant); // productId, variantId -> body
router.delete("/delete-variant", authenticate, isAdmin, deleteVariant); // productId, variantId -> body

// Admin — images
router.post("/add-image", authenticate, isAdmin, addImage); // productId -> body
router.delete("/delete-image", authenticate, isAdmin, deleteImage); // productId, imageId -> body

// Admin — reviews
router.delete("/delete-review", authenticate, isAdmin, deleteReview); // productId, reviewId -> body
module.exports = router;
