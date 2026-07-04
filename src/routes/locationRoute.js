const express = require("express");
const router = express.Router();
const { lookupPincode, reverseGeocode } = require("../controllers/locationController.js");
const { lookupLimiter } = require("../middleware/ratelimiter.js");

router.get("/pincode", lookupLimiter, lookupPincode); // public — ?pincode=600001
router.get("/reverse-geocode", lookupLimiter, reverseGeocode); // public — ?lat=..&lng=..

module.exports = router;
