const db     = require("../config/db.js");
const logger = require("../utils/logger.js");

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const num = (v) => parseFloat(v) || 0;

function formatOrder(ord, items = [], timeline = []) {
  return {
    id:             ord.id,
    createdAt:      ord.created_at,
    updatedAt:      ord.updated_at,
    customerName:   ord.customer_name,
    customerEmail:  ord.customer_email,
    customerPhone:  ord.customer_phone,
    subtotal:       num(ord.subtotal),
    deliveryCharge: num(ord.delivery_charge),
    discount:       num(ord.discount),
    couponApplied:  ord.coupon_applied,
    total:          num(ord.total),
    status:         ord.status,
    paymentStatus:  ord.payment_status,
    paymentMethod:  ord.payment_method,
    courierName:    ord.courier_name    || null,
    trackingNumber: ord.tracking_number || null,
    trackingUrl:    ord.tracking_url    || null,
    address: {
      addressLine1: ord.shipping_address_line1,
      addressLine2: ord.shipping_address_line2,
      city:         ord.shipping_city,
      state:        ord.shipping_state,
      pincode:      ord.shipping_pincode
    },
    items,
    timeline
  };
}

function formatItem(i) {
  return {
    id:        i.id,
    productId: i.product_id,
    variantId: i.variant_id,
    name:      i.name_ta ? `${i.name_en} (${i.name_ta})` : i.name_en,
    weight:    i.weight,
    price:     num(i.price),
    quantity:  parseInt(i.quantity),
    total:     num(i.price) * parseInt(i.quantity)
  };
}

