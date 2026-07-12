const nodemailer = require("nodemailer");
const db = require("../config/db.js");

async function sendAdminOrderEmail(orderId) {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminEmailAppPassword = process.env.ADMIN_EMAIL_APP_PASSWORD;

  if (!adminEmail || !adminEmailAppPassword) {
    console.warn("[EmailService] ADMIN_EMAIL or ADMIN_EMAIL_APP_PASSWORD not configured. Skipping order email notification.");
    return;
  }

  try {
    // 1. Fetch order details from database
    const orderRes = await db.query("SELECT total, address FROM orders WHERE id = $1", [orderId]);
    if (orderRes.rows.length === 0) {
      console.warn(`[EmailService] Order ${orderId} not found in database. Skipping email.`);
      return;
    }
    const order = orderRes.rows[0];
    const customerName = order.address?.fullName || "Customer";
    const total = order.total;

    // 2. Fetch order items
    const itemsRes = await db.query("SELECT name_en, quantity, weight FROM order_items WHERE order_id = $1", [orderId]);
    const items = itemsRes.rows;

    const itemsListHtml = items.map(item => {
      const weightStr = item.weight ? `(${item.weight})` : "";
      return `<li>${item.name_en} ${weightStr} x ${item.quantity}</li>`;
    }).join("");

    const itemsListText = items.map(item => {
      const weightStr = item.weight ? `(${item.weight})` : "";
      return `- ${item.name_en} ${weightStr} x ${item.quantity}`;
    }).join("\n");

    // 3. Configure SMTP transporter
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: adminEmail,
        pass: adminEmailAppPassword,
      },
    });

    const viewLink = `${process.env.ADMIN_PANEL_URL || "http://localhost:5173"}/admin/orders`;

    const mailOptions = {
      from: `"Namma Oor Karuvattu Kadai" <${adminEmail}>`,
      to: adminEmail,
      subject: `New Order Received — ₹${total}`,
      text: `New Order Received!\n\nOrder ID: #${orderId}\nCustomer: ${customerName}\nTotal Amount: ₹${total}\n\nItems Ordered:\n${itemsListText}\n\nView this order in the admin panel:\n${viewLink}\n`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #854d0e; border-bottom: 2px solid #854d0e; padding-bottom: 10px;">New Order Received!</h2>
          <p><strong>Order ID:</strong> #${orderId}</p>
          <p><strong>Customer Name:</strong> ${customerName}</p>
          <p><strong>Total Amount:</strong> ₹${total}</p>
          
          <h3 style="color: #854d0e; margin-top: 20px;">Items Ordered</h3>
          <ul style="padding-left: 20px; line-height: 1.6;">
            ${itemsListHtml}
          </ul>
          
          <div style="margin-top: 30px; text-align: center;">
            <a href="${viewLink}" style="background-color: #854d0e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              View Orders in Admin Panel
            </a>
          </div>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] Notification email sent for order ${orderId}: ${info.messageId}`);
  } catch (err) {
    console.warn(`[EmailService] Failed to send notification email for order ${orderId}:`, err.message);
  }
}

module.exports = {
  sendAdminOrderEmail,
};
