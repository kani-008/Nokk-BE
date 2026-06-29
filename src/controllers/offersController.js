const db = require("../config/db.js");

// Live offers table columns:
// id, name, description, discount_value, product_id, category_id,
// min_order_value, max_discount, start_date, end_date, is_active,
// created_at, updated_at, offer_type, applies_to, code

const num = (v) => parseFloat(v) || 0;

function formatOffer(o) {
  const now = new Date();
  const started = !o.start_date || new Date(o.start_date) <= now;
  const notEnded = !o.end_date || new Date(o.end_date) >= now;
  return {
    id: o.id,
    name: o.name,
    description: o.description,
    discountValue: num(o.discount_value),
    productId: o.product_id,
    productName: o.product_name || null,
    categoryId: o.category_id,
    categoryName: o.category_name || null,
    minOrderValue: num(o.min_order_value),
    maxDiscount: o.max_discount ? num(o.max_discount) : null,
    startDate: o.start_date,
    endDate: o.end_date,
    isActive: o.is_active,
    isLive: o.is_active && started && notEnded,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    offerType: o.offer_type,
    appliesTo: o.applies_to,
    code: o.code
  };
}

// ==================================================================
// PUBLIC — GET /api/offers
// All currently live offers with product/category names joined.
// Used by: Public Offers page, product detail discount badge.
// ==================================================================
async function getActiveOffers(req, res) {
  console.log({ route: "GET /api/offers", status: "fetching active offers" });
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
    console.log({ route: "GET /api/offers", status: 200, count: result.rows.length });
    return res.json({ success: true, offers: result.rows.map(formatOffer) });
  } catch (err) {
    console.error({ route: "GET /api/offers", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/offers/all
// All offers including inactive and expired — for admin manage screen.
// ==================================================================
async function getAllOffers(req, res) {
  console.log({ route: "GET /api/offers/all", status: "fetching all offers" });
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
    console.log({ route: "GET /api/offers/all", status: 200, count: result.rows.length });
    return res.json({ success: true, offers: result.rows.map(formatOffer) });
  } catch (err) {
    console.error({ route: "GET /api/offers/all", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/offers/:id
// Single offer detail.
// ==================================================================
async function getOfferById(req, res) {
  const { id } = req.query;
  console.log({ route: "GET /api/offers/get-by-id", offerId: id, status: "fetching offer by id" });
  if (!id) {
    console.log({ route: "GET /api/offers/get-by-id", status: 400, message: "id is required" });
    return res.status(400).json({ success: false, message: "id is required" });
  }
  try {
    const result = await db.query(
      `SELECT o.*, p.name_en AS product_name, c.name_en AS category_name
       FROM offers o
       LEFT JOIN products   p ON p.id = o.product_id
       LEFT JOIN categories c ON c.id = o.category_id
       WHERE o.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "GET /api/offers/get-by-id", offerId: id, status: 404, message: "Offer not found" });
      return res.status(404).json({ success: false, message: "Offer not found" });
    }
    console.log({ route: "GET /api/offers/get-by-id", offerId: id, status: 200 });
    return res.json({ success: true, offer: formatOffer(result.rows[0]) });
  } catch (err) {
    console.error({ route: "GET /api/offers/get-by-id", offerId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/offers
// Create a new offer campaign.
// Body: { name, description?, discountValue, productId?, categoryId?,
//         minOrderValue?, maxDiscount?, startDate?, endDate?, isActive?,
//         offerType?, appliesTo?, code? }
// ==================================================================
async function createOffer(req, res) {
  const {
    name, description, discountValue,
    productId, categoryId,
    minOrderValue, maxDiscount,
    startDate, endDate, isActive,
    offerType, appliesTo, code
  } = req.body;
  console.log({ route: "POST /api/offers", body: { name, discountValue, productId, categoryId, minOrderValue, maxDiscount, startDate, endDate, isActive, offerType, appliesTo, code }, status: "creating offer" });

  if (!name || discountValue == null) {
    console.log({ route: "POST /api/offers", status: 400, message: "name and discountValue are required" });
    return res.status(400).json({ success: false, message: "name and discountValue are required" });
  }

  const type = offerType || "percentage";
  const val = parseFloat(discountValue) || 0;
  if (type === "percentage") {
    if (val <= 0 || val > 100) {
      console.log({ route: "POST /api/offers", status: 400, message: "discountValue must be between 1 and 100" });
      return res.status(400).json({ success: false, message: "discountValue must be between 1 and 100 (percent)" });
    }
  } else if (type === "flat") {
    if (val <= 0 || val > 10000) {
      console.log({ route: "POST /api/offers", status: 400, message: "discountValue must be greater than 0 and less than or equal to ₹10,000" });
      return res.status(400).json({ success: false, message: "discountValue must be greater than 0 and less than or equal to ₹10,000" });
    }
  } else {
    return res.status(400).json({ success: false, message: "Invalid offerType" });
  }

  const applies = appliesTo || "all";
  if (applies === "product") {
    if (!productId) {
      return res.status(400).json({ success: false, message: "Select a product" });
    }
    if (categoryId) {
      return res.status(400).json({ success: false, message: "Category must not be set for product-specific offers" });
    }
  } else if (applies === "category") {
    if (!categoryId) {
      return res.status(400).json({ success: false, message: "Select a category" });
    }
    if (productId) {
      return res.status(400).json({ success: false, message: "Product must not be set for category-specific offers" });
    }
  } else if (applies === "all") {
    if (productId || categoryId) {
      return res.status(400).json({ success: false, message: "Product and category must not be set for store-wide offers" });
    }
  } else {
    return res.status(400).json({ success: false, message: "Invalid appliesTo" });
  }

  let upperCode = null;
  if (code && String(code).trim()) {
    upperCode = String(code).trim().toUpperCase();
    try {
      const dup = await db.query("SELECT id FROM offers WHERE UPPER(code) = $1", [upperCode]);
      if (dup.rows.length > 0) {
        console.log({ route: "POST /api/offers", code: upperCode, status: 409, message: "offer code already exists" });
        return res.status(409).json({ success: false, message: "Offer code already exists" });
      }
    } catch (err) {
      console.error({ route: "POST /api/offers", error: err.message });
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  }

  try {
    const result = await db.query(
      `INSERT INTO offers
         (name, description, discount_value, product_id, category_id,
          min_order_value, max_discount, start_date, end_date, is_active,
          offer_type, applies_to, code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        name.trim(),
        description || null,
        discountValue,
        applies === "product" ? productId : null,
        applies === "category" ? categoryId : null,
        minOrderValue || 0,
        maxDiscount || null,
        startDate || null,
        endDate || null,
        isActive ?? true,
        type,
        applies,
        upperCode
      ]
    );
    console.log({ route: "POST /api/offers", status: 201, offerId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Offer created", offer: formatOffer(result.rows[0]) });
  } catch (err) {
    console.error({ route: "POST /api/offers", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/offers/:id
// Update an existing offer. Only send fields you want to change.
// ==================================================================
async function updateOffer(req, res) {
  const {
    id, name, description, discountValue,
    productId, categoryId,
    minOrderValue, maxDiscount,
    startDate, endDate, isActive,
    offerType, appliesTo, code
  } = req.body;
  console.log({ route: "PUT /api/offers/update-offer", offerId: id, body: { name, description, discountValue, productId, categoryId, minOrderValue, maxDiscount, startDate, endDate, isActive, offerType, appliesTo, code }, status: "updating offer" });

  if (!id) {
    console.log({ route: "PUT /api/offers/update-offer", status: 400, message: "id is required" });
    return res.status(400).json({ success: false, message: "id is required" });
  }

  try {
    const existingRes = await db.query("SELECT * FROM offers WHERE id = $1", [id]);
    if (existingRes.rows.length === 0) {
      console.log({ route: "PUT /api/offers/update-offer", offerId: id, status: 404, message: "Offer not found" });
      return res.status(404).json({ success: false, message: "Offer not found" });
    }
    const existing = existingRes.rows[0];

    const currentType = offerType !== undefined ? offerType : existing.offer_type;
    const currentVal = discountValue !== undefined ? parseFloat(discountValue) : parseFloat(existing.discount_value);

    if (currentType === "percentage") {
      if (currentVal <= 0 || currentVal > 100) {
        return res.status(400).json({ success: false, message: "discountValue must be between 1 and 100 (percent)" });
      }
    } else if (currentType === "flat") {
      if (currentVal <= 0 || currentVal > 10000) {
        return res.status(400).json({ success: false, message: "discountValue must be greater than 0 and less than or equal to ₹10,000" });
      }
    } else {
      return res.status(400).json({ success: false, message: "Invalid offerType" });
    }

    const currentApplies = appliesTo !== undefined ? appliesTo : existing.applies_to;
    let finalProdId = productId !== undefined ? (productId || null) : existing.product_id;
    let finalCatId = categoryId !== undefined ? (categoryId || null) : existing.category_id;

    if (currentApplies === "all") {
      finalProdId = null;
      finalCatId = null;
    } else if (currentApplies === "product") {
      finalCatId = null;
      if (!finalProdId) {
        return res.status(400).json({ success: false, message: "Select a product" });
      }
    } else if (currentApplies === "category") {
      finalProdId = null;
      if (!finalCatId) {
        return res.status(400).json({ success: false, message: "Select a category" });
      }
    } else {
      return res.status(400).json({ success: false, message: "Invalid appliesTo" });
    }

    let upperCode = existing.code;
    if (code !== undefined) {
      if (code && String(code).trim()) {
        upperCode = String(code).trim().toUpperCase();
        const dup = await db.query("SELECT id FROM offers WHERE UPPER(code) = $1 AND id != $2", [upperCode, id]);
        if (dup.rows.length > 0) {
          return res.status(409).json({ success: false, message: "Offer code already exists" });
        }
      } else {
        upperCode = null;
      }
    }

    const finalName = name !== undefined ? name.trim() : existing.name;
    const finalDesc = description !== undefined ? (description || null) : existing.description;
    const finalMinOrder = minOrderValue !== undefined ? minOrderValue : existing.min_order_value;
    const finalMaxDiscount = maxDiscount !== undefined ? (maxDiscount || null) : existing.max_discount;
    const finalStartDate = startDate !== undefined ? (startDate || null) : existing.start_date;
    const finalEndDate = endDate !== undefined ? (endDate || null) : existing.end_date;
    const finalIsActive = isActive !== undefined ? isActive : existing.is_active;

    const result = await db.query(
      `UPDATE offers SET
         name            = $1,
         description     = $2,
         discount_value  = $3,
         product_id      = $4,
         category_id     = $5,
         min_order_value = $6,
         max_discount    = $7,
         start_date      = $8,
         end_date        = $9,
         is_active       = $10,
         offer_type      = $11,
         applies_to      = $12,
         code            = $13,
         updated_at      = NOW()
       WHERE id = $14
       RETURNING *`,
      [
        finalName,
        finalDesc,
        currentVal,
        finalProdId,
        finalCatId,
        finalMinOrder,
        finalMaxDiscount,
        finalStartDate,
        finalEndDate,
        finalIsActive,
        currentType,
        currentApplies,
        upperCode,
        id
      ]
    );

    console.log({ route: "PUT /api/offers/update-offer", offerId: id, status: 200 });
    return res.json({ success: true, message: "Offer updated", offer: formatOffer(result.rows[0]) });
  } catch (err) {
    console.error({ route: "PUT /api/offers/update-offer", offerId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/offers/:id
// ==================================================================
async function deleteOffer(req, res) {
  const { id } = req.body;
  console.log({ route: "DELETE /api/offers/delete-offer", offerId: id, status: "deleting offer" });
  if (!id) {
    return res.status(400).json({ success: false, message: "id is required" });
  }
  try {
    const result = await db.query(
      "DELETE FROM offers WHERE id = $1 RETURNING id", [id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/offers/delete-offer", offerId: id, status: 404, message: "Offer not found" });
      return res.status(404).json({ success: false, message: "Offer not found" });
    }
    console.log({ route: "DELETE /api/offers/delete-offer", offerId: id, status: 200 });
    return res.json({ success: true, message: "Offer deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/offers/delete-offer", offerId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getActiveOffers, getAllOffers, getOfferById, createOffer, updateOffer, deleteOffer };