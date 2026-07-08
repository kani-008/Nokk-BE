const db = require("../config/db.js");

// ==================================================================
// PUBLIC — POST /api/newsletter/subscribe
// ==================================================================
async function subscribeNewsletter(req, res) {
  const email = req.body.email ? String(req.body.email).trim().toLowerCase() : "";
  console.log(`[newsletter/subscribe] REQUEST | email: "${email}"`);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.log(`[newsletter/subscribe] STATUS 400 | reason: invalid email format | email: "${email}"`);
    return res.status(400).json({ success: false, message: "Please enter a valid email address." });
  }

  try {
    const existingRes = await db.query(
      "SELECT * FROM newsletter_subscribers WHERE email = $1",
      [email]
    );

    if (existingRes.rows.length > 0) {
      const subscriber = existingRes.rows[0];
      if (subscriber.is_active) {
        console.log(`[newsletter/subscribe] STATUS 200 | email: "${email}" already active (quiet success)`);
        return res.status(200).json({ success: true });
      } else {
        await db.query(
          "UPDATE newsletter_subscribers SET is_active = TRUE, subscribed_at = NOW() WHERE email = $1",
          [email]
        );
        console.log(`[newsletter/subscribe] STATUS 200 | email: "${email}" resubscribed`);
        return res.status(200).json({ success: true });
      }
    }

    await db.query(
      "INSERT INTO newsletter_subscribers (email) VALUES ($1)",
      [email]
    );
    console.log(`[newsletter/subscribe] STATUS 201 | email: "${email}" subscribed successfully`);
    return res.status(201).json({ success: true });
  } catch (err) {
    console.error(`[newsletter/subscribe] STATUS 500 | email: "${email}" | error: ${err.message}`, err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/newsletter/get-all
// ==================================================================
async function getAllSubscribers(req, res) {
  const adminId = req.user?.id || "unknown";
  console.log(`[newsletter/get-all] REQUEST | admin: ${adminId}`);

  try {
    const result = await db.query(
      "SELECT email, subscribed_at FROM newsletter_subscribers WHERE is_active = TRUE ORDER BY subscribed_at DESC"
    );
    console.log(`[newsletter/get-all] STATUS 200 | count: ${result.rows.length}`);
    return res.json({ success: true, subscribers: result.rows });
  } catch (err) {
    console.error(`[newsletter/get-all] STATUS 500 | admin: ${adminId} | error: ${err.message}`, err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { subscribeNewsletter, getAllSubscribers };