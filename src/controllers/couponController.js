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
  const userId = req.user?.id || "unknown";
  console.log(`[coupon/validate] REQUEST  | user: ${userId} | code: "${code}" | subtotal: ₹${subtotal}`);

  if (!code) {
    console.log(`[coupon/validate] STATUS 400 | user: ${userId} | reason: empty code`);
    return res.status(400).json({ success: false, message: "Coupon code is required" });
  }

  try {
    const result = await db.query(
      `SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE`, [code]
    );
    console.log(`[coupon/validate] DB query | code: "${code}" | rows found: ${result.rows.length}`);

    if (result.rows.length === 0) {
      console.log(`[coupon/validate] STATUS 404 | code: "${code}" | reason: not found or inactive`);
      return res.status(404).json({ success: false, message: "Invalid coupon code" });
    }

    const c = result.rows[0];
    console.log(`[coupon/validate] Coupon found | id: ${c.id} | discount_percent: ${c.discount_percent} | discount_flat: ${c.discount_flat} | min_order: ${c.min_order} | expiry: ${c.expiry_date} | usage: ${c.usage_count}/${c.max_uses ?? "∞"}`);

    // Expiry check
    if (c.expiry_date && new Date(c.expiry_date) < new Date()) {
      console.log(`[coupon/validate] STATUS 400 | code: "${code}" | reason: expired on ${c.expiry_date}`);
      return res.status(400).json({ success: false, message: "This coupon has expired" });
    }

    // Usage limit check
    if (c.max_uses !== null && parseInt(c.usage_count) >= c.max_uses) {
      console.log(`[coupon/validate] STATUS 400 | code: "${code}" | reason: usage limit reached (${c.usage_count}/${c.max_uses})`);
      return res.status(400).json({ success: false, message: "This coupon has reached its usage limit" });
    }

    // Per-user usage limit check
    if (c.max_uses_per_user !== null) {
      const userUsageRes = await db.query(
        "SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_id = $1 AND user_id = $2",
        [c.id, userId]
      );
      const userUsageCount = parseInt(userUsageRes.rows[0].count) || 0;
      console.log(`[coupon/validate] Per-user usage | user: ${userId} | used: ${userUsageCount}/${c.max_uses_per_user}`);
      if (userUsageCount >= c.max_uses_per_user) {
        console.log(`[coupon/validate] STATUS 400 | code: "${code}" | user: ${userId} | reason: per-user limit reached`);
        return res.status(400).json({ success: false, message: "You have reached your personal usage limit for this coupon" });
      }
    }

    // Minimum order check
    if (subtotal < parseFloat(c.min_order)) {
      console.log(`[coupon/validate] STATUS 400 | code: "${code}" | reason: subtotal ₹${subtotal} < min_order ₹${c.min_order}`);
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
    discountAmount = Math.min(discountAmount, subtotal);

    console.log(`[coupon/validate] STATUS 200 | code: "${code}" | user: ${userId} | discountAmount: ₹${discountAmount.toFixed(2)} | freeShipping: ${c.free_shipping}`);
    return res.json({
      success: true,
      message: "Coupon applied successfully",
      coupon: formatCoupon(c),
      discountAmount: parseFloat(discountAmount.toFixed(2)),
      freeShipping: c.free_shipping
    });
  } catch (err) {
    console.error(`[coupon/validate] STATUS 500 | code: "${code}" | error: ${err.message}`, err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/coupons
// All coupons with active/expired/exhausted flags.
// ==================================================================
async function getAllCoupons(req, res) {
  const adminId = req.user?.id || "unknown";
  console.log(`[coupon/get-all] REQUEST | admin: ${adminId}`);
  try {
    const result = await db.query(`SELECT * FROM coupons ORDER BY created_at DESC`);
    console.log(`[coupon/get-all] STATUS 200 | count: ${result.rows.length} | codes: [${result.rows.map(r => r.code).join(", ")}]`);
    return res.json({ success: true, coupons: result.rows.map(formatCoupon) });
  } catch (err) {
    console.error(`[coupon/get-all] STATUS 500 | error: ${err.message}`, err);
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
  const adminId = req.user?.id || "unknown";
  console.log(`[coupon/create] REQUEST | admin: ${adminId} | body:`, { code, discountPercent, discountFlat, freeShipping, minOrder, maxUses, maxUsesPerUser, expiryDate, isActive });

  if (!code) {
    console.log(`[coupon/create] STATUS 400 | reason: code is required`);
    return res.status(400).json({ success: false, message: "code is required" });
  }

  if (discountPercent > 0 && discountFlat > 0) {
    console.log(`[coupon/create] STATUS 400 | reason: both percent and flat specified`);
    return res.status(400).json({ success: false, message: "Cannot specify both percentage and flat discount values" });
  }

  const upperCode = String(code).trim().toUpperCase();

  try {
    const dup = await db.query("SELECT id FROM coupons WHERE code = $1", [upperCode]);
    if (dup.rows.length > 0) {
      console.log(`[coupon/create] STATUS 409 | code: "${upperCode}" | reason: duplicate code`);
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
    const created = result.rows[0];
    console.log(`[coupon/create] STATUS 201 | code: "${upperCode}" | id: ${created.id} | discount_percent: ${created.discount_percent} | discount_flat: ${created.discount_flat}`);
    return res.status(201).json({ success: true, message: "Coupon created", coupon: formatCoupon(created) });
  } catch (err) {
    console.error(`[coupon/create] STATUS 500 | code: "${upperCode}" | error: ${err.message}`, err);
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
  const adminId = req.user?.id || "unknown";
  console.log(`[coupon/update] REQUEST | admin: ${adminId} | couponId: ${id} | body:`, { code, discountPercent, discountFlat, freeShipping, minOrder, maxUses, maxUsesPerUser, expiryDate, isActive });

  if (!id) {
    return res.status(400).json({ success: false, message: "Coupon ID is required" });
  }

  try {
    const existingRes = await db.query("SELECT * FROM coupons WHERE id = $1", [id]);
    if (existingRes.rows.length === 0) {
      console.log(`[coupon/update] STATUS 404 | couponId: ${id} | reason: not found`);
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

    const updated = result.rows[0];
    console.log(`[coupon/update] STATUS 200 | couponId: ${id} | code: "${updated.code}" | discount_percent: ${updated.discount_percent} | discount_flat: ${updated.discount_flat} | is_active: ${updated.is_active}`);
    return res.json({ success: true, message: "Coupon updated", coupon: formatCoupon(updated) });
  } catch (err) {
    console.error(`[coupon/update] STATUS 500 | couponId: ${id} | error: ${err.message}`, err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/coupons/:id
// ==================================================================
async function deleteCoupon(req, res) {
  const { id } = req.body;
  const adminId = req.user?.id || "unknown";
  console.log(`[coupon/delete] REQUEST | admin: ${adminId} | couponId: ${id}`);
  if (!id) {
    console.log(`[coupon/delete] STATUS 400 | reason: id missing`);
    return res.status(400).json({ success: false, message: "Coupon ID is required" });
  }
  try {
    const result = await db.query("DELETE FROM coupons WHERE id = $1 RETURNING id, code", [id]);
    if (result.rows.length === 0) {
      console.log(`[coupon/delete] STATUS 404 | couponId: ${id} | reason: not found`);
      return res.status(404).json({ success: false, message: "Coupon not found" });
    }
    console.log(`[coupon/delete] STATUS 200 | couponId: ${id} | code: "${result.rows[0].code}" | deleted successfully`);
    return res.json({ success: true, message: "Coupon deleted" });
  } catch (err) {
    console.error(`[coupon/delete] STATUS 500 | couponId: ${id} | error: ${err.message}`, err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// PUBLIC — GET /api/coupons/get-public
// Returns active, non-expired coupons (no auth required).
// ==================================================================
async function getPublicCoupons(req, res) {
  console.log(`[coupon/get-public] REQUEST — fetching public coupons`);
  try {
    const result = await db.query(
      `SELECT * FROM coupons
       WHERE is_active = TRUE
         AND (expiry_date IS NULL OR expiry_date > NOW())
         AND (max_uses IS NULL OR usage_count < max_uses)
       ORDER BY created_at DESC`
    );
    console.log(`[coupon/get-public] STATUS 200 | count: ${result.rows.length} | codes: [${result.rows.map(r => r.code).join(", ")}]`);
    return res.json({ success: true, coupons: result.rows.map(formatCoupon) });
  } catch (err) {
    console.error(`[coupon/get-public] STATUS 500 | error: ${err.message}`, err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { validateCoupon, getAllCoupons, createCoupon, updateCoupon, deleteCoupon, getPublicCoupons };