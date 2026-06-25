const db = require("../config/db.js");

const num = (v) => parseFloat(v) || 0;

// Shared date-range clause builder.
// Returns { clause, params, nextIdx } so callers can append more params.
function dateRangeClause(from, to, col, startIdx) {
  const conditions = [];
  const params = [];
  let idx = startIdx;

  if (from) { conditions.push(`${col} >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`${col} <  $${idx++}`); params.push(to); }

  const clause = conditions.length ? "AND " + conditions.join(" AND ") : "";
  return { clause, params, nextIdx: idx };
}

// ==================================================================
// GET /api/reports/orders
// Detailed order list for export / accounting.
// Query: ?from=YYYY-MM-DD  ?to=YYYY-MM-DD  ?status=  ?payment=
//         ?page=1  ?limit=100
// ==================================================================
async function getOrderReport(req, res) {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = (page - 1) * limit;
  const from = req.query.from || null;
  const to = req.query.to || null;
  const status = req.query.status || null;
  const payment = req.query.payment || null;

  console.log({ route: "GET /api/reports/orders", page, limit, from, to, orderStatus: status, payment, status: "fetching order report" });

  const { clause: dateClause, params: dateParams, nextIdx } =
    dateRangeClause(from, to, "o.created_at", 3);

  const queryParams = [status, payment, ...dateParams, limit, offset];
  const countParams = [status, payment, ...dateParams];

  try {
    const result = await db.query(
      `SELECT
         o.id,
         o.customer_name,
         o.customer_email,
         o.customer_phone,
         o.subtotal,
         o.delivery_charge,
         o.discount,
         o.coupon_applied,
         o.total,
         o.status,
         o.payment_method,
         o.payment_status,
         o.shipping_city,
         o.shipping_state,
         o.shipping_pincode,
         o.created_at,
         COUNT(oi.id)      AS item_count,
         SUM(oi.quantity)  AS total_units
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE ($1::text IS NULL OR o.status         = $1)
         AND ($2::text IS NULL OR o.payment_status = $2)
         ${dateClause}
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
      queryParams
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total
       FROM orders o
       WHERE ($1::text IS NULL OR o.status         = $1)
         AND ($2::text IS NULL OR o.payment_status = $2)
         ${dateClause}`,
      countParams
    );

    console.log({ route: "GET /api/reports/orders", status: 200, count: result.rows.length });
    return res.json({
      success: true,
      pagination: {
        page, limit,
        total: parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      report: result.rows.map(r => ({
        orderId: r.id,
        customerName: r.customer_name,
        customerEmail: r.customer_email,
        customerPhone: r.customer_phone,
        subtotal: num(r.subtotal),
        deliveryCharge: num(r.delivery_charge),
        discount: num(r.discount),
        couponApplied: r.coupon_applied,
        total: num(r.total),
        status: r.status,
        paymentMethod: r.payment_method,
        paymentStatus: r.payment_status,
        city: r.shipping_city,
        state: r.shipping_state,
        pincode: r.shipping_pincode,
        createdAt: r.created_at,
        itemCount: parseInt(r.item_count),
        totalUnits: parseInt(r.total_units)
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/reports/orders", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/reports/revenue
// Aggregated revenue by day / week / month.
// Query: ?from=  ?to=  ?period=daily|weekly|monthly
// ==================================================================
async function getRevenueReport(req, res) {
  const from = req.query.from || null;
  const to = req.query.to || null;
  const period = req.query.period || "daily";

  console.log({ route: "GET /api/reports/revenue", from, to, period, status: "fetching revenue report" });

  const truncMap = { daily: "day", weekly: "week", monthly: "month" };
  const trunc = truncMap[period] || "day";

  const { clause: dateClause, params: dateParams, nextIdx } =
    dateRangeClause(from, to, "created_at", 2);

  try {
    const result = await db.query(
      `SELECT
         date_trunc($1, created_at)        AS period,
         COUNT(*)                          AS orders,
         COALESCE(SUM(subtotal),        0) AS subtotal,
         COALESCE(SUM(delivery_charge), 0) AS delivery,
         COALESCE(SUM(discount),        0) AS discount,
         COALESCE(SUM(total),           0) AS revenue
       FROM orders
       WHERE status != 'cancelled' AND payment_method != 'replacement'
         ${dateClause}
       GROUP BY date_trunc($1, created_at)
       ORDER BY period ASC`,
      [trunc, ...dateParams]
    );

    const totals = await db.query(
      `SELECT
         COUNT(*)                          AS total_orders,
         COALESCE(SUM(subtotal),        0) AS total_subtotal,
         COALESCE(SUM(delivery_charge), 0) AS total_delivery,
         COALESCE(SUM(discount),        0) AS total_discount,
         COALESCE(SUM(total),           0) AS total_revenue
       FROM orders
       WHERE status != 'cancelled' AND payment_method != 'replacement'
         ${dateClause}`,
      dateParams
    );

    const t = totals.rows[0];
    console.log({ route: "GET /api/reports/revenue", status: 200, count: result.rows.length });
    return res.json({
      success: true,
      period,
      totals: {
        orders: parseInt(t.total_orders),
        subtotal: num(t.total_subtotal),
        delivery: num(t.total_delivery),
        discount: num(t.total_discount),
        revenue: num(t.total_revenue)
      },
      breakdown: result.rows.map(r => ({
        period: r.period,
        orders: parseInt(r.orders),
        subtotal: num(r.subtotal),
        delivery: num(r.delivery),
        discount: num(r.discount),
        revenue: num(r.revenue)
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/reports/revenue", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/reports/products
// Per-product sales performance.
// Query: ?from=  ?to=  ?category=slug  ?limit=100
// ==================================================================
async function getProductReport(req, res) {
  const from = req.query.from || null;
  const to = req.query.to || null;
  const catSlug = req.query.category || null;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  console.log({ route: "GET /api/reports/products", from, to, category: catSlug, limit, status: "fetching product report" });

  const { clause: dateClause, params: dateParams, nextIdx } =
    dateRangeClause(from, to, "o.created_at", 3);

  try {
    const result = await db.query(
      `SELECT
         p.id,
         p.name_en,
         p.name_ta,
         c.name_en                       AS category,
         COUNT(DISTINCT o.id)            AS order_count,
         SUM(oi.quantity)                AS units_sold,
         SUM(oi.price * oi.quantity)     AS revenue,
         AVG(oi.price)                   AS avg_price
       FROM order_items oi
       JOIN products p    ON p.id = oi.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       JOIN orders o      ON o.id = oi.order_id
       WHERE o.status != 'cancelled' AND o.payment_method != 'replacement'
         AND ($1::text IS NULL OR c.slug = $1)
         AND ($2::text IS NULL OR o.payment_status = $2)
         ${dateClause}
       GROUP BY p.id, p.name_en, p.name_ta, c.name_en
       ORDER BY revenue DESC
       LIMIT $${nextIdx}`,
      [catSlug, null, ...dateParams, limit]
    );

    console.log({ route: "GET /api/reports/products", status: 200, count: result.rows.length });
    return res.json({
      success: true,
      report: result.rows.map(r => ({
        productId: r.id,
        name: r.name_ta ? `${r.name_en} (${r.name_ta})` : r.name_en,
        nameEn: r.name_en,
        nameTa: r.name_ta,
        category: r.category,
        orderCount: parseInt(r.order_count),
        unitsSold: parseInt(r.units_sold),
        revenue: num(r.revenue),
        avgPrice: num(r.avg_price)
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/reports/products", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/reports/customers
// Customer-level spend summary.
// Query: ?from=  ?to=  ?limit=100
// ==================================================================
async function getCustomerReport(req, res) {
  const from = req.query.from || null;
  const to = req.query.to || null;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  console.log({ route: "GET /api/reports/customers", from, to, limit, status: "fetching customer report" });

  const { clause: dateClause, params: dateParams, nextIdx } =
    dateRangeClause(from, to, "o.created_at", 1);

  try {
    const result = await db.query(
      `SELECT
         u.id,
         u.full_name,
         u.email,
         u.phone,
         u.created_at                AS registered_at,
         COUNT(DISTINCT o.id)        AS total_orders,
         COALESCE(SUM(o.total), 0)   AS total_spent,
         COALESCE(AVG(o.total), 0)   AS avg_order_value,
         MAX(o.created_at)           AS last_order_at
       FROM users u
       LEFT JOIN orders o ON o.user_id = u.id
         AND o.status != 'cancelled' AND o.payment_method != 'replacement'
         ${dateClause}
       WHERE u.role = 'customer'
       GROUP BY u.id, u.full_name, u.email, u.phone, u.created_at
       ORDER BY total_spent DESC
       LIMIT $${nextIdx}`,
      [...dateParams, limit]
    );

    console.log({ route: "GET /api/reports/customers", status: 200, count: result.rows.length });
    return res.json({
      success: true,
      report: result.rows.map(r => ({
        customerId: r.id,
        name: r.full_name,
        email: r.email,
        phone: r.phone,
        registeredAt: r.registered_at,
        totalOrders: parseInt(r.total_orders),
        totalSpent: num(r.total_spent),
        avgOrderValue: num(r.avg_order_value),
        lastOrderAt: r.last_order_at
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/reports/customers", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/reports/inventory
// Current stock snapshot with value-at-cost estimate.
// Query: ?category=slug  ?status=in_stock|low_stock|out_of_stock
// ==================================================================
async function getInventoryReport(req, res) {
  const catSlug = req.query.category || null;
  const stockStatus = req.query.status || null;

  console.log({ route: "GET /api/reports/inventory", category: catSlug, stockStatus, status: "fetching inventory report" });

  const statusFilter = {
    "in_stock": "pv.stock_qty > 0",
    "low_stock": "FALSE",
    "out_of_stock": "pv.stock_qty = 0"
  }[stockStatus] || "TRUE";

  try {
    const result = await db.query(
      `SELECT
         pv.id             AS variant_id,
         p.id              AS product_id,
         p.name_en,
         p.name_ta,
         c.name_en         AS category,
         pv.weight_label,
         pv.price,
         pv.stock_qty,
         pv.stock_qty * pv.price AS stock_value,
         CASE
           WHEN pv.stock_qty = 0         THEN 'out_of_stock'
           ELSE                               'in_stock'
         END               AS stock_status,
         pv.updated_at     AS stock_updated_at
       FROM product_variants pv
       JOIN products p    ON p.id = pv.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE pv.is_active = TRUE
         AND ($1::text IS NULL OR c.slug = $1)
         AND ${statusFilter}
       ORDER BY pv.stock_qty DESC, p.name_en ASC`,
      [catSlug]
    );

    const summary = await db.query(
      `SELECT
         COUNT(*)                                          AS total_variants,
         COUNT(*) FILTER (WHERE pv.stock_qty > 0)         AS total_units,
         COALESCE(SUM(pv.stock_qty * pv.price), 0)       AS total_stock_value,
         COUNT(*) FILTER (WHERE pv.stock_qty  = 0)        AS out_of_stock,
         0                                                 AS low_stock,
         COUNT(*) FILTER (WHERE pv.stock_qty  > 0)         AS in_stock
       FROM product_variants pv
       WHERE pv.is_active = TRUE`
    );

    const s = summary.rows[0];
    console.log({ route: "GET /api/reports/inventory", status: 200, variantCount: result.rows.length });
    return res.json({
      success: true,
      summary: {
        totalVariants: parseInt(s.total_variants),
        totalUnits: parseInt(s.total_units),
        totalStockValue: num(s.total_stock_value),
        outOfStock: parseInt(s.out_of_stock),
        lowStock: parseInt(s.low_stock),
        inStock: parseInt(s.in_stock)
      },
      report: result.rows.map(r => ({
        variantId: r.variant_id,
        productId: r.product_id,
        name: r.name_ta ? `${r.name_en} (${r.name_ta})` : r.name_en,
        category: r.category,
        weightLabel: r.weight_label,
        price: num(r.price),
        stockQty: parseInt(r.stock_qty),
        stockValue: num(r.stock_value),
        stockStatus: r.stock_status,
        stockUpdatedAt: r.stock_updated_at
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/reports/inventory", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getOrderReport,
  getRevenueReport,
  getProductReport,
  getCustomerReport,
  getInventoryReport
};