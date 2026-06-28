const db = require("../config/db.js");

// Inventory = product_variants table — all stock management lives here.
// product_variants columns: id, product_id, weight_grams, weight_label,
//                           price, compare_price, stock_qty, is_active,
//                           created_at, updated_at

const num = (v) => parseFloat(v) || 0;
const isTrue = (val) => val === true || val === "true" || val === 1 || val === "1" || val === "yes";

// ==================================================================
// ADMIN — GET /api/inventory
// Full inventory list — every variant with product name and category.
// Supports filter by low stock, out of stock, category, search.
// Query: ?lowStock=true  ?outOfStock=true  ?inStock=true  ?category=slug
//        ?search=text  ?page=1  ?limit=50
// ==================================================================
async function getInventory(req, res) {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;
  const lowStock = false; // Low stock concept is removed system-wide
  const outOfStock = req.query.outOfStock === "true";
  const inStock = req.query.inStock === "true";
  const catSlug = req.query.category || null;
  const search = req.query.search || null;
  console.log({ route: "GET /api/inventory", query: { page, limit, outOfStock, inStock, catSlug, search }, status: "fetching inventory" });

  try {
    const result = await db.query(
      `SELECT
         pv.id              AS variant_id,
         pv.weight_label,
         pv.weight_grams,
         pv.price,
         pv.compare_price,
         pv.stock_qty,
         pv.is_active,
         pv.updated_at      AS stock_updated_at,
         p.id               AS product_id,
         p.name_en,
         p.name_ta,
         p.slug,
         p.is_active        AS product_active,
         c.name_en          AS category_name,
         c.slug             AS category_slug,
         pi.image_url       AS primary_image
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = TRUE
       WHERE
         p.is_active = TRUE AND
         pv.is_active = TRUE AND
         (NOT $1 OR pv.stock_qty > 0 AND pv.stock_qty <= 10) AND
         (NOT $2 OR pv.stock_qty = 0) AND
         ($3::text IS NULL OR c.slug = $3) AND
         ($4::text IS NULL OR
           p.name_en ILIKE '%' || $4 || '%' OR
           p.name_ta ILIKE '%' || $4 || '%'
         ) AND
         (NOT $7::boolean OR pv.stock_qty > 0)
       ORDER BY pv.stock_qty ASC, p.name_en ASC
       LIMIT $5 OFFSET $6`,
      [lowStock, outOfStock, catSlug, search, limit, offset, inStock]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE
         p.is_active = TRUE AND
         pv.is_active = TRUE AND
         (NOT $1 OR pv.stock_qty > 0 AND pv.stock_qty <= 10) AND
         (NOT $2 OR pv.stock_qty = 0) AND
         ($3::text IS NULL OR c.slug = $3) AND
         ($4::text IS NULL OR p.name_en ILIKE '%' || $4 || '%' OR p.name_ta ILIKE '%' || $4 || '%') AND
         (NOT $5::boolean OR pv.stock_qty > 0)`,
      [lowStock, outOfStock, catSlug, search, inStock]
    );

    console.log({ route: "GET /api/inventory", status: 200, count: result.rows.length });
    return res.json({
      success: true,
      pagination: {
        page, limit,
        total: parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      inventory: result.rows.map(r => ({
        variantId: r.variant_id,
        weightLabel: r.weight_label,
        weightGrams: r.weight_grams,
        price: num(r.price),
        comparePrice: r.compare_price ? num(r.compare_price) : null,
        stockQty: parseInt(r.stock_qty),
        isActive: r.is_active,
        stockStatus: parseInt(r.stock_qty) === 0 ? "out_of_stock" : "in_stock",
        stockUpdatedAt: r.stock_updated_at,
        productId: r.product_id,
        name: r.name_ta ? `${r.name_en} (${r.name_ta})` : r.name_en,
        nameEn: r.name_en,
        nameTa: r.name_ta,
        slug: r.slug,
        productActive: r.product_active,
        categoryName: r.category_name,
        categorySlug: r.category_slug,
        primaryImage: r.primary_image
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/inventory", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/inventory/summary
// Stock summary counts for the admin inventory dashboard card.
// ==================================================================
async function getInventorySummary(req, res) {
  console.log({ route: "GET /api/inventory/summary", status: "fetching inventory summary" });
  try {
    const result = await db.query(
      `SELECT
         COUNT(*)                                           AS total_variants,
         COUNT(*) FILTER (WHERE pv.stock_qty  = 0)         AS out_of_stock,
         0                                                 AS low_stock,
         COUNT(*) FILTER (WHERE pv.stock_qty  > 0)         AS in_stock,
         COUNT(*) FILTER (WHERE pv.stock_qty  > 0)         AS total_units
       FROM product_variants pv
       WHERE pv.is_active = TRUE`
    );
    console.log({ route: "GET /api/inventory/summary", status: 200 });
    return res.json({ success: true, summary: result.rows[0] });
  } catch (err) {
    console.error({ route: "GET /api/inventory/summary", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/inventory/:variantId
// Update stock quantity and/or price for a single variant.
// Body: { stockQty?, price?, comparePrice?, isActive? }
// This is the main "update stock" action from the inventory page.
// ==================================================================
async function updateStock(req, res) {
  const { variantId, stockQty, inStock, price, comparePrice, isActive } = req.body;
  console.log({ route: "PUT /api/inventory/update-stock", variantId, body: { stockQty, inStock, price, comparePrice, isActive }, status: "updating variant stock" });

  if (stockQty === undefined && inStock === undefined && price === undefined &&
    comparePrice === undefined && isActive === undefined) {
    console.log({ route: "PUT /api/inventory/update-stock", variantId, status: 400, message: "Nothing to update" });
    return res.status(400).json({ success: false, message: "Nothing to update" });
  }

  const stockVal = inStock !== undefined ? (isTrue(inStock) ? 1 : 0) : (stockQty !== undefined ? (parseInt(stockQty) > 0 ? 1 : 0) : undefined);

  try {
    const result = await db.query(
      `UPDATE product_variants SET
         stock_qty     = COALESCE($1, stock_qty),
         price         = COALESCE($2, price),
         compare_price = COALESCE($3, compare_price),
         is_active     = COALESCE($4, is_active),
         updated_at    = NOW()
       WHERE id = $5
       RETURNING id, product_id, weight_label, stock_qty, price, compare_price, is_active, updated_at`,
      [
        stockVal !== undefined ? stockVal : null,
        price !== undefined ? num(price) : null,
        comparePrice !== undefined ? num(comparePrice) : null,
        isActive !== undefined ? isActive : null,
        variantId
      ]
    );
    if (result.rows.length === 0) {
      console.log({ route: "PUT /api/inventory/update-stock", variantId, status: 404, message: "Variant not found" });
      return res.status(404).json({ success: false, message: "Variant not found" });
    }
    const v = result.rows[0];
    console.log({ route: "PUT /api/inventory/update-stock", variantId, status: 200 });
    return res.json({
      success: true,
      message: "Stock updated",
      variant: {
        variantId: v.id,
        productId: v.product_id,
        weightLabel: v.weight_label,
        stockQty: parseInt(v.stock_qty),
        inStock: parseInt(v.stock_qty) > 0,
        price: num(v.price),
        comparePrice: v.compare_price ? num(v.compare_price) : null,
        isActive: v.is_active,
        updatedAt: v.updated_at
      }
    });
  } catch (err) {
    console.error({ route: "PUT /api/inventory/update-stock", variantId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/inventory/bulk-update
// Update stock for multiple variants at once — for bulk import/edit.
// Body: { updates: [{ variantId, stockQty, price?, comparePrice? }] }
// ==================================================================
async function bulkUpdateStock(req, res) {
  const { updates } = req.body;
  console.log({ route: "POST /api/inventory/bulk-update", updateCount: updates?.length, status: "bulk updating stock" });

  if (!Array.isArray(updates) || updates.length === 0) {
    console.log({ route: "POST /api/inventory/bulk-update", status: 400, message: "updates array is required" });
    return res.status(400).json({ success: false, message: "updates array is required" });
  }
  if (updates.length > 100) {
    console.log({ route: "POST /api/inventory/bulk-update", status: 400, message: "Maximum 100 variants per bulk update" });
    return res.status(400).json({ success: false, message: "Maximum 100 variants per bulk update" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const results = [];
    for (const item of updates) {
      if (!item.variantId) continue;
      const stockVal = item.inStock !== undefined ? (isTrue(item.inStock) ? 1 : 0) : (item.stockQty !== undefined ? (parseInt(item.stockQty) > 0 ? 1 : 0) : null);
      const r = await client.query(
        `UPDATE product_variants SET
           stock_qty     = COALESCE($1, stock_qty),
           price         = COALESCE($2, price),
           compare_price = COALESCE($3, compare_price),
           updated_at    = NOW()
         WHERE id = $4
         RETURNING id, weight_label, stock_qty, price`,
        [
          stockVal,
          item.price !== undefined ? num(item.price) : null,
          item.comparePrice !== undefined ? num(item.comparePrice) : null,
          item.variantId
        ]
      );
      if (r.rows.length > 0) results.push(r.rows[0]);
    }

    await client.query("COMMIT");
    console.log({ route: "POST /api/inventory/bulk-update", status: 200, updatedCount: results.length });
    return res.json({
      success: true,
      message: `${results.length} variant(s) updated`,
      updated: results
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error({ route: "POST /api/inventory/bulk-update", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

module.exports = { getInventory, getInventorySummary, updateStock, bulkUpdateStock };