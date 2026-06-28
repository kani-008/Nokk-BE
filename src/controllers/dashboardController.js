const db = require("../config/db.js");

// ------------------------------------------------------------------
// Helper: parse numeric safely
// ------------------------------------------------------------------
const num = (v) => parseFloat(v) || 0;

// ==================================================================
// GET /api/dashboard/summary
// Top-level KPI cards for the admin dashboard home.
// Returns: revenue, orders, customers, avg order value — for today,
// this week, this month, and all-time.
// ==================================================================
async function getSummary(req, res) {
  console.log({ route: "GET /api/dashboard/summary", status: "fetching summary stats" });
  try {
    const stats = await db.query(`
      SELECT
        -- All-time
        COUNT(*)                                                        AS total_orders,
        COALESCE(SUM(total), 0)                                        AS total_revenue,
        COALESCE(SUM(discount), 0)                                     AS total_discount,
        COALESCE(SUM(delivery_charge), 0)                              AS total_delivery,
        COALESCE(AVG(total), 0)                                        AS avg_order_value,
        COUNT(*) FILTER (WHERE status = 'pending')                     AS pending_orders,
        COUNT(*) FILTER (WHERE status = 'processing')                  AS processing_orders,
        COUNT(*) FILTER (WHERE status = 'delivered')                   AS delivered_orders,
        COUNT(*) FILTER (WHERE status = 'cancelled')                   AS cancelled_orders,

        -- Today
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)            AS today_orders,
        COALESCE(SUM(total) FILTER (WHERE created_at >= CURRENT_DATE), 0) AS today_revenue,

        -- This week (Mon–Sun)
        COUNT(*) FILTER (WHERE created_at >= date_trunc('week', NOW()))   AS week_orders,
        COALESCE(SUM(total) FILTER (WHERE created_at >= date_trunc('week', NOW())), 0) AS week_revenue,

        -- This month
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()))  AS month_orders,
        COALESCE(SUM(total) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS month_revenue
      FROM orders
      WHERE status NOT IN ('cancelled')
    `);

    const customers = await db.query(`
      SELECT
        COUNT(*)                                                        AS total_customers,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)             AS today_new,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('week', NOW())) AS week_new,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW())) AS month_new
      FROM users
      WHERE role = 'customer'
    `);

    const pendingReplacements = await db.query(`
      SELECT COUNT(*) AS pending_replacements
      FROM replacement_requests
      WHERE status = 'requested'
    `);

    const productsRes = await db.query(
      `SELECT COUNT(*) AS total_products FROM products WHERE is_active = TRUE`
    );

    const s = stats.rows[0];
    const c = customers.rows[0];

    console.log({ route: "GET /api/dashboard/summary", status: 200 });
    return res.json({
      success: true,
      summary: {
        allTime: {
          orders: parseInt(s.total_orders),
          revenue: num(s.total_revenue),
          discount: num(s.total_discount),
          delivery: num(s.total_delivery),
          avgOrderValue: num(s.avg_order_value)
        },
        today: {
          orders: parseInt(s.today_orders),
          revenue: num(s.today_revenue)
        },
        thisWeek: {
          orders: parseInt(s.week_orders),
          revenue: num(s.week_revenue)
        },
        thisMonth: {
          orders: parseInt(s.month_orders),
          revenue: num(s.month_revenue)
        },
        orderStatus: {
          pending: parseInt(s.pending_orders),
          processing: parseInt(s.processing_orders),
          delivered: parseInt(s.delivered_orders),
          cancelled: parseInt(s.cancelled_orders)
        },
        customers: {
          total: parseInt(c.total_customers),
          todayNew: parseInt(c.today_new),
          weekNew: parseInt(c.week_new),
          monthNew: parseInt(c.month_new)
        },
        products: {
          total: parseInt(productsRes.rows[0].total_products)
        },
        alerts: {
          lowStockVariants: 0,
          pendingReplacements: parseInt(pendingReplacements.rows[0].pending_replacements)
        }
      }
    });
  } catch (err) {
    console.error({ route: "GET /api/dashboard/summary", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/dashboard/revenue-chart?period=daily|weekly|monthly
// Revenue + order count over time for the chart.
// Default: last 30 days (daily).
// ==================================================================
async function getRevenueChart(req, res) {
  const period = req.query.period || "daily";
  console.log({ route: "GET /api/dashboard/revenue-chart", period, status: "fetching chart data" });

  const ALLOWED_PERIODS = { daily: "day", weekly: "week", monthly: "month" };
  const trunc = ALLOWED_PERIODS[period];
  if (!trunc) {
    return res.status(400).json({ success: false, message: "period must be daily, weekly, or monthly" });
  }

  // Interval rows — kept as integers fed via parameter to avoid any interpolation
  const intervalDays = { daily: 30, weekly: 84, monthly: 365 }; // 84d ≈ 12 weeks
  const days = intervalDays[period];

  try {
    const result = await db.query(`
      SELECT
        date_trunc($1, created_at)   AS period,
        COUNT(*)                     AS orders,
        COALESCE(SUM(total), 0)      AS revenue,
        COALESCE(SUM(discount), 0)   AS discount
      FROM orders
      WHERE created_at >= NOW() - ($2 || ' days')::interval
        AND status NOT IN ('cancelled')
      GROUP BY date_trunc($1, created_at)
      ORDER BY period ASC
    `, [trunc, days]);

    console.log({ route: "GET /api/dashboard/revenue-chart", period, status: 200, count: result.rows.length });
    return res.json({
      success: true,
      period,
      chart: result.rows.map(r => ({
        period: r.period,
        orders: parseInt(r.orders),
        revenue: num(r.revenue),
        discount: num(r.discount)
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/dashboard/revenue-chart", period, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/dashboard/top-products?limit=10
// Best-selling products by revenue and units sold.
// ==================================================================
async function getTopProducts(req, res) {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  console.log({ route: "GET /api/dashboard/top-products", limit, status: "fetching top products" });

  try {
    const result = await db.query(`
      SELECT
        p.id,
        p.name_en,
        p.name_ta,
        c.name_en                       AS category,
        SUM(oi.quantity)                AS units_sold,
        SUM(oi.price * oi.quantity)     AS revenue,
        COUNT(DISTINCT oi.order_id)     AS order_count
      FROM order_items oi
      JOIN products p   ON p.id = oi.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      JOIN orders o     ON o.id = oi.order_id
      WHERE o.status != 'cancelled' AND o.payment_method != 'replacement'
      GROUP BY p.id, p.name_en, p.name_ta, c.name_en
      ORDER BY revenue DESC
      LIMIT $1
    `, [limit]);

    console.log({ route: "GET /api/dashboard/top-products", limit, status: 200, count: result.rows.length });
    return res.json({
      success: true,
      topProducts: result.rows.map(r => ({
        id: r.id,
        name: r.name_ta ? `${r.name_en} (${r.name_ta})` : r.name_en,
        category: r.category,
        unitsSold: parseInt(r.units_sold),
        revenue: num(r.revenue),
        orderCount: parseInt(r.order_count)
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/dashboard/top-products", limit, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/dashboard/top-customers?limit=10
// Customers ranked by total spend.
// ==================================================================
async function getTopCustomers(req, res) {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  console.log({ route: "GET /api/dashboard/top-customers", limit, status: "fetching top customers" });

  try {
    const result = await db.query(`
      SELECT
        u.id,
        u.full_name,
        u.email,
        u.phone,
        COUNT(o.id)        AS total_orders,
        SUM(o.total)       AS total_spent,
        MAX(o.created_at)  AS last_order_at
      FROM users u
      JOIN orders o ON o.user_id = u.id
      WHERE o.status != 'cancelled' AND o.payment_method != 'replacement'
      GROUP BY u.id, u.full_name, u.email, u.phone
      ORDER BY total_spent DESC
      LIMIT $1
    `, [limit]);

    console.log({ route: "GET /api/dashboard/top-customers", limit, status: 200, count: result.rows.length });
    return res.json({
      success: true,
      topCustomers: result.rows.map(r => ({
        id: r.id,
        name: r.full_name,
        email: r.email,
        phone: r.phone,
        totalOrders: parseInt(r.total_orders),
        totalSpent: num(r.total_spent),
        lastOrderAt: r.last_order_at
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/dashboard/top-customers", limit, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/dashboard/low-stock?limit=20
// Variants running low on stock (stock_qty <= 10).
// ==================================================================
// ==================================================================
// GET /api/dashboard/out-of-stock?limit=20
// Variants out of stock (stock_qty = 0).
// ==================================================================
async function getOutOfStock(req, res) {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  console.log({ route: "GET /api/dashboard/out-of-stock", limit, status: "fetching out of stock variants" });

  try {
    const result = await db.query(`
      SELECT
        pv.id            AS variant_id,
        p.id             AS product_id,
        p.name_en,
        p.name_ta,
        pv.weight_label,
        pv.stock_qty
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.is_active = TRUE AND pv.stock_qty = 0
      ORDER BY p.name_en ASC
      LIMIT $1
    `, [limit]);

    console.log({ route: "GET /api/dashboard/out-of-stock", limit, status: 200, count: result.rows.length });
    return res.json({
      success: true,
      outOfStock: result.rows.map(r => ({
        variantId: r.variant_id,
        productId: r.product_id,
        name: r.name_ta ? `${r.name_en} (${r.name_ta})` : r.name_en,
        weightLabel: r.weight_label,
        stockQty: parseInt(r.stock_qty)
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/dashboard/out-of-stock", limit, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/dashboard/recent-orders?limit=10
// Latest orders with customer + status — for the dashboard feed.
// ==================================================================
async function getRecentOrders(req, res) {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  console.log({ route: "GET /api/dashboard/recent-orders", limit, status: "fetching recent orders" });

  try {
    const result = await db.query(`
      SELECT
        o.id,
        o.customer_name,
        o.customer_phone,
        o.total,
        o.status,
        o.payment_status,
        o.payment_method,
        o.created_at
      FROM orders o
      ORDER BY o.created_at DESC
      LIMIT $1
    `, [limit]);

    console.log({ route: "GET /api/dashboard/recent-orders", limit, status: 200, count: result.rows.length });
    return res.json({
      success: true,
      recentOrders: result.rows.map(r => ({
        id: r.id,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        total: num(r.total),
        status: r.status,
        paymentStatus: r.payment_status,
        paymentMethod: r.payment_method,
        createdAt: r.created_at
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/dashboard/recent-orders", limit, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/dashboard/sales-by-category
// Revenue breakdown per category.
// ==================================================================
async function getSalesByCategory(req, res) {
  console.log({ route: "GET /api/dashboard/sales-by-category", status: "fetching sales breakdown" });
  try {
    const result = await db.query(`
      SELECT
        COALESCE(c.name_en, 'Uncategorised')   AS category,
        COUNT(DISTINCT o.id)                    AS order_count,
        SUM(oi.quantity)                        AS units_sold,
        SUM(oi.price * oi.quantity)             AS revenue
      FROM order_items oi
      JOIN products p    ON p.id = oi.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      JOIN orders o      ON o.id = oi.order_id
      WHERE o.status != 'cancelled' AND o.payment_method != 'replacement'
      GROUP BY c.name_en
      ORDER BY revenue DESC
    `);

    console.log({ route: "GET /api/dashboard/sales-by-category", status: 200, count: result.rows.length });
    return res.json({
      success: true,
      salesByCategory: result.rows.map(r => ({
        category: r.category,
        orderCount: parseInt(r.order_count),
        unitsSold: parseInt(r.units_sold),
        revenue: num(r.revenue)
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/dashboard/sales-by-category", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/dashboard/return-requests?status=requested
// Return/refund requests list for the admin.
// ==================================================================
async function getReplacementRequests(req, res) {
  const status = req.query.status || null;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  console.log({ route: "GET /api/dashboard/replacement-requests", status, limit, statusMsg: "fetching replacement requests" });

  try {
    const result = await db.query(`
      SELECT
        rr.id,
        rr.order_id,
        rr.reason,
        rr.details,
        rr.status,
        rr.admin_notes,
        rr.new_order_id,
        rr.created_at,
        u.full_name   AS customer_name,
        u.phone       AS customer_phone,
        u.email       AS customer_email
      FROM replacement_requests rr
      JOIN users u ON u.id = rr.user_id
      WHERE ($1::text IS NULL OR rr.status = $1)
      ORDER BY rr.created_at DESC
      LIMIT $2
    `, [status, limit]);

    console.log({ route: "GET /api/dashboard/replacement-requests", status, limit, status: 200, count: result.rows.length });
    return res.json({
      success: true,
      replacementRequests: result.rows
    });
  } catch (err) {
    console.error({ route: "GET /api/dashboard/return-requests", status, limit, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getSummary,
  getRevenueChart,
  getTopProducts,
  getTopCustomers,
  getOutOfStock,
  getRecentOrders,
  getSalesByCategory,
  getReplacementRequests
};