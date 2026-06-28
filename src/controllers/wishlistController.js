const db     = require("../config/db.js");

// ------------------------------------------------------------------
// Single JOIN query — returns all wishlist items with product details.
// wishlists PK is (user_id, product_id) — no separate id column.
// ------------------------------------------------------------------
const isValidUuid = (id) => {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
};
async function fetchWishlist(userId) {
  const res = await db.query(
    `SELECT
       w.product_id,
       w.created_at,
       p.name_en,
       p.name_ta,
       p.slug,
       p.is_bestseller,
       p.is_new,
       pi.image_url          AS primary_image,
       COALESCE(MIN(pv.price), 0)         AS min_price,
       COALESCE(MIN(pv.compare_price), 0) AS min_compare_price,
       COALESCE(BOOL_OR(pv.stock_qty > 0), FALSE) AS in_stock
     FROM wishlists w
     JOIN products p ON p.id = w.product_id
     LEFT JOIN product_images pi
       ON pi.product_id = p.id AND pi.is_primary = TRUE
     LEFT JOIN product_variants pv
       ON pv.product_id = p.id AND pv.is_active = TRUE
     WHERE w.user_id = $1
     GROUP BY w.product_id, w.created_at, p.name_en, p.name_ta,
              p.slug, p.is_bestseller, p.is_new, pi.image_url
     ORDER BY w.created_at DESC`,
    [userId]
  );

  const items = res.rows.map(r => ({
    productId:       r.product_id,
    name:            r.name_ta ? `${r.name_en} (${r.name_ta})` : r.name_en,
    nameEn:          r.name_en,
    nameTa:          r.name_ta,
    slug:            r.slug,
    primaryImage:    r.primary_image,
    minPrice:        parseFloat(r.min_price),
    minComparePrice: parseFloat(r.min_compare_price),
    inStock:         r.in_stock,
    isBestseller:    r.is_bestseller,
    isNew:           r.is_new,
    addedAt:         r.created_at
  }));

  const itemIds = items.map(item => item.productId);
  console.log(`[Wishlist Backend Log] Wishlist fetched with item codes: [${itemIds.join(", ")}] (User: ${userId})`);

  return items;
}

