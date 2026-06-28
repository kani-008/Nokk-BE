const express = require("express");
const router = express.Router();
const { getByPincode } = require("../controllers/pincodeController.js");

// Public — no auth required; used during address entry / checkout
router.get("/get-by-pincode", getByPincode); // ?pincode=600001

module.exports = router;
