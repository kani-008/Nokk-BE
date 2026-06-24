const db = require("../config/db.js");

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const num = (v) => parseFloat(v) || 0;

function formatOrder(ord, items = [], timeline = []) {
  return {
    id: ord.id,
    createdAt: ord.created_at,
    updatedAt: ord.updated_at,
    customerName: ord.customer_name,
    customerEmail: ord.customer_email,
    customerPhone: ord.customer_phone,
    subtotal: num(ord.subtotal),
    deliveryCharge: num(ord.delivery_charge),
    discount: num(ord.discount),
    couponApplied: ord.coupon_applied,
    total: num(ord.total),
    status: ord.status,
    paymentStatus: ord.payment_status,
    paymentMethod: ord.payment_method,
    courierName: ord.courier_name || null,
    trackingNumber: ord.tracking_number || null,
    trackingUrl: ord.tracking_url || null,
    address: {
      addressLine1: ord.shipping_address_line1,
      addressLine2: ord.shipping_address_line2,
      city: ord.shipping_city,
      state: ord.shipping_state,
      pincode: ord.shipping_pincode
    },
    items,
    timeline
  };
}

function formatItem(i) {
  return {
    id: i.id,
    productId: i.product_id,
    variantId: i.variant_id,
    name: i.name_ta ? `${i.name_en} (${i.name_ta})` : i.name_en,
    weight: i.weight,
    price: num(i.price),
    quantity: parseInt(i.quantity),
    total: num(i.price) * parseInt(i.quantity)
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
    items: itemsRes.rows.map(formatItem),
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
// Generate unique ORD-XXXX id (queryFn lets callers pass a client)
// ------------------------------------------------------------------
async function generateOrderId(queryFn) {
  let orderId, isUnique = false;
  while (!isUnique) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    orderId = `ORD-${rand}`;
    const check = await queryFn("SELECT id FROM orders WHERE id = $1", [orderId]);
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
  console.log({ route: "POST /api/orders/checkout", userId: req.user.id, body: { itemsCount: items?.length, paymentMethod, subtotal, deliveryCharge, discount, total, couponApplied }, status: "checkout process started" });

  if (!items || !items.length || !address || !paymentMethod) {
    console.log({ route: "POST /api/orders/checkout", userId: req.user.id, status: 400, message: "items, address and paymentMethod are required" });
    return res.status(400).json({ success: false, message: "items, address and paymentMethod are required" });
  }
  if (!address.fullName || !address.phone || !address.addressLine1 || !address.city || !address.pincode) {
    console.log({ route: "POST /api/orders/checkout", userId: req.user.id, status: 400, message: "incomplete address" });
    return res.status(400).json({ success: false, message: "Incomplete address — fullName, phone, addressLine1, city, pincode required" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    // Lock variants, validate stock, and collect IDs in one pass.
    // FOR UPDATE prevents concurrent updates.
    const resolvedVariants = [];
    for (const item of items) {
      const varRes = await client.query(
        "SELECT id, stock_qty FROM product_variants WHERE product_id = $1 AND weight_label = $2 AND is_active = TRUE FOR UPDATE",
        [item.productId, item.weight]
      );
      if (varRes.rows.length === 0) {
        const e = new Error(`Variant not found: ${item.nameEn} (${item.weight})`);
        e.status = 400;
        throw e;
      }
      if (varRes.rows[0].stock_qty <= 0) {
        const e = new Error(`Product variant ${item.nameEn} (${item.weight}) is out of stock`);
        e.status = 400;
        throw e;
      }
      resolvedVariants.push(varRes.rows[0].id);
    }

    // Deduct stock is removed since stock_qty stays fixed as a binary availability flag (0 or 1)

    const orderId = await generateOrderId((sql, params) => client.query(sql, params));
    const paymentStatus = paymentMethod.toLowerCase().includes("cod") ? "pending" : "paid";
    const addrLine1 = address.addressLine1 || `${address.doorNo || ""} ${address.street || ""}`.trim();

    // Insert order
    await client.query(
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

    // Insert order items (variant IDs already resolved — no extra selects)
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      await client.query(
        `INSERT INTO order_items
           (order_id, product_id, variant_id, name_en, name_ta, weight, price, quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orderId, item.productId, resolvedVariants[i], item.nameEn, item.nameTa || null,
          item.weight, item.price, item.quantity]
      );
    }

    // Track coupon usage so max_uses limits actually work
    if (couponApplied) {
      await client.query(
        "UPDATE coupons SET usage_count = usage_count + 1 WHERE code = $1",
        [couponApplied]
      );
    }

    // Initial timeline entry
    await client.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'pending','Order placed by customer.')",
      [orderId]
    );

    // Clear user's cart
    const cartRes = await client.query("SELECT id FROM carts WHERE user_id = $1", [req.user.id]);
    if (cartRes.rows.length > 0) {
      await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartRes.rows[0].id]);
    }

    await client.query("COMMIT");

    const { items: fmtItems, timeline } = await fetchItemsAndTimeline(orderId);
    const orderRow = await db.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    console.log({ route: "POST /api/orders/checkout", userId: req.user.id, orderId, status: 201 });
    return res.status(201).json({
      success: true,
      message: "Order placed successfully!",
      order: formatOrder(orderRow.rows[0], fmtItems, timeline)
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "POST /api/orders/checkout", userId: req.user.id, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "POST /api/orders/checkout", userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// GET /api/orders/my   (customer — own orders only)
// Query: ?status=  ?page=1  ?limit=10
// OPTIMIZED: 4 queries total regardless of result size (no N+1)
// ==================================================================
async function getMyOrders(req, res) {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = (page - 1) * limit;
  const status = req.query.status || null;
  console.log({ route: "GET /api/orders/my", userId: req.user.id, query: { page, limit, status }, status: "fetching own orders" });

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

    console.log({ route: "GET /api/orders/my", userId: req.user.id, status: 200, count: result.rows.length });
    return res.json({
      success: true,
      pagination: {
        page, limit,
        total: parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      orders
    });
  } catch (err) {
    console.error({ route: "GET /api/orders/my", userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/orders/my/:id   (customer — own order detail)
// ==================================================================
async function getMyOrderById(req, res) {
  const { id } = req.query;
  console.log({ route: "GET /api/orders/get-my-order", userId: req.user.id, orderId: id, status: "fetching own order detail" });
  try {
    const result = await db.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2",
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "GET /api/orders/get-my-order", userId: req.user.id, orderId: id, status: 404, message: "Order not found" });
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const { items, timeline } = await fetchItemsAndTimeline(id);
    console.log({ route: "GET /api/orders/get-my-order", userId: req.user.id, orderId: id, status: 200 });
    return res.json({ success: true, order: formatOrder(result.rows[0], items, timeline) });
  } catch (err) {
    console.error({ route: "GET /api/orders/get-my-order", userId: req.user.id, orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /api/orders/my/:id/cancel   (customer — cancel own order)
// Only allowed when status is pending or confirmed.
// ==================================================================
async function cancelMyOrder(req, res) {
  const { id } = req.body;
  console.log({ route: "POST /api/orders/cancel-my-order", userId: req.user.id, orderId: id, status: "cancelling own order" });
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const ordRes = await client.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [id, req.user.id]
    );
    if (ordRes.rows.length === 0) {
      const e = new Error("Order not found"); e.status = 404; throw e;
    }
    const ord = ordRes.rows[0];
    if (!["pending", "confirmed"].includes(ord.status)) {
      const e = new Error(`Cannot cancel an order with status: ${ord.status}`); e.status = 400; throw e;
    }

    await client.query(
      "UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [id]
    );



    await client.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'cancelled','Order cancelled by customer.')",
      [id]
    );

    await client.query("COMMIT");
    console.log({ route: "POST /api/orders/cancel-my-order", userId: req.user.id, orderId: id, status: 200 });
    return res.json({ success: true, message: "Order cancelled successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "POST /api/orders/cancel-my-order", userId: req.user.id, orderId: id, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "POST /api/orders/cancel-my-order", userId: req.user.id, orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// POST /api/orders/my/:id/return   (customer — request return)
// Only allowed when status is delivered.
// Body: { reason, details? }
// ==================================================================
async function requestReturn(req, res) {
  const { id, reason, details } = req.body;
  console.log({ route: "POST /api/orders/request-return", userId: req.user.id, orderId: id, body: { reason, details }, status: "requesting order return" });

  if (!reason) {
    console.log({ route: "POST /api/orders/request-return", userId: req.user.id, orderId: id, status: 400, message: "reason is required" });
    return res.status(400).json({ success: false, message: "reason is required" });
  }
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const ordRes = await client.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [id, req.user.id]
    );
    if (ordRes.rows.length === 0) {
      const e = new Error("Order not found"); e.status = 404; throw e;
    }
    if (ordRes.rows[0].status !== "delivered") {
      const e = new Error("Only delivered orders can be returned"); e.status = 400; throw e;
    }

    const existing = await client.query(
      "SELECT id FROM return_requests WHERE order_id = $1 AND user_id = $2",
      [id, req.user.id]
    );
    if (existing.rows.length > 0) {
      const e = new Error("Return request already submitted for this order"); e.status = 409; throw e;
    }

    await client.query(
      "UPDATE orders SET status = 'return_requested', updated_at = NOW() WHERE id = $1",
      [id]
    );
    await client.query(
      "INSERT INTO return_requests (order_id, user_id, reason, details, status) VALUES ($1,$2,$3,$4,'requested')",
      [id, req.user.id, reason, details || null]
    );
    await client.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'return_requested',$2)",
      [id, `Return requested. Reason: ${reason}`]
    );

    await client.query("COMMIT");
    console.log({ route: "POST /api/orders/request-return", userId: req.user.id, orderId: id, status: 200 });
    return res.json({ success: true, message: "Return request submitted successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "POST /api/orders/request-return", userId: req.user.id, orderId: id, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "POST /api/orders/request-return", userId: req.user.id, orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// ADMIN — GET /api/orders/admin/list
// All orders — filterable + paginated.
// Query: ?status=  ?paymentStatus=  ?search=  ?page=1  ?limit=20
// OPTIMIZED: 4 queries total regardless of result size (no N+1)
// ==================================================================
async function adminGetAllOrders(req, res) {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;
  const status = req.query.status || null;
  const paymentStatus = req.query.paymentStatus || null;
  const search = req.query.search ? `%${req.query.search}%` : null;
  console.log({ route: "GET /api/orders/admin/list", query: { page, limit, status, paymentStatus, search }, status: "admin fetching all orders" });

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

    console.log({ route: "GET /api/orders/admin/list", status: 200, count: result.rows.length });
    return res.json({
      success: true,
      pagination: {
        page, limit,
        total: parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      orders
    });
  } catch (err) {
    console.error({ route: "GET /api/orders/admin/list", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/orders/admin/:id
// Full single order detail.
// ==================================================================
async function adminGetOrderById(req, res) {
  const { id } = req.query;
  console.log({ route: "GET /api/orders/admin/get-order", orderId: id, status: "admin fetching order detail" });
  try {
    const result = await db.query(
      "SELECT * FROM orders WHERE id = $1",
      [id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "GET /api/orders/admin/get-order", orderId: id, status: 404, message: "Order not found" });
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const { items, timeline } = await fetchItemsAndTimeline(id);
    console.log({ route: "GET /api/orders/admin/get-order", orderId: id, status: 200 });
    return res.json({ success: true, order: formatOrder(result.rows[0], items, timeline) });
  } catch (err) {
    console.error({ route: "GET /api/orders/admin/get-order", orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/orders/admin/:id/status
// Update order status + parcel tracking info.
// Body: { status, notes?, courierName?, trackingNumber?, trackingUrl? }
// ==================================================================
async function adminUpdateStatus(req, res) {
  const { id, status, notes, courierName, trackingNumber, trackingUrl } = req.body;
  console.log({ route: "PUT /api/orders/admin/update-status", orderId: id, body: { status, notes, courierName, trackingNumber, trackingUrl }, status: "admin updating order status" });

  if (!status) {
    console.log({ route: "PUT /api/orders/admin/update-status", orderId: id, status: 400, message: "status is required" });
    return res.status(400).json({ success: false, message: "status is required" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const ordRes = await client.query(
      "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (ordRes.rows.length === 0) {
      const e = new Error("Order not found"); e.status = 404; throw e;
    }

    const currentStatus = ordRes.rows[0].status;

    await client.query(
      `UPDATE orders SET
         status          = $1,
         courier_name    = COALESCE($2, courier_name),
         tracking_number = COALESCE($3, tracking_number),
         tracking_url    = COALESCE($4, tracking_url),
         updated_at      = NOW()
       WHERE id = $5`,
      [status, courierName || null, trackingNumber || null, trackingUrl || null, id]
    );



    await client.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,$2,$3)",
      [id, status, notes || `Order status updated to: ${status}`]
    );

    await client.query("COMMIT");
    console.log({ route: "PUT /api/orders/admin/update-status", orderId: id, status: 200 });
    return res.json({ success: true, message: "Order updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "PUT /api/orders/admin/update-status", orderId: id, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "PUT /api/orders/admin/update-status", orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// ADMIN — GET /api/orders/admin/returns
// All return requests.
// Query: ?status=requested|approved|rejected|completed
// ==================================================================
async function adminGetReturns(req, res) {
  const status = req.query.status || null;
  console.log({ route: "GET /api/orders/admin/returns", status, statusMsg: "admin fetching return requests" });
  try {
    const result = await db.query(
      `SELECT rr.*, u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
       FROM return_requests rr
       JOIN users u ON u.id = rr.user_id
       WHERE ($1::text IS NULL OR rr.status = $1)
       ORDER BY rr.created_at DESC`,
      [status]
    );
    console.log({ route: "GET /api/orders/admin/returns", status, status: 200, count: result.rows.length });
    return res.json({ success: true, returns: result.rows });
  } catch (err) {
    console.error({ route: "GET /api/orders/admin/returns", status, status: 500, error: err.message });
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
  const { requestId, status, adminNotes } = req.body;
  console.log({ route: "PUT /api/orders/admin/update-return", requestId, body: { status, adminNotes }, status: "admin updating return request" });
  const validStatuses = ["approved", "rejected", "completed"];
  if (!status || !validStatuses.includes(status)) {
    console.log({ route: "PUT /api/orders/admin/update-return", requestId, status: 400, message: "invalid status" });
    return res.status(400).json({ success: false, message: "status must be approved, rejected or completed" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const retRes = await client.query(
      "SELECT * FROM return_requests WHERE id = $1 FOR UPDATE",
      [requestId]
    );
    if (retRes.rows.length === 0) {
      const e = new Error("Return request not found"); e.status = 404; throw e;
    }

    const ret = retRes.rows[0];

    await client.query(
      "UPDATE return_requests SET status = $1, admin_notes = COALESCE($2, admin_notes), updated_at = NOW() WHERE id = $3",
      [status, adminNotes || null, ret.id]
    );

    const orderStatusMap = { approved: "return_requested", rejected: "delivered", completed: "returned" };
    const newOrderStatus = orderStatusMap[status];
    const tlNote = {
      approved: `Return approved. Notes: ${adminNotes || "None"}`,
      rejected: `Return rejected. Notes: ${adminNotes || "None"}`,
      completed: `Return completed. Refund processed. Notes: ${adminNotes || "None"}`
    }[status];



    await client.query(
      "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2",
      [newOrderStatus, ret.order_id]
    );
    await client.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,$2,$3)",
      [ret.order_id, newOrderStatus, tlNote]
    );

    await client.query("COMMIT");
    console.log({ route: "PUT /api/orders/admin/update-return", requestId, status: 200 });
    return res.json({ success: true, message: "Return request updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "PUT /api/orders/admin/update-return", requestId, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "PUT /api/orders/admin/update-return", requestId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
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