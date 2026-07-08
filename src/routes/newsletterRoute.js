const express = require("express");
const router = express.Router();
const {
  subscribeNewsletter,
  getAllSubscribers,
} = require("../controllers/newsletterController.js");
const { newsletterLimiter } = require("../middleware/ratelimiter.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");

router.post("/subscribe", newsletterLimiter, subscribeNewsletter); // public
router.get("/get-all", authenticate, isAdmin, getAllSubscribers);   // admin only

module.exports = router;