// ==================================================================
// GET /api/wishlist
// ==================================================================
async function getWishlist(req, res) {
  console.log({ route: "GET /api/wishlist", userId: req.user?.id, status: "fetching wishlist" });
  try {
    const items = await fetchWishlist(req.user.id);
    console.log({ route: "GET /api/wishlist", userId: req.user?.id, status: 200, count: items.length });
    return res.json({ success: true, wishlist: items, count: items.length });
  } catch (err) {
    console.error({ route: "GET /api/wishlist", userId: req.user?.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /api/wishlist
// Add a product. Silently succeeds if already in wishlist (idempotent).
// Body: { productId }
// ==================================================================
async function addToWishlist(req, res) {
  const { productId } = req.body;
  console.log({ route: "POST /api/wishlist", userId: req.user?.id, productId, status: "adding to wishlist" });

  if (!isValidUuid(productId)) {
    console.log({ route: "POST /api/wishlist", userId: req.user?.id, status: 400, message: "Valid productId is required" });
    return res.status(400).json({ success: false, message: "Valid productId is required" });
  }

  try {
    // Confirm product exists and is active
    const prod = await db.query(
      "SELECT id FROM products WHERE id = $1 AND is_active = TRUE", [productId]
    );
    if (prod.rows.length === 0) {
      console.log({ route: "POST /api/wishlist", userId: req.user?.id, productId, status: 404, message: "Product not found" });
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    // INSERT … ON CONFLICT DO NOTHING — idempotent, no error on duplicate
    await db.query(
      `INSERT INTO wishlists (user_id, product_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, product_id) DO NOTHING`,
      [req.user.id, productId]
    );

    const items = await fetchWishlist(req.user.id);
    console.log({ route: "POST /api/wishlist", userId: req.user?.id, productId, status: 201 });
    return res.status(201).json({ success: true, message: "Added to wishlist", wishlist: items, count: items.length });
  } catch (err) {
    console.error({ route: "POST /api/wishlist", userId: req.user?.id, productId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// DELETE /api/wishlist/:productId
// Remove a product from wishlist.
// ==================================================================
async function removeFromWishlist(req, res) {
  const { productId } = req.body;
  console.log({ route: "DELETE /api/wishlist/remove-item", userId: req.user?.id, productId, status: "removing from wishlist" });

  if (!isValidUuid(productId)) {
    console.log({ route: "DELETE /api/wishlist/remove-item", userId: req.user?.id, status: 400, message: "Valid productId is required" });
    return res.status(400).json({ success: false, message: "Valid productId is required" });
  }

  try {
    const result = await db.query(
      "DELETE FROM wishlists WHERE user_id = $1 AND product_id = $2 RETURNING product_id",
      [req.user.id, productId]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/wishlist/remove-item", userId: req.user?.id, productId, status: 404, message: "Product not in wishlist" });
      return res.status(404).json({ success: false, message: "Product not in wishlist" });
    }
    const items = await fetchWishlist(req.user.id);
    console.log({ route: "DELETE /api/wishlist/remove-item", userId: req.user?.id, productId, status: 200 });
    return res.json({ success: true, message: "Removed from wishlist", wishlist: items, count: items.length });
  } catch (err) {
    console.error({ route: "DELETE /api/wishlist/remove-item", userId: req.user?.id, productId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// DELETE /api/wishlist
// Clear the entire wishlist.
// ==================================================================
async function clearWishlist(req, res) {
  console.log({ route: "DELETE /api/wishlist", userId: req.user?.id, status: "clearing wishlist" });
  try {
    await db.query("DELETE FROM wishlists WHERE user_id = $1", [req.user.id]);
    console.log({ route: "DELETE /api/wishlist", userId: req.user?.id, status: 200 });
    return res.json({ success: true, message: "Wishlist cleared", wishlist: [], count: 0 });
  } catch (err) {
    console.error({ route: "DELETE /api/wishlist", userId: req.user?.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /api/wishlist/merge
// Merge local guest wishlist items into user account on login.
// Body: { productIds: [...] }
// ==================================================================
async function mergeWishlist(req, res) {
  const { productIds } = req.body;
  console.log({ route: "POST /api/wishlist/merge", userId: req.user?.id, productIds, status: "merging wishlist" });

  if (!Array.isArray(productIds)) {
    console.log({ route: "POST /api/wishlist/merge", userId: req.user?.id, status: 400, message: "productIds must be an array" });
    return res.status(400).json({ success: false, message: "productIds must be an array" });
  }

  const cleanProductIds = productIds.filter(isValidUuid);

  if (cleanProductIds.length === 0) {
    try {
      const items = await fetchWishlist(req.user.id);
      return res.json({ success: true, wishlist: items, count: items.length });
    } catch (err) {
      console.error({ route: "POST /api/wishlist/merge", userId: req.user?.id, status: 500, error: err.message });
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  }

  try {
    // Insert all valid products that are active and ignore conflicts
    await db.query(
      `INSERT INTO wishlists (user_id, product_id)
       SELECT $1, p.id
       FROM products p
       WHERE p.id = ANY($2) AND p.is_active = TRUE
       ON CONFLICT (user_id, product_id) DO NOTHING`,
      [req.user.id, cleanProductIds]
    );

    const items = await fetchWishlist(req.user.id);
    console.log({ route: "POST /api/wishlist/merge", userId: req.user?.id, status: 200, count: items.length });
    return res.json({ success: true, message: "Wishlist merged", wishlist: items, count: items.length });
  } catch (err) {
    console.error({ route: "POST /api/wishlist/merge", userId: req.user?.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getWishlist, addToWishlist, removeFromWishlist, clearWishlist, mergeWishlist };