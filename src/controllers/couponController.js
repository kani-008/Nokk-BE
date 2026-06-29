const db = require("../config/db.js");

// Schema columns: id, code, discount_percent, discount_flat, free_shipping,
//                 min_order, max_uses, max_uses_per_user, expiry_date, usage_count,
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
    maxUsesPerUser: c.max_uses_per_user !== null && c.max_uses_per_user !== undefined ? parseInt(c.max_uses_per_user) : null,
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
  console.log({ route: "POST /api/coupons/validate", body: { code, subtotal }, status: "validating coupon" });

  if (!code) {
    console.log({ route: "POST /api/coupons/validate", status: 400, message: "Coupon code is required" });
    return res.status(400).json({ success: false, message: "Coupon code is required" });
  }

  try {
    const result = await db.query(
      `SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE`, [code]
    );

    if (result.rows.length === 0) {
      console.log({ route: "POST /api/coupons/validate", code, status: 404, message: "Invalid coupon code" });
      return res.status(404).json({ success: false, message: "Invalid coupon code" });
    }

    const c = result.rows[0];

    // Expiry check
    if (c.expiry_date && new Date(c.expiry_date) < new Date()) {
      console.log({ route: "POST /api/coupons/validate", code, status: 400, message: "Coupon expired" });
      return res.status(400).json({ success: false, message: "This coupon has expired" });
    }

    // Usage limit check
    if (c.max_uses !== null && parseInt(c.usage_count) >= c.max_uses) {
      console.log({ route: "POST /api/coupons/validate", code, status: 400, message: "Coupon usage limit reached" });
      return res.status(400).json({ success: false, message: "This coupon has reached its usage limit" });
    }

    // Per-user usage limit check
    if (c.max_uses_per_user !== null) {
      const userId = req.user.id;
      const userUsageRes = await db.query(
        "SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_id = $1 AND user_id = $2",
        [c.id, userId]
      );
      const userUsageCount = parseInt(userUsageRes.rows[0].count) || 0;
      if (userUsageCount >= c.max_uses_per_user) {
        console.log({ route: "POST /api/coupons/validate", code, userId, status: 400, message: "Per-user usage limit reached" });
        return res.status(400).json({ success: false, message: "You have reached your personal usage limit for this coupon" });
      }
    }

    // Minimum order check
    if (subtotal < parseFloat(c.min_order)) {
      console.log({ route: "POST /api/coupons/validate", code, status: 400, message: "min order not met" });
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

    console.log({ route: "POST /api/coupons/validate", code, status: 200, discountAmount });
    return res.json({
      success: true,
      message: "Coupon applied successfully",
      coupon: formatCoupon(c),
      discountAmount: parseFloat(discountAmount.toFixed(2)),
      freeShipping: c.free_shipping
    });
  } catch (err) {
    console.error({ route: "POST /api/coupons/validate", code, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/coupons
// All coupons with active/expired/exhausted flags.
// ==================================================================
async function getAllCoupons(req, res) {
  console.log({ route: "GET /api/coupons", status: "fetching all coupons" });
  try {
    const result = await db.query(
      `SELECT * FROM coupons ORDER BY created_at DESC`
    );
    console.log({ route: "GET /api/coupons", status: 200, count: result.rows.length });
    return res.json({ success: true, coupons: result.rows.map(formatCoupon) });
  } catch (err) {
    console.error({ route: "GET /api/coupons", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/coupons
// Body: { code, discountPercent?, discountFlat?, freeShipping?,
//         minOrder?, maxUses?, maxUsesPerUser?, expiryDate?, description?, isActive? }
// ==================================================================
async function createCoupon(req, res) {
  const {
    code, discountPercent, discountFlat, freeShipping,
    minOrder, maxUses, maxUsesPerUser, expiryDate, description, isActive
  } = req.body;
  console.log({ route: "POST /api/coupons", body: { code, discountPercent, discountFlat, freeShipping, minOrder, maxUses, maxUsesPerUser, expiryDate, isActive }, status: "creating coupon" });

  if (!code) {
    console.log({ route: "POST /api/coupons", status: 400, message: "code is required" });
    return res.status(400).json({ success: false, message: "code is required" });
  }

  if (discountPercent > 0 && discountFlat > 0) {
    return res.status(400).json({ success: false, message: "Cannot specify both percentage and flat discount values" });
  }

  const upperCode = String(code).trim().toUpperCase();

  try {
    const dup = await db.query("SELECT id FROM coupons WHERE code = $1", [upperCode]);
    if (dup.rows.length > 0) {
      console.log({ route: "POST /api/coupons", code: upperCode, status: 409, message: "coupon code already exists" });
      return res.status(409).json({ success: false, message: "Coupon code already exists" });
    }

    const result = await db.query(
      `INSERT INTO coupons
         (code, discount_percent, discount_flat, free_shipping,
          min_order, max_uses, max_uses_per_user, expiry_date, description, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        upperCode,
        discountPercent || 0,
        discountFlat || 0,
        freeShipping || false,
        minOrder || 0,
        maxUses || null,
        maxUsesPerUser || null,
        expiryDate || null,
        description || null,
        isActive ?? true
      ]
    );
    console.log({ route: "POST /api/coupons", code: upperCode, status: 201, couponId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Coupon created", coupon: formatCoupon(result.rows[0]) });
  } catch (err) {
    console.error({ route: "POST /api/coupons", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/coupons/:id
// ==================================================================
async function updateCoupon(req, res) {
  const {
    id, code, discountPercent, discountFlat, freeShipping,
    minOrder, maxUses, maxUsesPerUser, expiryDate, description, isActive
  } = req.body;
  console.log({ route: "PUT /api/coupons/update-coupon", couponId: id, body: { code, discountPercent, discountFlat, freeShipping, minOrder, maxUses, maxUsesPerUser, expiryDate, isActive }, status: "updating coupon" });

  if (!id) {
    return res.status(400).json({ success: false, message: "Coupon ID is required" });
  }

  try {
    const existingRes = await db.query("SELECT * FROM coupons WHERE id = $1", [id]);
    if (existingRes.rows.length === 0) {
      console.log({ route: "PUT /api/coupons/update-coupon", couponId: id, status: 404, message: "Coupon not found" });
      return res.status(404).json({ success: false, message: "Coupon not found" });
    }
    const existing = existingRes.rows[0];

    const currentPercent = discountPercent !== undefined ? (Number(discountPercent) || 0) : parseInt(existing.discount_percent || 0);
    const currentFlat = discountFlat !== undefined ? (Number(discountFlat) || 0) : parseFloat(existing.discount_flat || 0);

    if (currentPercent > 0 && currentFlat > 0) {
      return res.status(400).json({ success: false, message: "Cannot specify both percentage and flat discount values" });
    }

    let upperCode = existing.code;
    if (code !== undefined) {
      if (!code || !String(code).trim()) {
        return res.status(400).json({ success: false, message: "Coupon code cannot be empty" });
      }
      upperCode = String(code).trim().toUpperCase();
      const dup = await db.query("SELECT id FROM coupons WHERE code = $1 AND id != $2", [upperCode, id]);
      if (dup.rows.length > 0) {
        return res.status(409).json({ success: false, message: "Coupon code already exists" });
      }
    }

    const finalPercent = discountPercent !== undefined ? discountPercent : parseInt(existing.discount_percent || 0);
    const finalFlat = discountFlat !== undefined ? discountFlat : parseFloat(existing.discount_flat || 0);
    const finalFreeShipping = freeShipping !== undefined ? freeShipping : existing.free_shipping;
    const finalMinOrder = minOrder !== undefined ? minOrder : parseFloat(existing.min_order || 0);
    const finalMaxUses = maxUses !== undefined ? (maxUses || null) : existing.max_uses;
    const finalMaxUsesPerUser = maxUsesPerUser !== undefined ? (maxUsesPerUser || null) : existing.max_uses_per_user;
    const finalExpiryDate = expiryDate !== undefined ? (expiryDate || null) : existing.expiry_date;
    const finalDesc = description !== undefined ? (description || null) : existing.description;
    const finalIsActive = isActive !== undefined ? isActive : existing.is_active;

    const result = await db.query(
      `UPDATE coupons SET
         code             = $1,
         discount_percent = $2,
         discount_flat    = $3,
         free_shipping    = $4,
         min_order        = $5,
         max_uses         = $6,
         max_uses_per_user = $7,
         expiry_date      = $8,
         description      = $9,
         is_active        = $10,
         updated_at       = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        upperCode,
        finalPercent,
        finalFlat,
        finalFreeShipping,
        finalMinOrder,
        finalMaxUses,
        finalMaxUsesPerUser,
        finalExpiryDate,
        finalDesc,
        finalIsActive,
        id
      ]
    );

    console.log({ route: "PUT /api/coupons/update-coupon", couponId: id, status: 200 });
    return res.json({ success: true, message: "Coupon updated", coupon: formatCoupon(result.rows[0]) });
  } catch (err) {
    console.error({ route: "PUT /api/coupons/update-coupon", couponId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/coupons/:id
// ==================================================================
async function deleteCoupon(req, res) {
  const { id } = req.body;
  console.log({ route: "DELETE /api/coupons/delete-coupon", couponId: id, status: "deleting coupon" });
  if (!id) {
    return res.status(400).json({ success: false, message: "Coupon ID is required" });
  }
  try {
    const result = await db.query(
      "DELETE FROM coupons WHERE id = $1 RETURNING id", [id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/coupons/delete-coupon", couponId: id, status: 404, message: "Coupon not found" });
      return res.status(404).json({ success: false, message: "Coupon not found" });
    }
    console.log({ route: "DELETE /api/coupons/delete-coupon", couponId: id, status: 200 });
    return res.json({ success: true, message: "Coupon deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/coupons/delete-coupon", couponId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { validateCoupon, getAllCoupons, createCoupon, updateCoupon, deleteCoupon };