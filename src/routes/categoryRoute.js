const express = require("express");
const router = express.Router();

const {
  getAllCategories,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
} = require("../controllers/categoryController.js");

const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");

// Public
router.get("/get-all", getAllCategories); // all active categories
router.get("/get-by-slug", getCategoryBySlug); // ?slug=  (category + products)

// Admin
router.post("/create-category", authenticate, isAdmin, createCategory);
router.put("/update-category", authenticate, isAdmin, updateCategory); // id -> body
router.delete("/delete-category", authenticate, isAdmin, deleteCategory); // id -> body
module.exports = router;
