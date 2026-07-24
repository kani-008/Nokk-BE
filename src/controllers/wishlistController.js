const db     = require("../config/db.js");
const { formatProduct, formatVariant, formatImage } = require("./productController.js");

// ------------------------------------------------------------------
// Single query — joins wishlists (for ordering) against
// v_products_with_price (the same view /products/get-all uses), so the
// response is fully-hydrated with offer pricing, ratings, categoryName,
// etc. in one round trip instead of the old fetch-IDs-then-fetch-products
// two-step. variants/images are then batch-fetched the same way
// getAllProducts does it, and run through the shared formatProduct so
// this endpoint's items are shaped identically to /products/get-all.
// wishlists PK is (user_id, product_id) — no separate id column.
// ------------------------------------------------------------------
const isValidUuid = (id) => {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
};
async function fetchWishlist(userId) {
  const res = await db.query(
    `SELECT v.*, w.created_at AS wishlist_added_at
     FROM wishlists w
     JOIN v_products_with_price v ON v.id = w.product_id
     WHERE w.user_id = $1
     ORDER BY w.created_at DESC`,
    [userId]
  );

  const rows = res.rows;
  let variantsByProduct = {};
  let imagesByProduct   = {};
  if (rows.length > 0) {
    const productIds = rows.map(r => r.id);
    const [varRes, imgRes] = await Promise.all([
      db.query(
        `SELECT * FROM product_variants WHERE product_id = ANY($1) AND is_active = TRUE ORDER BY weight_grams ASC`,
        [productIds]
      ),
      db.query(
        `SELECT * FROM product_images WHERE product_id = ANY($1) ORDER BY sort_order ASC`,
        [productIds]
      )
    ]);

    varRes.rows.forEach(v => {
      const pid = v.product_id;
      if (!variantsByProduct[pid]) variantsByProduct[pid] = [];
      variantsByProduct[pid].push(formatVariant(v));
    });

    imgRes.rows.forEach(i => {
      const pid = i.product_id;
      if (!imagesByProduct[pid]) imagesByProduct[pid] = [];
      imagesByProduct[pid].push(formatImage(i));
    });
  }

  // rows are already ordered by wishlist created_at DESC — map() preserves that order
  const items = rows.map(p =>
    formatProduct(p, variantsByProduct[p.id] || [], imagesByProduct[p.id] || [])
  );

  const itemIds = items.map(item => item.id);
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