const express = require("express");
const router  = express.Router();
const {
  addReview, deleteReview,
  updateReview, deleteMyReview, getMyReviewForProduct,
  adminGetAllReviews, adminApproveReview,
} = require("../controllers/reviewController.js");
const { authenticate, isAdmin } = require("../middleware/auth.js");

// Mounted at /api/products alongside productRoute so URLs are unchanged
// (e.g. POST /api/products/add-review) while the controller/route code
// for reviews lives in its own file.

// Customer (login required)
router.post  ("/add-review",       authenticate, addReview);
router.put   ("/update-review",    authenticate, updateReview);
router.delete("/delete-my-review", authenticate, deleteMyReview);
router.get   ("/get-my-review",    authenticate, getMyReviewForProduct);

// Admin — moderation
router.delete("/delete-review",        authenticate, isAdmin, deleteReview);
router.get   ("/admin-reviews",        authenticate, isAdmin, adminGetAllReviews);
router.put   ("/admin-approve-review", authenticate, isAdmin, adminApproveReview);

module.exports = router;
