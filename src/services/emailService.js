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
    const orderRes = await db.query(
      `SELECT total, customer_name, customer_phone, customer_email, 
              payment_method, payment_status, 
              shipping_address_line1, shipping_address_line2, shipping_taluk, 
              shipping_city, shipping_state, shipping_pincode 
       FROM orders WHERE id = $1`,
      [orderId]
    );
    if (orderRes.rows.length === 0) {
      console.warn(`[EmailService] Order ${orderId} not found in database. Skipping email.`);
      return;
    }
    const order = orderRes.rows[0];
    const customerName = order.customer_name || "Customer";
    const customerPhone = order.customer_phone || "—";
    const customerEmail = order.customer_email || "";
    const total = order.total;
    const paymentMethod = order.payment_method || "—";
    const paymentStatus = order.payment_status || "—";

    // Format delivery address block
    const addressParts = [
      order.shipping_address_line1,
      order.shipping_address_line2,
      order.shipping_taluk ? `${order.shipping_taluk} (Taluk)` : null,
      order.shipping_city,
      order.shipping_state,
      order.shipping_pincode
    ].filter(Boolean);
    const formattedAddress = addressParts.join(", ");

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
      text: `New Order Received!\n\nOrder ID: #${orderId}\nTotal Amount: ₹${total}\n\nCustomer Details:\n- Name: ${customerName}\n- Phone: ${customerPhone}\n${customerEmail ? `- Email: ${customerEmail}\n` : ""} - Delivery Address: ${formattedAddress}\n\nPayment Details:\n- Method: ${paymentMethod.toUpperCase()}\n- Status: ${paymentStatus.toUpperCase()}\n\nItems Ordered:\n${itemsListText}\n\nView this order in the admin panel:\n${viewLink}\n`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #854d0e; border-bottom: 2px solid #854d0e; padding-bottom: 10px; margin-top: 0;">New Order Received!</h2>
          <p style="margin: 8px 0;"><strong>Order ID:</strong> #${orderId}</p>
          <p style="margin: 8px 0;"><strong>Total Amount:</strong> ₹${total}</p>
          
          <h3 style="color: #854d0e; margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 5px; font-size: 16px;">Customer Details</h3>
          <p style="margin: 6px 0;"><strong>Name:</strong> ${customerName}</p>
          <p style="margin: 6px 0;"><strong>Phone:</strong> ${customerPhone}</p>
          ${customerEmail ? `<p style="margin: 6px 0;"><strong>Email:</strong> ${customerEmail}</p>` : ""}
          <p style="margin: 6px 0; line-height: 1.4;"><strong>Delivery Address:</strong> ${formattedAddress}</p>

          <h3 style="color: #854d0e; margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 5px; font-size: 16px;">Payment Details</h3>
          <p style="margin: 6px 0;"><strong>Method:</strong> <span style="text-transform: uppercase;">${paymentMethod}</span></p>
          <p style="margin: 6px 0;"><strong>Status:</strong> <span style="text-transform: uppercase;">${paymentStatus}</span></p>

          <h3 style="color: #854d0e; margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 5px; font-size: 16px;">Items Ordered</h3>
          <ul style="padding-left: 20px; line-height: 1.6; margin-top: 10px;">
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

async function sendAdminNotificationEmail(notification) {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminEmailAppPassword = process.env.ADMIN_EMAIL_APP_PASSWORD;

  if (!adminEmail || !adminEmailAppPassword) {
    console.warn("[EmailService] ADMIN_EMAIL or ADMIN_EMAIL_APP_PASSWORD not configured. Skipping admin notification email.");
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: adminEmail,
        pass: adminEmailAppPassword,
      },
    });

    const adminUrl = process.env.ADMIN_PANEL_URL || "http://localhost:5173";
    const notificationLink = notification.link ? `${adminUrl}${notification.link}` : adminUrl;

    const mailOptions = {
      from: `"Namma Oor Karuvattu Kadai" <${adminEmail}>`,
      to: adminEmail,
      subject: `[Action Needed] ${notification.title || "New Notification"}`,
      text: `${notification.message || ""}\n\nView and manage:\n${notificationLink}\n`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #b91c1c; border-bottom: 2px solid #b91c1c; padding-bottom: 10px; margin-top: 0;">Attention Required</h2>
          <p style="font-size: 16px; font-weight: bold; color: #111827; margin: 15px 0;">${notification.title || "New Notification"}</p>
          <p style="font-size: 14px; color: #4b5563; line-height: 1.6; margin: 15px 0;">${notification.message || ""}</p>
          
          <div style="margin-top: 30px; text-align: center;">
            <a href="${notificationLink}" style="background-color: #b91c1c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              View and Take Action
            </a>
          </div>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] Admin action notification email sent: ${info.messageId}`);
  } catch (err) {
    console.warn(`[EmailService] Failed to send admin notification email:`, err.message);
  }
}

module.exports = {
  sendAdminOrderEmail,
  sendAdminNotificationEmail,
};
