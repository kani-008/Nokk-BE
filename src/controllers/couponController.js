const db = require("../config/db.js");

const log = (data) => console.log(data);
const lerr = (data) => console.error(data);

// Schema columns: id, code, discount_percent, discount_flat, free_shipping,
//                 min_order, max_uses, expiry_date, usage_count,
//                 description, is_active, created_at, updated_at
function formatCoupon(c) {
  return {
    id: c.id,
    code: c.code,
    discountPercent: parseInt(c.discount_percent),
    discountFlat: parseFloat(c.discount_flat),
    freeShipping: c.free_shipping,
    minOrder: parseFloat(c.min_order),
    maxUses: c.max_uses,
    usageCount: parseInt(c.usage_count),
    expiryDate: c.expiry_date,
    description: c.description,
    isActive: c.is_active,
    isExpired: c.expiry_date ? new Date(c.expiry_date) < new Date() : false,
    isExhausted: c.max_uses !== null && parseInt(c.usage_count) >= c.max_uses,
    createdAt: c.created_at,
    updatedAt: c.updated_at
  };
}

// ==================================================================
// PUBLIC — POST /api/coupons/validate
// Validates a coupon code against an order subtotal.
// Body: { code, subtotal }
// Returns the coupon details + computed discount amount.
// ==================================================================
async function validateCoupon(req, res) {
  const code = req.body.code ? String(req.body.code).trim().toUpperCase() : "";
  const subtotal = parseFloat(req.body.subtotal) || 0;
  log({ route: "POST /api/coupons/validate", body: { code, subtotal }, status: "validating coupon" });

  if (!code) {
    log({ route: "POST /api/coupons/validate", status: 400, message: "Coupon code is required" });
    return res.status(400).json({ success: false, message: "Coupon code is required" });
  }

  try {
    const result = await db.query(
      `SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE`, [code]
    );

    if (result.rows.length === 0) {
      log({ route: "POST /api/coupons/validate", code, status: 404, message: "Invalid coupon code" });
      return res.status(404).json({ success: false, message: "Invalid coupon code" });
    }

    const c = result.rows[0];

    // Expiry check
    if (c.expiry_date && new Date(c.expiry_date) < new Date()) {
      log({ route: "POST /api/coupons/validate", code, status: 400, message: "Coupon expired" });
      return res.status(400).json({ success: false, message: "This coupon has expired" });
    }

    // Usage limit check
    if (c.max_uses !== null && parseInt(c.usage_count) >= c.max_uses) {
      log({ route: "POST /api/coupons/validate", code, status: 400, message: "Coupon usage limit reached" });
      return res.status(400).json({ success: false, message: "This coupon has reached its usage limit" });
    }

    // Minimum order check
    if (subtotal < parseFloat(c.min_order)) {
      log({ route: "POST /api/coupons/validate", code, status: 400, message: "min order not met" });
      return res.status(400).json({
        success: false,
        message: `Minimum order of ₹${c.min_order} required for this coupon`
      });
    }

    // Compute discount
    let discountAmount = 0;
    if (c.discount_percent > 0) {
      discountAmount = (subtotal * c.discount_percent) / 100;
    } else if (parseFloat(c.discount_flat) > 0) {
      discountAmount = parseFloat(c.discount_flat);
    }
    discountAmount = Math.min(discountAmount, subtotal); // never exceed subtotal

    log({ route: "POST /api/coupons/validate", code, status: 200, discountAmount });
    return res.json({
      success: true,
      message: "Coupon applied successfully",
      coupon: formatCoupon(c),
      discountAmount: parseFloat(discountAmount.toFixed(2)),
      freeShipping: c.free_shipping
    });
  } catch (err) {
    lerr({ route: "POST /api/coupons/validate", code, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/coupons
// All coupons with active/expired/exhausted flags.
// ==================================================================
async function getAllCoupons(req, res) {
  log({ route: "GET /api/coupons", status: "fetching all coupons" });
  try {
    const result = await db.query(
      `SELECT * FROM coupons ORDER BY created_at DESC`
    );
    log({ route: "GET /api/coupons", status: 200, count: result.rows.length });
    return res.json({ success: true, coupons: result.rows.map(formatCoupon) });
  } catch (err) {
    lerr({ route: "GET /api/coupons", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/coupons
// Body: { code, discountPercent?, discountFlat?, freeShipping?,
//         minOrder?, maxUses?, expiryDate?, description?, isActive? }
// ==================================================================
async function createCoupon(req, res) {
  const {
    code, discountPercent, discountFlat, freeShipping,
    minOrder, maxUses, expiryDate, description, isActive
  } = req.body;
  log({ route: "POST /api/coupons", body: { code, discountPercent, discountFlat, freeShipping, minOrder, maxUses, expiryDate, isActive }, status: "creating coupon" });

  if (!code) {
    log({ route: "POST /api/coupons", status: 400, message: "code is required" });
    return res.status(400).json({ success: false, message: "code is required" });
  }

  const upperCode = String(code).trim().toUpperCase();

  try {
    const dup = await db.query("SELECT id FROM coupons WHERE code = $1", [upperCode]);
    if (dup.rows.length > 0) {
      log({ route: "POST /api/coupons", code: upperCode, status: 409, message: "coupon code already exists" });
      return res.status(409).json({ success: false, message: "Coupon code already exists" });
    }

    const result = await db.query(
      `INSERT INTO coupons
         (code, discount_percent, discount_flat, free_shipping,
          min_order, max_uses, expiry_date, description, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        upperCode,
        discountPercent || 0,
        discountFlat || 0,
        freeShipping || false,
        minOrder || 0,
        maxUses || null,
        expiryDate || null,
        description || null,
        isActive ?? true
      ]
    );
    log({ route: "POST /api/coupons", code: upperCode, status: 201, couponId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Coupon created", coupon: formatCoupon(result.rows[0]) });
  } catch (err) {
    lerr({ route: "POST /api/coupons", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/coupons/:id
// ==================================================================
async function updateCoupon(req, res) {
  const { id } = req.params;
  const {
    discountPercent, discountFlat, freeShipping,
    minOrder, maxUses, expiryDate, description, isActive
  } = req.body;
  log({ route: "PUT /api/coupons/:id", couponId: id, body: { discountPercent, discountFlat, freeShipping, minOrder, maxUses, expiryDate, isActive }, status: "updating coupon" });

  try {
    const result = await db.query(
      `UPDATE coupons SET
         discount_percent = COALESCE($1, discount_percent),
         discount_flat    = COALESCE($2, discount_flat),
         free_shipping    = COALESCE($3, free_shipping),
         min_order        = COALESCE($4, min_order),
         max_uses         = COALESCE($5, max_uses),
         expiry_date      = COALESCE($6, expiry_date),
         description      = COALESCE($7, description),
         is_active        = COALESCE($8, is_active),
         updated_at       = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        discountPercent !== undefined ? discountPercent : null,
        discountFlat !== undefined ? discountFlat : null,
        freeShipping !== undefined ? freeShipping : null,
        minOrder !== undefined ? minOrder : null,
        maxUses !== undefined ? maxUses : null,
        expiryDate !== undefined ? expiryDate : null,
        description !== undefined ? description : null,
        isActive !== undefined ? isActive : null,
        id
      ]
    );
    if (result.rows.length === 0) {
      log({ route: "PUT /api/coupons/:id", couponId: id, status: 404, message: "Coupon not found" });
      return res.status(404).json({ success: false, message: "Coupon not found" });
    }
    log({ route: "PUT /api/coupons/:id", couponId: id, status: 200 });
    return res.json({ success: true, message: "Coupon updated", coupon: formatCoupon(result.rows[0]) });
  } catch (err) {
    lerr({ route: "PUT /api/coupons/:id", couponId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/coupons/:id
// ==================================================================
async function deleteCoupon(req, res) {
  const { id } = req.params;
  log({ route: "DELETE /api/coupons/:id", couponId: id, status: "deleting coupon" });
  try {
    const result = await db.query(
      "DELETE FROM coupons WHERE id = $1 RETURNING id", [id]
    );
    if (result.rows.length === 0) {
      log({ route: "DELETE /api/coupons/:id", couponId: id, status: 404, message: "Coupon not found" });
      return res.status(404).json({ success: false, message: "Coupon not found" });
    }
    log({ route: "DELETE /api/coupons/:id", couponId: id, status: 200 });
    return res.json({ success: true, message: "Coupon deleted" });
  } catch (err) {
    lerr({ route: "DELETE /api/coupons/:id", couponId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { validateCoupon, getAllCoupons, createCoupon, updateCoupon, deleteCoupon };