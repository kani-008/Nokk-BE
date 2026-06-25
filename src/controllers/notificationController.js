const db = require("../config/db.js");

// notifications table (admin-only event log) columns:
//   id, title, message, event_type, priority, entity_type, entity_id,
//   link, created_at
// notification_reads table (per-admin read receipts) columns:
//   id, notification_id, admin_id, read_at
//
// A notification has NO read state of its own — whether it's "read"
// depends entirely on whether a row exists in notification_reads for
// (notification_id, admin_id). No row = unread for that admin.

const VALID_EVENT_TYPES = [
  "new_order",
  "order_status_changed",
  "payment_failed",
  "return_requested",
  "new_review",
  "stock_changed",
  "new_signup",
  "coupon_limit_near",
];

const VALID_PRIORITIES = ["low", "normal", "high", "urgent"];

// ==================================================================
// INTERNAL HELPER — not an HTTP handler.
// Call this from other controllers whenever a notifiable event
// happens (new order, review, stock change, etc).
//
// Usage from another controller:
//   const { createNotification } = require("./notificationController.js");
//   await createNotification({
//     eventType: "new_order",
//     priority: "high",
//     title: "New Order Received",
//     message: `Order ${orderId} placed by ${customerName}`,
//     entityType: "orders",
//     entityId: orderId,
//   });
//
// Deliberately swallows its own errors (logs only) — a failed
// notification insert should never break the actual business
// operation (checkout, review submit, etc) that triggered it.
// ==================================================================
async function createNotification({
  eventType,
  title,
  message,
  priority = "normal",
  entityType = null,
  entityId = null,
  link = null,
}) {
  if (!VALID_EVENT_TYPES.includes(eventType)) {
    console.error({ fn: "createNotification", error: `Invalid eventType: ${eventType}` });
    return null;
  }
  if (!title || !message) {
    console.error({ fn: "createNotification", error: "title and message are required" });
    return null;
  }

  try {
    const result = await db.query(
      `INSERT INTO notifications (event_type, priority, title, message, entity_type, entity_id, link)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, event_type, priority, title, message, entity_type, entity_id, link, created_at`,
      [eventType, priority, title, message, entityType, entityId, link]
    );
    console.log({ fn: "createNotification", eventType, notificationId: result.rows[0].id, status: "created" });
    return result.rows[0];
  } catch (err) {
    // Never let a notification failure break the calling operation.
    console.error({ fn: "createNotification", eventType, error: err.message });
    return null;
  }
}

