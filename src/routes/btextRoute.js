const express = require("express");
const router = express.Router();
const {
  getBtextByBanner,
  getAllBtext,
  getBtextForBanner,
  createBtext,
  updateBtext,
  deleteBtext,
} = require("../controllers/btextController.js");
const { authenticate, isAdmin } = require("../middleware/auth.js");

router.get("/get-by-banner", getBtextByBanner); // public — ?bannerId=
router.get("/get-all", authenticate, isAdmin, getAllBtext); // admin  — all
router.get("/get-for-banner", authenticate, isAdmin, getBtextForBanner); // admin  — ?bannerId=
router.post("/create-btext", authenticate, isAdmin, createBtext);
router.put("/update-btext", authenticate, isAdmin, updateBtext); // id  -> body
router.delete("/delete-btext", authenticate, isAdmin, deleteBtext); // id  -> body

module.exports = router;
