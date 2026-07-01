const axios = require("axios");

const TWOFACTOR_API_KEY = process.env.TWOFACTOR_API_KEY;
if (!TWOFACTOR_API_KEY) {
  throw new Error("FATAL: TWOFACTOR_API_KEY env var must be set");
}

async function sendOtp(phone, templateName) {
  const tenDigit = String(phone).replace(/\D/g, "").slice(-10);
  const url = `https://2factor.in/API/V1/${TWOFACTOR_API_KEY}/SMS/${tenDigit}/AUTOGEN2/${templateName}`;
  try {
    const res = await axios.get(url);
    if (res.data.Status !== "Success") {
      throw new Error(`2Factor sendOTP failed: ${res.data.Details}`);
    }
    return res.data.Details;
  } catch (err) {
    const detail = err.response?.data?.Details || err.message;
    throw new Error(`2Factor sendOTP failed: ${detail}`);
  }
}

async function verifyOtp(phone, sessionId, otp) {
  const url = `https://2factor.in/API/V1/${TWOFACTOR_API_KEY}/SMS/VERIFY/${sessionId}/${otp}`;
  try {
    const res = await axios.get(url);
    if (res.data.Status !== "Success") {
      throw new Error(`2Factor verifyOTP failed: ${res.data.Details}`);
    }
    return true;
  } catch (err) {
    const detail = err.response?.data?.Details || err.message;
    throw new Error(`2Factor verifyOTP failed: ${detail}`);
  }
}

module.exports = { sendOtp, verifyOtp };