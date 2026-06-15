const express  = require("express");
const router   = express.Router();
const {
  getActiveOffers, getAllOffers, getOfferById,
  createOffer, updateOffer, deleteOffer
} = require("../controllers/offersController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin }  = require("../middleware/auth.js");

// Public — live offers only
router.get("/",        getActiveOffers);

// Admin
router.get("/all",     authenticate, isAdmin, getAllOffers);
router.get("/:id",     authenticate, isAdmin, getOfferById);
router.post("/",       authenticate, isAdmin, createOffer);
router.put("/:id",     authenticate, isAdmin, updateOffer);
router.delete("/:id",  authenticate, isAdmin, deleteOffer);

module.exports = router;