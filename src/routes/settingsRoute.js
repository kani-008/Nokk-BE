const express  = require("express");
const router   = express.Router();
const { getSettings, updateSettings, getSetting } = require("../controllers/settingsController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin }  = require("../middleware/auth.js");

router.get("/",       getSettings);                              // public
router.get("/:key",   authenticate, isAdmin, getSetting);        // admin — single key
router.put("/",       authenticate, isAdmin, updateSettings);    // admin — bulk upsert

module.exports = router;