const express = require("express");
const router  = express.Router();
const { getAllCategories, getCategoryBySlug, createCategory, updateCategory, deleteCategory, adminGetAllCategories } = require("../controllers/categoryController.js");
const { authenticate, isAdmin } = require("../middleware/auth.js");
const { uploadProduct } = require("../controllers/uploadController.js");

const categoryUpload = uploadProduct.single("imageFile");

router.get   ("/get-all",          getAllCategories);
router.get   ("/get-by-slug",      getCategoryBySlug);
router.get   ("/admin-all",        authenticate, isAdmin, adminGetAllCategories);
router.post  ("/create-category",  authenticate, isAdmin, categoryUpload, createCategory);
router.put   ("/update-category",  authenticate, isAdmin, categoryUpload, updateCategory);
router.delete("/delete-category",  authenticate, isAdmin, deleteCategory);

module.exports = router;
