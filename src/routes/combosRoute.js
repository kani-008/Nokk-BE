const express = require("express");
const router = express.Router();
const {
  getActiveCombos,
  getAllCombos,
  getComboById,
  createCombo,
  updateCombo,
  deleteCombo,
  getPublicComboDetail,
} = require("../controllers/combosController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");
const { uploadProduct } = require("../controllers/uploadController.js");

const comboUpload = uploadProduct.array("imageFiles", 5);

// Public — live combos only
router.get("/get-active", getActiveCombos);
router.get("/get-public-detail", getPublicComboDetail);

// Admin
router.get("/get-all", authenticate, isAdmin, getAllCombos);
router.get("/get-by-id", authenticate, isAdmin, getComboById); // ?id=
router.post("/create-combo", authenticate, isAdmin, comboUpload, createCombo);
router.put("/update-combo", authenticate, isAdmin, comboUpload, updateCombo); // id -> body
router.delete("/delete-combo", authenticate, isAdmin, deleteCombo); // id -> body
module.exports = router;