// ==================================================================
// ADMIN — GET /api/notifications/list
// Paginated feed for the admin bell dropdown / notifications page.
// Query: ?page=1  ?limit=20  ?eventType=new_order  ?priority=high
//        ?unreadOnly=true
// Read state is resolved per the calling admin (req.user.id).
// ==================================================================
async function listNotifications(req, res) {
  const adminId = req.user.id;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;
  const eventType = req.query.eventType || null;
  const priority = req.query.priority || null;
  const unreadOnly = req.query.unreadOnly === "true";

  console.log({ route: "GET /api/notifications/list", adminId, query: { page, limit, eventType, priority, unreadOnly }, status: "fetching" });

  try {
    const result = await db.query(
      `SELECT
         n.id, n.event_type, n.priority, n.title, n.message,
         n.entity_type, n.entity_id, n.link, n.created_at,
         nr.read_at
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.admin_id = $1
       WHERE
         ($2::text IS NULL OR n.event_type = $2) AND
         ($3::text IS NULL OR n.priority = $3) AND
         (NOT $4 OR nr.read_at IS NULL)
       ORDER BY n.created_at DESC
       LIMIT $5 OFFSET $6`,
      [adminId, eventType, priority, unreadOnly, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.admin_id = $1
       WHERE
         ($2::text IS NULL OR n.event_type = $2) AND
         ($3::text IS NULL OR n.priority = $3) AND
         (NOT $4 OR nr.read_at IS NULL)`,
      [adminId, eventType, priority, unreadOnly]
    );

    console.log({ route: "GET /api/notifications/list", adminId, status: 200, count: result.rows.length });
    return res.json({
      success: true,
      pagination: {
        page, limit,
        total: parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit),
      },
      notifications: result.rows.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        priority: r.priority,
        title: r.title,
        message: r.message,
        entityType: r.entity_type,
        entityId: r.entity_id,
        link: r.link,
        createdAt: r.created_at,
        isRead: r.read_at !== null,
        readAt: r.read_at,
      })),
    });
  } catch (err) {
    console.error({ route: "GET /api/notifications/list", adminId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/notifications/unread-count
// Single number for the bell icon badge.
// ==================================================================
async function getUnreadCount(req, res) {
  const adminId = req.user.id;
  console.log({ route: "GET /api/notifications/unread-count", adminId, status: "fetching" });

  try {
    const result = await db.query(
      `SELECT COUNT(*) AS unread
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.admin_id = $1
       WHERE nr.read_at IS NULL`,
      [adminId]
    );
    console.log({ route: "GET /api/notifications/unread-count", adminId, status: 200 });
    return res.json({ success: true, unreadCount: parseInt(result.rows[0].unread) });
  } catch (err) {
    console.error({ route: "GET /api/notifications/unread-count", adminId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PATCH /api/notifications/mark-read
// Marks ONE notification as read for the calling admin only.
// Body: { notificationId }
// Uses ON CONFLICT DO NOTHING since (notification_id, admin_id) is
// unique — calling this twice on the same notification is harmless.
// ==================================================================
async function markRead(req, res) {
  const adminId = req.user.id;
  const { notificationId } = req.body;
  console.log({ route: "PATCH /api/notifications/mark-read", adminId, notificationId, status: "marking read" });

  if (!notificationId) {
    console.log({ route: "PATCH /api/notifications/mark-read", adminId, status: 400, message: "notificationId is required" });
    return res.status(400).json({ success: false, message: "notificationId is required" });
  }

  try {
    await db.query(
      `INSERT INTO notification_reads (notification_id, admin_id)
       VALUES ($1, $2)
       ON CONFLICT (notification_id, admin_id) DO NOTHING`,
      [notificationId, adminId]
    );
    console.log({ route: "PATCH /api/notifications/mark-read", adminId, notificationId, status: 200 });
    return res.json({ success: true, message: "Notification marked as read" });
  } catch (err) {
    console.error({ route: "PATCH /api/notifications/mark-read", adminId, notificationId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PATCH /api/notifications/mark-all-read
// Marks every currently-unread notification as read for this admin.
// Uses a single INSERT ... SELECT so it's one round trip regardless
// of how many notifications are unread (same batching principle as
// the order-listing N+1 fix elsewhere in this codebase).
// ==================================================================
async function markAllRead(req, res) {
  const adminId = req.user.id;
  console.log({ route: "PATCH /api/notifications/mark-all-read", adminId, status: "marking all read" });

  try {
    const result = await db.query(
      `INSERT INTO notification_reads (notification_id, admin_id)
       SELECT n.id, $1
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.admin_id = $1
       WHERE nr.read_at IS NULL
       ON CONFLICT (notification_id, admin_id) DO NOTHING
       RETURNING id`,
      [adminId]
    );
    console.log({ route: "PATCH /api/notifications/mark-all-read", adminId, status: 200, markedCount: result.rows.length });
    return res.json({ success: true, message: `${result.rows.length} notification(s) marked as read` });
  } catch (err) {
    console.error({ route: "PATCH /api/notifications/mark-all-read", adminId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/notifications/delete
// Body: { notificationId }
// Hard delete — cascades to notification_reads automatically via FK.
// Use sparingly; this is for clearing test/junk rows, not routine
// "dismiss" (routine dismiss should just be mark-read).
// ==================================================================
async function deleteNotification(req, res) {
  const { notificationId } = req.body;
  console.log({ route: "DELETE /api/notifications/delete", notificationId, status: "deleting" });

  if (!notificationId) {
    return res.status(400).json({ success: false, message: "notificationId is required" });
  }

  try {
    const result = await db.query(
      `DELETE FROM notifications WHERE id = $1 RETURNING id`,
      [notificationId]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/notifications/delete", notificationId, status: 404 });
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    console.log({ route: "DELETE /api/notifications/delete", notificationId, status: 200 });
    return res.json({ success: true, message: "Notification deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/notifications/delete", notificationId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  createNotification, // internal helper — used by other controllers
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
  VALID_EVENT_TYPES,
  VALID_PRIORITIES,
};