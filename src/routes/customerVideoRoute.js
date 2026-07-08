const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");
const {
  getActiveCustomerVideos,
  getAllCustomerVideos,
  createCustomerVideo,
  updateCustomerVideo,
  deleteCustomerVideo,
} = require("../controllers/customerVideoController.js");

router.get("/get-active", getActiveCustomerVideos); // public

router.use(authenticate, isAdmin); // everything below is admin-only

router.get("/get-all", getAllCustomerVideos);
router.post("/create", createCustomerVideo);
router.put("/update", updateCustomerVideo);
router.delete("/delete", deleteCustomerVideo);

module.exports = router;
