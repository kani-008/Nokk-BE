const express = require("express");
const router = express.Router();
const {
  getActiveOffers,
  getActiveStoreWideOffer,
  getAllOffers,
  getOfferById,
  createOffer,
  updateOffer,
  deleteOffer,
} = require("../controllers/offersController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");
const { uploadProduct } = require("../controllers/uploadController.js");

const offerUpload = uploadProduct.single("imageFile");

// Public — live offers only
router.get("/get-active", getActiveOffers);
router.get("/active-storewide", getActiveStoreWideOffer);

// Admin
router.get("/get-all", authenticate, isAdmin, getAllOffers);
router.get("/get-by-id", authenticate, isAdmin, getOfferById); // ?id=
router.post("/create-offer", authenticate, isAdmin, offerUpload, createOffer);
router.put("/update-offer", authenticate, isAdmin, offerUpload, updateOffer); // id -> body
router.delete("/delete-offer", authenticate, isAdmin, deleteOffer); // id -> body
module.exports = router;
