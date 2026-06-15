const express  = require("express");
const router   = express.Router();

const {
  getAllProducts, getProductBySlug,
  createProduct, updateProduct, deleteProduct,
  addVariant, updateVariant, deleteVariant,
  addImage, deleteImage,
  addReview, deleteReview
} = require("../controllers/productController.js");

const authenticate = require("../middleware/auth.js");
const { isAdmin }  = require("../middleware/auth.js");

// ── Public ────────────────────────────────────────────────────────
// ?category= ?search= ?sort= ?inStock= ?isBestseller= ?isNew= ?page= ?limit=
router.get("/",           getAllProducts);
router.get("/:slug",      getProductBySlug);

// ── Customer (login required) ─────────────────────────────────────
router.post("/:id/reviews",                  authenticate, addReview);

// ── Admin ─────────────────────────────────────────────────────────
router.post  ("/",                           authenticate, isAdmin, createProduct);
router.put   ("/:id",                        authenticate, isAdmin, updateProduct);
router.delete("/:id",                        authenticate, isAdmin, deleteProduct);

// Variants
router.post  ("/:id/variants",               authenticate, isAdmin, addVariant);
router.put   ("/:id/variants/:variantId",    authenticate, isAdmin, updateVariant);
router.delete("/:id/variants/:variantId",    authenticate, isAdmin, deleteVariant);

// Images
router.post  ("/:id/images",                 authenticate, isAdmin, addImage);
router.delete("/:id/images/:imageId",        authenticate, isAdmin, deleteImage);

// Reviews (admin delete)
router.delete("/:id/reviews/:reviewId",      authenticate, isAdmin, deleteReview);

module.exports = router;