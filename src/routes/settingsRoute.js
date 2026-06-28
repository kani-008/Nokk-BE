const express = require("express");
const router = express.Router();
const {
  getSettings,
  updateSettings,
  getSetting,
} = require("../controllers/settingsController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");
router.get("/get-all", getSettings); // public
router.get("/get-one", authenticate, isAdmin, getSetting); // admin — ?key=
router.put("/update", authenticate, isAdmin, updateSettings); // admin — bulk upsert
module.exports = router;
