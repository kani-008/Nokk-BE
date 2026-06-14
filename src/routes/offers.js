const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, isAdmin } = require('../middleware/auth');

// GET /api/offers - List all active coupons (Public)
router.get('/', async (req, res) => {
  try {
    const couponsRes = await db.query(
      'SELECT code, discount_percent AS "discountPercent", discount_flat AS "discountFlat", free_shipping AS "freeShipping", min_order AS "minOrder", description, expiry_date AS "expiry" FROM coupons WHERE is_active = TRUE AND (expiry_date IS NULL OR expiry_date > NOW()) ORDER BY created_at DESC'
    );
    return res.json({ success: true, coupons: couponsRes.rows });
  } catch (err) {
    console.error('Coupons fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// GET /api/offers/admin/list - List all coupons including inactive (Admin Protected)
router.get('/admin/list', verifyToken, isAdmin, async (req, res) => {
  try {
    const couponsRes = await db.query(
      'SELECT id, code, discount_percent AS "discountPercent", discount_flat AS "discountFlat", free_shipping AS "freeShipping", min_order AS "minOrder", max_uses AS "maxUses", usage_count AS "usageCount", expiry_date AS "expiry", description, is_active AS "isActive" FROM coupons ORDER BY created_at DESC'
    );
    return res.json({ success: true, coupons: couponsRes.rows });
  } catch (err) {
    console.error('Coupons list admin error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/offers/validate - Validate coupon code for checkout (Public or Protected)
router.post('/validate', async (req, res) => {
  const { code, subtotal } = req.body;

  if (!code) {
    return res.status(400).json({ success: false, message: 'Coupon code is required' });
  }

  try {
    const couponRes = await db.query(
      'SELECT id, code, discount_percent, discount_flat, free_shipping, min_order, max_uses, usage_count, expiry_date, description FROM coupons WHERE code = $1 AND is_active = TRUE',
      [code.trim().toUpperCase()]
    );

    if (couponRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid coupon code' });
    }

    const coupon = couponRes.rows[0];

    // Check expiry
    if (coupon.expiry_date && new Date(coupon.expiry_date) < new Date()) {
      return res.status(400).json({ success: false, message: 'Coupon code has expired' });
    }

    // Check usage limits
    if (coupon.usage_count >= coupon.max_uses) {
      return res.status(400).json({ success: false, message: 'Coupon code is no longer valid (usage limit reached)' });
    }

    // Check subtotal
    if (subtotal !== undefined && parseFloat(subtotal) < parseFloat(coupon.min_order)) {
      return res.status(400).json({ 
        success: false, 
        message: `Minimum order of ₹${parseFloat(coupon.min_order)} required for this coupon` 
      });
    }

    return res.json({
      success: true,
      message: 'Coupon code applied successfully!',
      coupon: {
        id: coupon.id,
        code: coupon.code,
        discountPercent: parseInt(coupon.discount_percent),
        discountFlat: parseFloat(coupon.discount_flat),
        freeShipping: coupon.free_shipping,
        minOrder: parseFloat(coupon.min_order),
        description: coupon.description
      }
    });
  } catch (err) {
    console.error('Coupon validation error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/offers - Create coupon (Admin Protected)
router.post('/', verifyToken, isAdmin, async (req, res) => {
  const { code, discountPercent, discountFlat, freeShipping, minOrder, maxUses, expiry, description } = req.body;

  if (!code) {
    return res.status(400).json({ success: false, message: 'Coupon code is required' });
  }

  try {
    const existRes = await db.query('SELECT id FROM coupons WHERE code = $1', [code.trim().toUpperCase()]);
    if (existRes.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Coupon code already exists' });
    }

    const newCoupon = await db.query(
      `INSERT INTO coupons (code, discount_percent, discount_flat, free_shipping, min_order, max_uses, expiry_date, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, code, discount_percent AS "discountPercent", discount_flat AS "discountFlat", free_shipping AS "freeShipping", min_order AS "minOrder", max_uses AS "maxUses", expiry_date AS "expiry", description`,
      [
        code.trim().toUpperCase(),
        discountPercent || 0,
        discountFlat || 0.00,
        freeShipping || false,
        minOrder || 0.00,
        maxUses || 100,
        expiry || null,
        description || null
      ]
    );

    return res.status(201).json({ success: true, coupon: newCoupon.rows[0] });
  } catch (err) {
    console.error('Coupon creation error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// PUT /api/offers/:id - Update coupon (Admin Protected)
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
  const { code, discountPercent, discountFlat, freeShipping, minOrder, maxUses, expiry, description, isActive } = req.body;

  try {
    const updRes = await db.query(
      `UPDATE coupons
       SET code = COALESCE($1, code),
           discount_percent = COALESCE($2, discount_percent),
           discount_flat = COALESCE($3, discount_flat),
           free_shipping = COALESCE($4, free_shipping),
           min_order = COALESCE($5, min_order),
           max_uses = COALESCE($6, max_uses),
           expiry_date = COALESCE($7, expiry_date),
           description = COALESCE($8, description),
           is_active = COALESCE($9, is_active),
           updated_at = NOW()
       WHERE id = $10
       RETURNING id`,
      [
        code ? code.trim().toUpperCase() : null,
        discountPercent,
        discountFlat,
        freeShipping,
        minOrder,
        maxUses,
        expiry,
        description,
        isActive,
        req.params.id
      ]
    );

    if (updRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Coupon not found' });
    }

    return res.json({ success: true, message: 'Coupon updated successfully!' });
  } catch (err) {
    console.error('Coupon update error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// DELETE /api/offers/:id - Delete coupon (Admin Protected)
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const delRes = await db.query('DELETE FROM coupons WHERE id = $1 RETURNING id', [req.params.id]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Coupon not found' });
    }
    return res.json({ success: true, message: 'Coupon deleted successfully' });
  } catch (err) {
    console.error('Coupon delete error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
