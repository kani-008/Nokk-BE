const { sendWhatsAppTemplate } = require("../services/whatsappService.js");

/**
 * Handles GET /api/whatsapp/webhook
 * Verification of the webhook endpoint by Meta
 */
function verifyWebhook(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("[WhatsApp Webhook] Verification successful.");
    return res.status(200).send(challenge);
  } else {
    console.warn(`[WhatsApp Webhook] Verification failed. Expected verify token: "${WHATSAPP_VERIFY_TOKEN}"`);
    console.warn(`Received query: ${JSON.stringify(req.query)}, url: ${req.originalUrl}`);
    return res.sendStatus(403);
  }
}

/**
 * Handles POST /api/whatsapp/webhook
 * Receives incoming messages and delivery status updates from Meta
 */
function receiveWebhook(req, res) {
  // Meta requires an immediate 200 OK response to avoid retries
  res.sendStatus(200);

  // Process asynchronously (fire-and-forget)
  try {
    const changeValue = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!changeValue) {
      return;
    }

    // 1. Process incoming messages (from customers)
    const messages = changeValue.messages;
    if (messages && messages.length > 0) {
      messages.forEach((msg) => {
        const waId = msg.from;
        const bodyText = msg.text?.body;
        console.log(`[WhatsApp Webhook] Incoming message from wa_id: ${waId} | Text: "${bodyText || ""}"`);
      });
    }

    // 2. Process message delivery statuses (messages we sent)
    const statuses = changeValue.statuses;
    if (statuses && statuses.length > 0) {
      statuses.forEach((statusObj) => {
        const messageId = statusObj.id;
        const status = statusObj.status; // sent, delivered, read, failed
        const recipientId = statusObj.recipient_id;
        const error = statusObj.errors?.[0];

        if (status === "failed") {
          console.error(
            `[WA_STATUS] Delivery failed for messageId: ${messageId} to ${recipientId} | Code: ${error?.code} | Error: ${error?.message || error?.title}`
          );
        } else {
          console.log(`[WA_STATUS] status: ${status} | messageId: ${messageId} | recipient: ${recipientId}`);
        }
      });
    }
  } catch (error) {
    console.error("[WhatsApp Webhook Error] Failed to process webhook payload:", error.message);
  }
}

/**
 * Handles POST /api/whatsapp/test-send
 * Admin-only utility to manually test message sending.
 */
async function testSend(req, res) {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, message: "phone and message are required" });
  }

  try {
    const messageId = await sendWhatsAppTemplate(phone, message);
    return res.json({
      success: true,
      message: "Test message sent successfully",
      messageId,
    });
  } catch (error) {
    console.error("[WhatsApp Webhook Controller] Test send failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to send test message",
      error: error.message,
    });
  }
}

module.exports = {
  verifyWebhook,
  receiveWebhook,
  testSend,
};
