const db = require("../config/db.js");

// ------------------------------------------------------------------
// Get or create the user's cart row, return the cart id.
// All cart operations go through this — one upsert, no race condition.
// ------------------------------------------------------------------
async function getOrCreateCart(userId) {
  const res = await db.query(
    `INSERT INTO carts (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [userId]
  );
  return res.rows[0].id;
}

// ------------------------------------------------------------------
// Single JOIN query that returns the full cart with product details.
// Called after every mutation so the frontend always gets fresh state.
// ------------------------------------------------------------------
async function fetchCart(userId) {
  const res = await db.query(
    `SELECT
       ci.id           AS item_id,
       ci.quantity,
       ci.created_at,
       ci.updated_at,
       pv.id           AS variant_id,
       pv.weight_label,
       pv.weight_grams,
       pv.price,
       pv.compare_price,
       pv.stock_qty,
       p.id            AS product_id,
       p.name_en,
       p.name_ta,
       p.slug,
       pi.image_url    AS primary_image
     FROM carts c
     JOIN cart_items ci      ON ci.cart_id    = c.id
     JOIN product_variants pv ON pv.id        = ci.variant_id
     JOIN products p          ON p.id         = pv.product_id
     LEFT JOIN product_images pi
       ON pi.product_id = p.id AND pi.is_primary = TRUE
     WHERE c.user_id = $1
     ORDER BY ci.created_at ASC`,
    [userId]
  );

  const items = res.rows.map(r => ({
    itemId: r.item_id,
    quantity: parseInt(r.quantity),
    variantId: r.variant_id,
    weightLabel: r.weight_label,
    weightGrams: r.weight_grams,
    price: parseFloat(r.price),
    comparePrice: r.compare_price ? parseFloat(r.compare_price) : null,
    stockQty: parseInt(r.stock_qty),
    productId: r.product_id,
    name: r.name_ta ? `${r.name_en} (${r.name_ta})` : r.name_en,
    nameEn: r.name_en,
    nameTa: r.name_ta,
    slug: r.slug,
    primaryImage: r.primary_image
  }));

  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return { items, itemCount: items.length, subtotal: parseFloat(subtotal.toFixed(2)) };
}

// ==================================================================
// GET /api/cart
// Returns the full cart with product details in one JOIN query.
// ==================================================================
async function getCart(req, res) {
  console.log({ route: "GET /api/cart", userId: req.user.id, status: "fetching cart" });
  try {
    const cart = await fetchCart(req.user.id);
    console.log({ route: "GET /api/cart", userId: req.user.id, status: 200 });
    return res.json({ success: true, cart });
  } catch (err) {
    console.error({ route: "GET /api/cart", userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /api/cart
// Add a variant to cart or increase its quantity if it already exists.
// Body: { variantId, quantity? }
// ==================================================================
async function addToCart(req, res) {
  const { variantId, quantity = 1 } = req.body;
  console.log({ route: "POST /api/cart", userId: req.user.id, body: { variantId, quantity }, status: "adding item to cart" });

  if (!variantId) {
    console.log({ route: "POST /api/cart", userId: req.user.id, status: 400, message: "variantId is required" });
    return res.status(400).json({ success: false, message: "variantId is required" });
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    console.log({ route: "POST /api/cart", userId: req.user.id, status: 400, message: "quantity must be a positive integer" });
    return res.status(400).json({ success: false, message: "quantity must be a positive integer" });
  }

  try {
    // Validate variant exists and has enough stock
    const varRes = await db.query(
      `SELECT id, stock_qty FROM product_variants
       WHERE id = $1 AND is_active = TRUE`,
      [variantId]
    );
    if (varRes.rows.length === 0) {
      console.log({ route: "POST /api/cart", userId: req.user.id, status: 404, message: "Variant not found or inactive" });
      return res.status(404).json({ success: false, message: "Variant not found or inactive" });
    }

    const cartId = await getOrCreateCart(req.user.id);

    // Check if item already in cart — get current quantity
    const existing = await db.query(
      `SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND variant_id = $2`,
      [cartId, variantId]
    );

    const newQty = existing.rows.length > 0
      ? existing.rows[0].quantity + quantity
      : quantity;

    if (newQty > varRes.rows[0].stock_qty) {
      console.log({ route: "POST /api/cart", userId: req.user.id, status: 400, message: "insufficient stock" });
      return res.status(400).json({
        success: false,
        message: `Only ${varRes.rows[0].stock_qty} units available in stock`
      });
    }

    // Upsert — insert or increment quantity atomically
    await db.query(
      `INSERT INTO cart_items (cart_id, variant_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, variant_id)
       DO UPDATE SET quantity = cart_items.quantity + $3, updated_at = NOW()`,
      [cartId, variantId, quantity]
    );

    const cart = await fetchCart(req.user.id);
    console.log({ route: "POST /api/cart", userId: req.user.id, status: 201 });
    return res.status(201).json({ success: true, message: "Item added to cart", cart });
  } catch (err) {
    console.error({ route: "POST /api/cart", userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// PUT /api/cart/:itemId
// Set the exact quantity for a cart item.
// Body: { quantity }   — pass 0 to remove.
// ==================================================================
async function updateCartItem(req, res) {
  const { itemId } = req.body;
  const quantity = parseInt(req.body.quantity);
  console.log({ route: "PUT /api/cart/update-item", userId: req.user.id, itemId, quantity, status: "updating cart item quantity" });

  if (isNaN(quantity) || quantity < 0) {
    console.log({ route: "PUT /api/cart/update-item", userId: req.user.id, itemId, status: 400, message: "quantity must be 0 or more" });
    return res.status(400).json({ success: false, message: "quantity must be 0 or more" });
  }

  try {
    // Ownership check — user can only touch their own cart items
    const itemRes = await db.query(
      `SELECT ci.id, ci.variant_id, pv.stock_qty
       FROM cart_items ci
       JOIN carts c             ON c.id  = ci.cart_id
       JOIN product_variants pv ON pv.id = ci.variant_id
       WHERE ci.id = $1 AND c.user_id = $2`,
      [itemId, req.user.id]
    );

    if (itemRes.rows.length === 0) {
      console.log({ route: "PUT /api/cart/update-item", userId: req.user.id, itemId, status: 404, message: "Cart item not found" });
      return res.status(404).json({ success: false, message: "Cart item not found" });
    }

    if (quantity === 0) {
      await db.query("DELETE FROM cart_items WHERE id = $1", [itemId]);
    } else {
      if (quantity > itemRes.rows[0].stock_qty) {
        console.log({ route: "PUT /api/cart/update-item", userId: req.user.id, itemId, status: 400, message: "insufficient stock" });
        return res.status(400).json({
          success: false,
          message: `Only ${itemRes.rows[0].stock_qty} units available in stock`
        });
      }
      await db.query(
        "UPDATE cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2",
        [quantity, itemId]
      );
    }

    const cart = await fetchCart(req.user.id);
    console.log({ route: "PUT /api/cart/update-item", userId: req.user.id, itemId, status: 200 });
    return res.json({ success: true, message: "Cart updated", cart });
  } catch (err) {
    console.error({ route: "PUT /api/cart/update-item", userId: req.user.id, itemId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// DELETE /api/cart/:itemId
// Remove a single item from the cart.
// ==================================================================
async function removeCartItem(req, res) {
  const { itemId } = req.body;
  console.log({ route: "DELETE /api/cart/remove-item", userId: req.user.id, itemId, status: "removing cart item" });
  try {
    const result = await db.query(
      `DELETE FROM cart_items
       WHERE id = $1
         AND cart_id = (SELECT id FROM carts WHERE user_id = $2)
       RETURNING id`,
      [itemId, req.user.id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/cart/remove-item", userId: req.user.id, itemId, status: 404, message: "Cart item not found" });
      return res.status(404).json({ success: false, message: "Cart item not found" });
    }
    const cart = await fetchCart(req.user.id);
    console.log({ route: "DELETE /api/cart/remove-item", userId: req.user.id, itemId, status: 200 });
    return res.json({ success: true, message: "Item removed", cart });
  } catch (err) {
    console.error({ route: "DELETE /api/cart/remove-item", userId: req.user.id, itemId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// DELETE /api/cart
// Clear the entire cart.
// ==================================================================
async function clearCart(req, res) {
  console.log({ route: "DELETE /api/cart", userId: req.user.id, status: "clearing cart" });
  try {
    await db.query(
      `DELETE FROM cart_items
       WHERE cart_id = (SELECT id FROM carts WHERE user_id = $1)`,
      [req.user.id]
    );
    console.log({ route: "DELETE /api/cart", userId: req.user.id, status: 200 });
    return res.json({ success: true, message: "Cart cleared", cart: { items: [], itemCount: 0, subtotal: 0 } });
  } catch (err) {
    console.error({ route: "DELETE /api/cart", userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getCart, addToCart, updateCartItem, removeCartItem, clearCart };