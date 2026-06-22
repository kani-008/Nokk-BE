const express = require("express");
const router  = express.Router();
const {
  getBtextByBanner,
  getAllBtext,
  getBtextForBanner,
  createBtext,
  updateBtext,
  deleteBtext
} = require("../controllers/btextController.js");
const { authenticate, isAdmin } = require("../middleware/auth.js");

router.get("/",                   getBtextByBanner);                          // public  — ?bannerId=<id>
router.get("/all",                authenticate, isAdmin, getAllBtext);         // admin   — all entries
router.get("/banner/:bannerId",   authenticate, isAdmin, getBtextForBanner);  // admin   — by banner
router.post("/",                  authenticate, isAdmin, createBtext);
router.put("/:id",                authenticate, isAdmin, updateBtext);
router.delete("/:id",             authenticate, isAdmin, deleteBtext);

module.exports = router;
