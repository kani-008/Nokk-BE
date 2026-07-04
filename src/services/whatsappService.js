const axios = require("axios");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
  throw new Error(
    "FATAL: WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN env vars must be set"
  );
}

const WHATSAPP_API_URL = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

/**
 * Normalizes a phone number to E.164 without '+'
 * - Strips '+', spaces, hyphens
 * - If number doesn't start with country code and is 10 digits, assumes India prefix '91'
 */
function normalizePhoneNumber(phone) {
  if (typeof phone !== "string") {
    phone = String(phone);
  }
  let cleaned = phone.replace(/[+\s-]/g, "");
  if (cleaned.length === 10 && /^\d+$/.test(cleaned)) {
    cleaned = "91" + cleaned;
  }
  return cleaned;
}

/**
 * Sends a plaintext WhatsApp message to a phone number using Meta Cloud API
 */
async function sendWhatsAppText(toPhone, bodyText) {
  const normalizedPhone = normalizePhoneNumber(toPhone);

  if (process.env.NODE_ENV !== "production") {
    console.log(`[WhatsApp Service] Sending message to ${normalizedPhone}: "${bodyText}"`);
  } else {
    console.log(`[WhatsApp Service] Sending message to ${normalizedPhone}`);
  }

  try {
    const response = await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: "whatsapp",
        to: normalizedPhone,
        type: "text",
        text: {
          body: bodyText,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    const messageId = response.data?.messages?.[0]?.id;
    if (!messageId) {
      throw new Error("Invalid response format from Meta API: missing message ID");
    }
    return messageId;
  } catch (error) {
    if (error.response) {
      console.error(
        "[WhatsApp Service Error] Meta API error payload:",
        JSON.stringify(error.response.data, null, 2)
      );
    } else {
      console.error("[WhatsApp Service Error]:", error.message);
    }
    throw new Error(`Failed to send WhatsApp message: ${error.message}`);
  }
}

/**
 * Generates a 6-digit OTP, hashes it, sends it via WhatsApp, and returns the hash and message ID.
 */
async function generateAndSendOtp(phone) {
  // Generate a random 6-digit OTP as a string
  const otp = String(crypto.randomInt(100000, 999999));
  
  // Hash it
  const otpHash = await bcrypt.hash(otp, 10);
  
  // Compose message
  const message = `Your Namma Oor Karuvattu Kadai OTP is ${otp}. Valid for 10 minutes. Do not share this with anyone.`;
  
  // Send via WhatsApp
  const messageId = await sendWhatsAppText(phone, message);
  
  return { otpHash, messageId };
}

/**
 * Verifies a plain OTP against a stored hash
 */
async function verifyOtpHash(plainOtp, storedHash) {
  if (!storedHash) {
    return false;
  }
  try {
    return await bcrypt.compare(String(plainOtp).trim(), storedHash);
  } catch (err) {
    console.error("[WhatsApp Service] Error during OTP comparison:", err.message);
    return false;
  }
}

module.exports = {
  sendWhatsAppText,
  generateAndSendOtp,
  verifyOtpHash,
};
