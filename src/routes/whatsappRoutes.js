const express = require("express");
const router = express.Router();
const { verifyWebhook, receiveWebhook, testSend } = require("../controllers/whatsappWebhookController.js");
const authenticate = require("../middleware/auth.js");
const { isAdmin } = require("../middleware/auth.js");

// Public endpoints for Meta Webhook configuration and incoming webhooks
router.get("/webhook", verifyWebhook);
router.post("/webhook", receiveWebhook);

// Admin-only endpoint for manual message testing
router.post("/test-send", authenticate, isAdmin, testSend);

module.exports = router;