// ------------------------------------------------------------------
// Single order — used by detail endpoints and checkout response
// ------------------------------------------------------------------
async function fetchItemsAndTimeline(orderId) {
  const [itemsRes, timelineRes] = await Promise.all([
    db.query(
      `SELECT id, product_id, variant_id, name_en, name_ta, weight, price, quantity
       FROM order_items WHERE order_id = $1`,
      [orderId]
    ),
    db.query(
      `SELECT status, notes, created_at AS date
       FROM order_timelines WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId]
    )
  ]);
  return {
    items:    itemsRes.rows.map(formatItem),
    timeline: timelineRes.rows
  };
}

// ------------------------------------------------------------------
// Batch fetch — used by listing endpoints to eliminate N+1.
// Fetches items + timelines for ALL orders in exactly 2 queries
// regardless of how many orders are in the list.
// ------------------------------------------------------------------
async function fetchItemsAndTimelinesForOrders(orderIds) {
  if (!orderIds.length) return { itemsMap: {}, timelinesMap: {} };

  const [itemsRes, timelineRes] = await Promise.all([
    db.query(
      `SELECT id, order_id, product_id, variant_id, name_en, name_ta, weight, price, quantity
       FROM order_items WHERE order_id = ANY($1)`,
      [orderIds]
    ),
    db.query(
      `SELECT order_id, status, notes, created_at AS date
       FROM order_timelines WHERE order_id = ANY($1) ORDER BY created_at ASC`,
      [orderIds]
    )
  ]);

  const itemsMap = {};
  itemsRes.rows.forEach(i => {
    if (!itemsMap[i.order_id]) itemsMap[i.order_id] = [];
    itemsMap[i.order_id].push(formatItem(i));
  });

  const timelinesMap = {};
  timelineRes.rows.forEach(t => {
    if (!timelinesMap[t.order_id]) timelinesMap[t.order_id] = [];
    timelinesMap[t.order_id].push(t);
  });

  return { itemsMap, timelinesMap };
}

// ------------------------------------------------------------------
// Generate unique ORD-XXXX id
// ------------------------------------------------------------------
async function generateOrderId() {
  let orderId, isUnique = false;
  while (!isUnique) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    orderId = `ORD-${rand}`;
    const check = await db.query("SELECT id FROM orders WHERE id = $1", [orderId]);
    if (check.rows.length === 0) isUnique = true;
  }
  return orderId;
}

// ==================================================================
// POST /api/orders/checkout   (customer — login required)
// Body: { items, address, paymentMethod, couponApplied?,
//         subtotal, deliveryCharge, discount, total }
// ==================================================================
async function checkout(req, res) {
  const {
    items, address, paymentMethod,
    subtotal, deliveryCharge, discount, total,
    couponApplied
  } = req.body;

  if (!items || !items.length || !address || !paymentMethod) {
    return res.status(400).json({ success: false, message: "items, address and paymentMethod are required" });
  }
  if (!address.fullName || !address.phone || !address.addressLine1 || !address.city || !address.pincode) {
    return res.status(400).json({ success: false, message: "Incomplete address — fullName, phone, addressLine1, city, pincode required" });
  }

  try {
    await db.query("BEGIN");

    // Validate stock for every item before touching anything
    for (const item of items) {
      const varRes = await db.query(
        "SELECT id, stock_qty FROM product_variants WHERE product_id = $1 AND weight_label = $2 AND is_active = TRUE",
        [item.productId, item.weight]
      );
      if (varRes.rows.length === 0) {
        await db.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Variant not found: ${item.nameEn} (${item.weight})` });
      }
      if (varRes.rows[0].stock_qty < item.quantity) {
        await db.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${item.nameEn} (${item.weight}). Available: ${varRes.rows[0].stock_qty}`
        });
      }
    }

    // Deduct stock
    for (const item of items) {
      const varRes = await db.query(
        "SELECT id FROM product_variants WHERE product_id = $1 AND weight_label = $2",
        [item.productId, item.weight]
      );
      await db.query(
        "UPDATE product_variants SET stock_qty = stock_qty - $1, updated_at = NOW() WHERE id = $2",
        [item.quantity, varRes.rows[0].id]
      );
    }

    const orderId       = await generateOrderId();
    const paymentStatus = paymentMethod.toLowerCase().includes("cod") ? "pending" : "paid";
    const addrLine1     = address.addressLine1 || `${address.doorNo || ""} ${address.street || ""}`.trim();

    // Insert order
    await db.query(
      `INSERT INTO orders (
         id, user_id, customer_name, customer_email, customer_phone,
         subtotal, delivery_charge, discount, coupon_applied, total,
         status, payment_method, payment_status,
         shipping_address_line1, shipping_address_line2,
         shipping_city, shipping_state, shipping_pincode
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14,$15,$16,$17)`,
      [
        orderId, req.user.id,
        address.fullName, req.user.email, address.phone,
        subtotal, deliveryCharge || 0, discount || 0,
        couponApplied || null, total,
        paymentMethod, paymentStatus,
        addrLine1, address.addressLine2 || null,
        address.city, address.state || "Tamil Nadu", address.pincode
      ]
    );

    // Insert order items
    for (const item of items) {
      const varRes = await db.query(
        "SELECT id FROM product_variants WHERE product_id = $1 AND weight_label = $2",
        [item.productId, item.weight]
      );
      await db.query(
        `INSERT INTO order_items
           (order_id, product_id, variant_id, name_en, name_ta, weight, price, quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          orderId, item.productId,
          varRes.rows[0]?.id || null,
          item.nameEn, item.nameTa || null,
          item.weight, item.price, item.quantity
        ]
      );
    }

    // Initial timeline entry
    await db.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'pending','Order placed by customer.')",
      [orderId]
    );

    // Clear user's cart
    const cartRes = await db.query("SELECT id FROM carts WHERE user_id = $1", [req.user.id]);
    if (cartRes.rows.length > 0) {
      await db.query("DELETE FROM cart_items WHERE cart_id = $1", [cartRes.rows[0].id]);
    }

    await db.query("COMMIT");

    // Uses single-order fetch (correct — only one order here)
    const { items: fmtItems, timeline } = await fetchItemsAndTimeline(orderId);
    const orderRow = await db.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    return res.status(201).json({
      success: true,
      message: "Order placed successfully!",
      order:   formatOrder(orderRow.rows[0], fmtItems, timeline)
    });
  } catch (err) {
    await db.query("ROLLBACK");
    logger.error("Checkout error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/orders/my   (customer — own orders only)
// Query: ?status=  ?page=1  ?limit=10
// OPTIMIZED: 4 queries total regardless of result size (no N+1)
// ==================================================================
async function getMyOrders(req, res) {
  const page   = Math.max(parseInt(req.query.page)  || 1, 1);
  const limit  = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = (page - 1) * limit;
  const status = req.query.status || null;

  try {
    const result = await db.query(
      `SELECT * FROM orders
       WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.id, status, limit, offset]
    );

    const countRes = await db.query(
      "SELECT COUNT(*) AS total FROM orders WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)",
      [req.user.id, status]
    );

    const orderIds = result.rows.map(o => o.id);
    const { itemsMap, timelinesMap } = await fetchItemsAndTimelinesForOrders(orderIds);
    const orders = result.rows.map(ord =>
      formatOrder(ord, itemsMap[ord.id] || [], timelinesMap[ord.id] || [])
    );

    return res.json({
      success: true,
      pagination: {
        page, limit,
        total:      parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      orders
    });
  } catch (err) {
    logger.error("Get my orders error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/orders/my/:id   (customer — own order detail)
// ==================================================================
async function getMyOrderById(req, res) {
  try {
    const result = await db.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const { items, timeline } = await fetchItemsAndTimeline(req.params.id);
    return res.json({ success: true, order: formatOrder(result.rows[0], items, timeline) });
  } catch (err) {
    logger.error("Get my order detail error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /api/orders/my/:id/cancel   (customer — cancel own order)
// Only allowed when status is pending or confirmed.
// ==================================================================
async function cancelMyOrder(req, res) {
  try {
    await db.query("BEGIN");
    const ordRes = await db.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [req.params.id, req.user.id]
    );
    if (ordRes.rows.length === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const ord = ordRes.rows[0];
    if (!["pending", "confirmed"].includes(ord.status)) {
      await db.query("ROLLBACK");
      return res.status(400).json({ success: false, message: `Cannot cancel an order with status: ${ord.status}` });
    }

    await db.query(
      "UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    // Restore stock
    const itemsRes = await db.query(
      "SELECT variant_id, quantity FROM order_items WHERE order_id = $1",
      [req.params.id]
    );
    for (const item of itemsRes.rows) {
      if (item.variant_id) {
        await db.query(
          "UPDATE product_variants SET stock_qty = stock_qty + $1, updated_at = NOW() WHERE id = $2",
          [item.quantity, item.variant_id]
        );
      }
    }

    await db.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'cancelled','Order cancelled by customer.')",
      [req.params.id]
    );

    await db.query("COMMIT");
    return res.json({ success: true, message: "Order cancelled successfully" });
  } catch (err) {
    await db.query("ROLLBACK");
    logger.error("Cancel order error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /api/orders/my/:id/return   (customer — request return)
// Only allowed when status is delivered.
// Body: { reason, details? }
// ==================================================================
async function requestReturn(req, res) {
  const { reason, details } = req.body;
  if (!reason) {
    return res.status(400).json({ success: false, message: "reason is required" });
  }
  try {
    await db.query("BEGIN");
    const ordRes = await db.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [req.params.id, req.user.id]
    );
    if (ordRes.rows.length === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (ordRes.rows[0].status !== "delivered") {
      await db.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Only delivered orders can be returned" });
    }

    const existing = await db.query(
      "SELECT id FROM return_requests WHERE order_id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (existing.rows.length > 0) {
      await db.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Return request already submitted for this order" });
    }

    await db.query(
      "UPDATE orders SET status = 'return_requested', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    await db.query(
      "INSERT INTO return_requests (order_id, user_id, reason, details, status) VALUES ($1,$2,$3,$4,'requested')",
      [req.params.id, req.user.id, reason, details || null]
    );
    await db.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'return_requested',$2)",
      [req.params.id, `Return requested. Reason: ${reason}`]
    );

    await db.query("COMMIT");
    return res.json({ success: true, message: "Return request submitted successfully" });
  } catch (err) {
    await db.query("ROLLBACK");
    logger.error("Return request error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/orders/admin/list
// All orders — filterable + paginated.
// Query: ?status=  ?paymentStatus=  ?search=  ?page=1  ?limit=20
// OPTIMIZED: 4 queries total regardless of result size (no N+1)
// ==================================================================
async function adminGetAllOrders(req, res) {
  const page          = Math.max(parseInt(req.query.page)  || 1, 1);
  const limit         = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset        = (page - 1) * limit;
  const status        = req.query.status        || null;
  const paymentStatus = req.query.paymentStatus || null;
  const search        = req.query.search ? `%${req.query.search}%` : null;

  try {
    const result = await db.query(
      `SELECT * FROM orders
       WHERE ($1::text IS NULL OR status         = $1)
         AND ($2::text IS NULL OR payment_status = $2)
         AND ($3::text IS NULL OR
               customer_name  ILIKE $3 OR
               customer_phone ILIKE $3 OR
               customer_email ILIKE $3 OR
               id             ILIKE $3)
       ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [status, paymentStatus, search, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM orders
       WHERE ($1::text IS NULL OR status         = $1)
         AND ($2::text IS NULL OR payment_status = $2)
         AND ($3::text IS NULL OR customer_name ILIKE $3 OR customer_phone ILIKE $3 OR id ILIKE $3)`,
      [status, paymentStatus, search]
    );

    const orderIds = result.rows.map(o => o.id);
    const { itemsMap, timelinesMap } = await fetchItemsAndTimelinesForOrders(orderIds);
    const orders = result.rows.map(ord =>
      formatOrder(ord, itemsMap[ord.id] || [], timelinesMap[ord.id] || [])
    );

    return res.json({
      success: true,
      pagination: {
        page, limit,
        total:      parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      orders
    });
  } catch (err) {
    logger.error("Admin get all orders error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/orders/admin/:id
// Full single order detail.
// ==================================================================
async function adminGetOrderById(req, res) {
  try {
    const result = await db.query(
      "SELECT * FROM orders WHERE id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const { items, timeline } = await fetchItemsAndTimeline(req.params.id);
    return res.json({ success: true, order: formatOrder(result.rows[0], items, timeline) });
  } catch (err) {
    logger.error("Admin get order error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/orders/admin/:id/status
// Update order status + parcel tracking info.
// Body: { status, notes?, courierName?, trackingNumber?, trackingUrl? }
// ==================================================================
async function adminUpdateStatus(req, res) {
  const { status, notes, courierName, trackingNumber, trackingUrl } = req.body;
  if (!status) {
    return res.status(400).json({ success: false, message: "status is required" });
  }

  try {
    await db.query("BEGIN");

    const ordRes = await db.query(
      "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );
    if (ordRes.rows.length === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const currentStatus = ordRes.rows[0].status;

    await db.query(
      `UPDATE orders SET
         status          = $1,
         courier_name    = COALESCE($2, courier_name),
         tracking_number = COALESCE($3, tracking_number),
         tracking_url    = COALESCE($4, tracking_url),
         updated_at      = NOW()
       WHERE id = $5`,
      [status, courierName || null, trackingNumber || null, trackingUrl || null, req.params.id]
    );

    // Restore stock if admin is cancelling an active order
    if (currentStatus !== "cancelled" && status === "cancelled") {
      const itemsRes = await db.query(
        "SELECT variant_id, quantity FROM order_items WHERE order_id = $1",
        [req.params.id]
      );
      for (const item of itemsRes.rows) {
        if (item.variant_id) {
          await db.query(
            "UPDATE product_variants SET stock_qty = stock_qty + $1, updated_at = NOW() WHERE id = $2",
            [item.quantity, item.variant_id]
          );
        }
      }
    }

    await db.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,$2,$3)",
      [req.params.id, status, notes || `Order status updated to: ${status}`]
    );

    await db.query("COMMIT");
    return res.json({ success: true, message: "Order updated successfully" });
  } catch (err) {
    await db.query("ROLLBACK");
    logger.error("Admin update status error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/orders/admin/returns
// All return requests.
// Query: ?status=requested|approved|rejected|completed
// ==================================================================
async function adminGetReturns(req, res) {
  const status = req.query.status || null;
  try {
    const result = await db.query(
      `SELECT rr.*, u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
       FROM return_requests rr
       JOIN users u ON u.id = rr.user_id
       WHERE ($1::text IS NULL OR rr.status = $1)
       ORDER BY rr.created_at DESC`,
      [status]
    );
    return res.json({ success: true, returns: result.rows });
  } catch (err) {
    logger.error("Admin get returns error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/orders/admin/returns/:requestId
// Approve / reject / complete a return.
// Body: { status, adminNotes? }
// completed → restores stock + marks order returned
// ==================================================================
async function adminUpdateReturn(req, res) {
  const { status, adminNotes } = req.body;
  const validStatuses = ["approved", "rejected", "completed"];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: "status must be approved, rejected or completed" });
  }

  try {
    await db.query("BEGIN");

    const retRes = await db.query(
      "SELECT * FROM return_requests WHERE id = $1 FOR UPDATE",
      [req.params.requestId]
    );
    if (retRes.rows.length === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Return request not found" });
    }

    const ret = retRes.rows[0];

    await db.query(
      "UPDATE return_requests SET status = $1, admin_notes = COALESCE($2, admin_notes), updated_at = NOW() WHERE id = $3",
      [status, adminNotes || null, ret.id]
    );

    const orderStatusMap = { approved: "return_requested", rejected: "delivered", completed: "returned" };
    const newOrderStatus = orderStatusMap[status];
    const tlNote = {
      approved:  `Return approved. Notes: ${adminNotes || "None"}`,
      rejected:  `Return rejected. Notes: ${adminNotes || "None"}`,
      completed: `Return completed. Refund processed. Notes: ${adminNotes || "None"}`
    }[status];

    // Restore stock on completion
    if (status === "completed") {
      const itemsRes = await db.query(
        "SELECT variant_id, quantity FROM order_items WHERE order_id = $1",
        [ret.order_id]
      );
      for (const item of itemsRes.rows) {
        if (item.variant_id) {
          await db.query(
            "UPDATE product_variants SET stock_qty = stock_qty + $1, updated_at = NOW() WHERE id = $2",
            [item.quantity, item.variant_id]
          );
        }
      }
    }

    await db.query(
      "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2",
      [newOrderStatus, ret.order_id]
    );
    await db.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,$2,$3)",
      [ret.order_id, newOrderStatus, tlNote]
    );

    await db.query("COMMIT");
    return res.json({ success: true, message: "Return request updated successfully" });
  } catch (err) {
    await db.query("ROLLBACK");
    logger.error("Admin update return error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  checkout,
  getMyOrders,
  getMyOrderById,
  cancelMyOrder,
  requestReturn,
  adminGetAllOrders,
  adminGetOrderById,
  adminUpdateStatus,
  adminGetReturns,
  adminUpdateReturn
};