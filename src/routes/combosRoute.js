const express = require("express");
const router = express.Router();
const {
  getActiveCombos,
  getAllCombos,
  getComboById,
  createCombo,
  updateCombo,
  deleteCombo,
} = require("../controllers/combosController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");
const { uploadProduct } = require("../controllers/uploadController.js");

const comboUpload = uploadProduct.single("imageFile");

// Public — live combos only
router.get("/get-active", getActiveCombos);
router.get("/get-by-id", getComboById); // ?id=

// Admin
router.get("/get-all", authenticate, isAdmin, getAllCombos);
router.post("/create-combo", authenticate, isAdmin, comboUpload, createCombo);
router.put("/update-combo", authenticate, isAdmin, comboUpload, updateCombo); // id -> body
router.delete("/delete-combo", authenticate, isAdmin, deleteCombo); // id -> body
module.exports = router;
