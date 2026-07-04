const express = require("express");
const router = express.Router();

const {
  getAllUsers,
  getUserById,
  adminUpdateUser,
  toggleUserStatus,
  deleteUser,
  getMyProfile,
  updateMyProfile,
  changeMyPassword,
  deactivateMyAccount,
  deleteMyAccount,
  getMyAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
} = require("../controllers/userController.js");

const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");
// Self (any logged-in user)
router.get("/me", authenticate, getMyProfile);
router.put("/me/update", authenticate, updateMyProfile);
router.put("/me/password", authenticate, changeMyPassword);

router.post("/me/deactivate", authenticate, deactivateMyAccount);
router.post("/me/delete", authenticate, deleteMyAccount);

// Addresses
router.get("/me/addresses", authenticate, getMyAddresses);
router.post("/me/add-address", authenticate, addAddress);
router.put("/me/update-address", authenticate, updateAddress); // addressId -> body
router.delete("/me/delete-address", authenticate, deleteAddress); // addressId -> body

// Admin
router.get("/get-all", authenticate, isAdmin, getAllUsers); // ?role= ?status= ?search= ?page= ?limit=
router.get("/get-by-id", authenticate, isAdmin, getUserById); // ?id=
router.put("/update-user", authenticate, isAdmin, adminUpdateUser); // id -> body
router.patch("/toggle-status", authenticate, isAdmin, toggleUserStatus); // id -> body
router.delete("/delete-user", authenticate, isAdmin, deleteUser); // id -> body
module.exports = router;
