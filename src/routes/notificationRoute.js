const express = require("express");
const router = express.Router();
const {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
} = require("../controllers/notificationController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");

// All notification routes — admin only. This is an internal admin
// event feed (new orders, reviews, stock changes, etc), not a
// customer-facing inbox.
router.use(authenticate, isAdmin);

router.get("/list", listNotifications);              // ?page= ?limit= ?eventType= ?priority= ?unreadOnly=
router.get("/unread-count", getUnreadCount);          // badge count for the bell icon
router.patch("/mark-read", markRead);                 // notificationId -> body
router.patch("/mark-all-read", markAllRead);
router.delete("/delete", deleteNotification);         // notificationId -> body

module.exports = router;