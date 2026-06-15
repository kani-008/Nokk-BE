const express  = require("express");
const router   = express.Router();

const {
  getAllUsers, getUserById, adminUpdateUser, toggleUserStatus, deleteUser,
  getMyProfile, updateMyProfile, changeMyPassword,
  getMyAddresses, addAddress, updateAddress, deleteAddress
} = require("../controllers/userController.js");

const authenticate = require("../middleware/auth.js");
const { isAdmin }  = require("../middleware/auth.js");

// ── Self routes (any logged-in user) ──────────────────────────────
router.get   ("/me",                        authenticate, getMyProfile);
router.put   ("/me",                        authenticate, updateMyProfile);
router.put   ("/me/password",               authenticate, changeMyPassword);

// Addresses
router.get   ("/me/addresses",              authenticate, getMyAddresses);
router.post  ("/me/addresses",              authenticate, addAddress);
router.put   ("/me/addresses/:addressId",   authenticate, updateAddress);
router.delete("/me/addresses/:addressId",   authenticate, deleteAddress);

// ── Admin routes ──────────────────────────────────────────────────
// ?role=  ?status=  ?search=  ?page=  ?limit=
router.get   ("/",              authenticate, isAdmin, getAllUsers);
router.get   ("/:id",           authenticate, isAdmin, getUserById);
router.put   ("/:id",           authenticate, isAdmin, adminUpdateUser);
router.patch ("/:id/status",    authenticate, isAdmin, toggleUserStatus);
router.delete("/:id",           authenticate, isAdmin, deleteUser);

module.exports = router;