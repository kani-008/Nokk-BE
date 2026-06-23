const db     = require("../config/db.js");
const logger = require("../utils/logger.js");

// Live offers table columns (from current_schema.sql dump):
// id, name, description, discount_value, product_id, category_id,
// min_order_value, max_discount, start_date, end_date, is_active,
// created_at, updated_at
// NOTE: no offer_type column in live DB — discount_value is always a flat/percent
// based on context. We treat it as a percentage if <= 100 and product/category scoped.

const num = (v) => parseFloat(v) || 0;

function formatOffer(o) {
  const now = new Date();
  const started  = !o.start_date || new Date(o.start_date) <= now;
  const notEnded = !o.end_date   || new Date(o.end_date)   >= now;
  return {
    id:             o.id,
    name:           o.name,
    description:    o.description,
    discountValue:  num(o.discount_value),
    productId:      o.product_id,
    productName:    o.product_name    || null,
    categoryId:     o.category_id,
    categoryName:   o.category_name   || null,
    minOrderValue:  num(o.min_order_value),
    maxDiscount:    o.max_discount ? num(o.max_discount) : null,
    startDate:      o.start_date,
    endDate:        o.end_date,
    isActive:       o.is_active,
    isLive:         o.is_active && started && notEnded,
    createdAt:      o.created_at,
    updatedAt:      o.updated_at
  };
}

// ==================================================================
// PUBLIC — GET /api/offers
// All currently live offers with product/category names joined.
// Used by: Public Offers page, product detail discount badge.
// ==================================================================
async function getActiveOffers(req, res) {
  try {
    const result = await db.query(
      `SELECT
         o.*,
         p.name_en  AS product_name,
         c.name_en  AS category_name
       FROM offers o
       LEFT JOIN products   p ON p.id = o.product_id
       LEFT JOIN categories c ON c.id = o.category_id
       WHERE o.is_active = TRUE
         AND (o.start_date IS NULL OR o.start_date <= NOW())
         AND (o.end_date   IS NULL OR o.end_date   >= NOW())
       ORDER BY o.created_at DESC`
    );
    return res.json({ success: true, offers: result.rows.map(formatOffer) });
  } catch (err) {
    logger.error("Get active offers error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/offers/all
// All offers including inactive and expired — for admin manage screen.
// ==================================================================
async function getAllOffers(req, res) {
  try {
    const result = await db.query(
      `SELECT
         o.*,
         p.name_en  AS product_name,
         c.name_en  AS category_name
       FROM offers o
       LEFT JOIN products   p ON p.id = o.product_id
       LEFT JOIN categories c ON c.id = o.category_id
       ORDER BY o.created_at DESC`
    );
    return res.json({ success: true, offers: result.rows.map(formatOffer) });
  } catch (err) {
    logger.error("Get all offers error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/offers/:id
// Single offer detail.
// ==================================================================
async function getOfferById(req, res) {
  try {
    const result = await db.query(
      `SELECT o.*, p.name_en AS product_name, c.name_en AS category_name
       FROM offers o
       LEFT JOIN products   p ON p.id = o.product_id
       LEFT JOIN categories c ON c.id = o.category_id
       WHERE o.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Offer not found" });
    }
    return res.json({ success: true, offer: formatOffer(result.rows[0]) });
  } catch (err) {
    logger.error("Get offer by id error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/offers
// Create a new offer campaign.
// Body: { name, description?, discountValue, productId?, categoryId?,
//         minOrderValue?, maxDiscount?, startDate?, endDate?, isActive? }
// ==================================================================
async function createOffer(req, res) {
  const {
    name, description, discountValue,
    productId, categoryId,
    minOrderValue, maxDiscount,
    startDate, endDate, isActive
  } = req.body;

  if (!name || discountValue == null) {
    return res.status(400).json({ success: false, message: "name and discountValue are required" });
  }
  if (discountValue <= 0 || discountValue > 100) {
    return res.status(400).json({ success: false, message: "discountValue must be between 1 and 100 (percent)" });
  }

  try {
    const result = await db.query(
      `INSERT INTO offers
         (name, description, discount_value, product_id, category_id,
          min_order_value, max_discount, start_date, end_date, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        name.trim(),
        description    || null,
        discountValue,
        productId      || null,
        categoryId     || null,
        minOrderValue  || 0,
        maxDiscount    || null,
        startDate      || null,
        endDate        || null,
        isActive       ?? true
      ]
    );
    return res.status(201).json({ success: true, message: "Offer created", offer: formatOffer(result.rows[0]) });
  } catch (err) {
    logger.error("Create offer error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/offers/:id
// Update an existing offer. Only send fields you want to change.
// ==================================================================
async function updateOffer(req, res) {
  const {
    name, description, discountValue,
    productId, categoryId,
    minOrderValue, maxDiscount,
    startDate, endDate, isActive
  } = req.body;

  try {
    const existing = await db.query("SELECT id FROM offers WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Offer not found" });
    }

    const result = await db.query(
      `UPDATE offers SET
         name            = COALESCE($1,  name),
         description     = COALESCE($2,  description),
         discount_value  = COALESCE($3,  discount_value),
         product_id      = COALESCE($4,  product_id),
         category_id     = COALESCE($5,  category_id),
         min_order_value = COALESCE($6,  min_order_value),
         max_discount    = COALESCE($7,  max_discount),
         start_date      = COALESCE($8,  start_date),
         end_date        = COALESCE($9,  end_date),
         is_active       = COALESCE($10, is_active),
         updated_at      = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        name          || null,
        description   !== undefined ? description   : null,
        discountValue !== undefined ? discountValue : null,
        productId     !== undefined ? productId     : null,
        categoryId    !== undefined ? categoryId    : null,
        minOrderValue !== undefined ? minOrderValue : null,
        maxDiscount   !== undefined ? maxDiscount   : null,
        startDate     !== undefined ? startDate     : null,
        endDate       !== undefined ? endDate       : null,
        isActive      !== undefined ? isActive      : null,
        req.params.id
      ]
    );
    return res.json({ success: true, message: "Offer updated", offer: formatOffer(result.rows[0]) });
  } catch (err) {
    logger.error("Update offer error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/offers/:id
// ==================================================================
async function deleteOffer(req, res) {
  try {
    const result = await db.query(
      "DELETE FROM offers WHERE id = $1 RETURNING id", [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Offer not found" });
    }
    return res.json({ success: true, message: "Offer deleted" });
  } catch (err) {
    logger.error("Delete offer error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getActiveOffers, getAllOffers, getOfferById, createOffer, updateOffer, deleteOffer };