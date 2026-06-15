const express  = require("express");
const router   = express.Router();

const {
  getAllCategories, getCategoryBySlug,
  createCategory, updateCategory, deleteCategory
} = require("../controllers/categoryController.js");

const authenticate = require("../middleware/auth.js");
const { isAdmin }  = require("../middleware/auth.js");

// ── Public ────────────────────────────────────────────────────────
router.get("/",        getAllCategories);   // All active categories
router.get("/:slug",   getCategoryBySlug); // Category + its products

// ── Admin ─────────────────────────────────────────────────────────
router.post  ("/",     authenticate, isAdmin, createCategory);
router.put   ("/:id",  authenticate, isAdmin, updateCategory);
router.delete("/:id",  authenticate, isAdmin, deleteCategory);

module.exports = router;