const db = require("../config/db.js");

// ------------------------------------------------------------------
// Get or create the user's cart row, return the cart id.
// All cart operations go through this — one upsert, no race condition.
// ------------------------------------------------------------------
const isValidUuid = (id) => {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
};
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
       ci.combo_id,
       co.name         AS combo_name,
       co.image_url    AS combo_image,
       co.combo_price,
       combo_it.quantity AS combo_base_qty,
       pv.id           AS variant_id,
       pv.weight_label,
       pv.weight_grams,
       pv.price,
       pv.compare_price,
       (pv.stock_qty > 0) AS in_stock,
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
     LEFT JOIN combos co ON co.id = ci.combo_id
     LEFT JOIN combo_items combo_it ON combo_it.combo_id = ci.combo_id AND combo_it.variant_id = ci.variant_id
     WHERE c.user_id = $1
     ORDER BY ci.created_at ASC`,
    [userId]
  );

  // Informational only — authoritative combo pricing is re-resolved fresh
  // at checkout (see _createOrderCore), so this naive sum-of-variant-prices
  // subtotal intentionally does not net out combo savings. The frontend
  // groups items sharing a comboId and displays combo_price as the line
  // total instead of this per-row price.
  const items = res.rows.map(r => ({
    itemId: r.item_id,
    quantity: parseInt(r.quantity),
    variantId: r.variant_id,
    weightLabel: r.weight_label,
    weightGrams: r.weight_grams,
    price: parseFloat(r.price),
    comparePrice: r.compare_price ? parseFloat(r.compare_price) : null,
    inStock: r.in_stock,
    productId: r.product_id,
    name: r.name_ta ? `${r.name_en} (${r.name_ta})` : r.name_en,
    nameEn: r.name_en,
    nameTa: r.name_ta,
    slug: r.slug,
    primaryImage: r.primary_image,
    comboId: r.combo_id || null,
    comboName: r.combo_name || null,
    comboImage: r.combo_image || null,
    comboPrice: r.combo_price != null ? parseFloat(r.combo_price) : null,
    // Base per-combo quantity for this specific member variant (from
    // combo_items) — lets the frontend derive "how many of this combo"
    // as quantity / comboBaseQty for the group's shared quantity control.
    comboBaseQty: r.combo_base_qty != null ? parseInt(r.combo_base_qty) : null,
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
  const { variantId, quantity = 1, comboId } = req.body;

  if (comboId) return addComboToCart(req, res);

  console.log({ route: "POST /api/cart", userId: req.user.id, body: { variantId, quantity }, status: "adding item to cart" });

  if (!isValidUuid(variantId)) {
    console.log({ route: "POST /api/cart", userId: req.user.id, status: 400, message: "Valid variantId is required" });
    return res.status(400).json({ success: false, message: "Valid variantId is required" });
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    console.log({ route: "POST /api/cart", userId: req.user.id, status: 400, message: "quantity must be a positive integer" });
    return res.status(400).json({ success: false, message: "quantity must be a positive integer" });
  }

  try {
    // 1. Validate variant + check stock before touching the cart
    const varRes = await db.query(
      `SELECT id, stock_qty FROM product_variants WHERE id = $1 AND is_active = TRUE`,
      [variantId]
    );
    if (varRes.rows.length === 0) {
      console.log({ route: "POST /api/cart", userId: req.user.id, variantId, status: 404, message: "Variant not found or inactive" });
      return res.status(404).json({ success: false, message: "Variant not found or inactive" });
    }
    if (varRes.rows[0].stock_qty <= 0) {
      console.log({ route: "POST /api/cart", userId: req.user.id, status: 400, message: "item out of stock" });
      return res.status(400).json({ success: false, message: "Item is out of stock" });
    }

    const cartId = await getOrCreateCart(req.user.id);

    // 2. Enforce maxCartItems — count distinct variants already in cart
    const countRes = await db.query(
      "SELECT COUNT(*) AS item_count FROM cart_items WHERE cart_id = $1",
      [cartId]
    );
    const currentCount = parseInt(countRes.rows[0].item_count) || 0;

    // Check if this variant is already in the cart (incrementing qty is fine, adding new line is gated)
    const existsRes = await db.query(
      "SELECT id FROM cart_items WHERE cart_id = $1 AND variant_id = $2",
      [cartId, variantId]
    );
    const isNewItem = existsRes.rows.length === 0;

    if (isNewItem) {
      const maxRes = await db.query("SELECT value FROM settings WHERE key = 'maxCartItems'");
      const maxCartItems = maxRes.rows.length > 0 ? parseInt(maxRes.rows[0].value) : 20;
      if (maxCartItems > 0 && currentCount >= maxCartItems) {
        console.log({ route: "POST /api/cart", userId: req.user.id, status: 400, message: `Cart limit reached (${maxCartItems} items)` });
        return res.status(400).json({
          success: false,
          message: `You can only add up to ${maxCartItems} different items to your cart at once`,
        });
      }
    }

    // 3. Upsert — insert or increment quantity atomically
    await db.query(
      `INSERT INTO cart_items (cart_id, variant_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, variant_id)
       DO UPDATE SET quantity = cart_items.quantity + $3, updated_at = NOW()`,
      [cartId, variantId, quantity]
    );

    console.log(`[Cart Backend Log] Item added with item code: ${variantId} (User: ${req.user.id})`);

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

  if (!isValidUuid(itemId)) {
    console.log({ route: "PUT /api/cart/update-item", userId: req.user.id, status: 400, message: "Valid itemId is required" });
    return res.status(400).json({ success: false, message: "Valid itemId is required" });
  }

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
      const variantId = itemRes.rows[0]?.variant_id;
      await db.query("DELETE FROM cart_items WHERE id = $1", [itemId]);
      console.log(`[Cart Backend Log] Item is deleted with item code: ${variantId} (User: ${req.user.id})`);
    } else {
      const { stock_qty } = itemRes.rows[0];
      if (stock_qty <= 0) {
        console.log({ route: "PUT /api/cart/update-item", userId: req.user.id, itemId, status: 400, message: "item out of stock" });
        return res.status(400).json({ success: false, message: "Item is out of stock" });
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

  if (!isValidUuid(itemId)) {
    console.log({ route: "DELETE /api/cart/remove-item", userId: req.user.id, status: 400, message: "Valid itemId is required" });
    return res.status(400).json({ success: false, message: "Valid itemId is required" });
  }

  try {
    const result = await db.query(
      `DELETE FROM cart_items
       WHERE id = $1
         AND cart_id = (SELECT id FROM carts WHERE user_id = $2)
       RETURNING id, variant_id`,
      [itemId, req.user.id]
    );
    if (result.rows.length === 0) {
      const cart = await fetchCart(req.user.id);
      console.log({ route: "DELETE /api/cart/remove-item", userId: req.user.id, itemId, status: 200, message: "Cart item already removed" });
      return res.json({ success: true, message: "Item already removed", cart });
    }
    const deletedVariantId = result.rows[0]?.variant_id;
    console.log(`[Cart Backend Log] Item is deleted with item code: ${deletedVariantId} (User: ${req.user.id})`);

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
    const result = await db.query(
      `DELETE FROM cart_items
       WHERE cart_id = (SELECT id FROM carts WHERE user_id = $1)
       RETURNING variant_id`,
      [req.user.id]
    );
    for (const row of result.rows) {
      console.log(`[Cart Backend Log] Item is deleted with item code: ${row.variant_id} (User: ${req.user.id})`);
    }
    console.log({ route: "DELETE /api/cart", userId: req.user.id, status: 200 });
    return res.json({ success: true, message: "Cart cleared", cart: { items: [], itemCount: 0, subtotal: 0 } });
  } catch (err) {
    console.error({ route: "DELETE /api/cart", userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /api/cart   (comboId branch — called from addToCart)
// Body: { comboId, quantity? }
// Adds one cart_items row per combo member (variant_id = member's variant,
// quantity = member.quantity * requested combo qty), all stamped with the
// same combo_id, in one transaction — so they can never drift apart.
// ==================================================================
async function addComboToCart(req, res) {
  const { comboId, quantity = 1 } = req.body;
  console.log({ route: "POST /api/cart (combo)", userId: req.user.id, body: { comboId, quantity }, status: "adding combo to cart" });

  if (!isValidUuid(comboId)) {
    console.log({ route: "POST /api/cart (combo)", userId: req.user.id, status: 400, message: "Valid comboId is required" });
    return res.status(400).json({ success: false, message: "Valid comboId is required" });
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    console.log({ route: "POST /api/cart (combo)", userId: req.user.id, status: 400, message: "quantity must be a positive integer" });
    return res.status(400).json({ success: false, message: "quantity must be a positive integer" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const comboRes = await client.query(`SELECT id, is_active FROM combos WHERE id = $1`, [comboId]);
    if (comboRes.rows.length === 0 || !comboRes.rows[0].is_active) {
      const e = new Error("Combo not found or unavailable"); e.status = 404; throw e;
    }

    const memberRes = await client.query(
      `SELECT ci.variant_id, ci.quantity, pv.stock_qty
       FROM combo_items ci
       JOIN product_variants pv ON pv.id = ci.variant_id
       WHERE ci.combo_id = $1`,
      [comboId]
    );
    if (memberRes.rows.length === 0) {
      const e = new Error("Combo has no items"); e.status = 400; throw e;
    }
    for (const item of memberRes.rows) {
      if (item.stock_qty <= 0) {
        const e = new Error("One or more items in this combo are out of stock"); e.status = 400; throw e;
      }
    }

    const cartRes = await client.query(
      `INSERT INTO carts (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [req.user.id]
    );
    const cartId = cartRes.rows[0].id;

    // cart_items has a UNIQUE(cart_id, variant_id) constraint — a variant
    // already in the cart individually, or as part of a DIFFERENT combo,
    // can't silently be folded into this combo without corrupting whichever
    // group it currently belongs to. Reject and ask the customer to remove
    // the conflicting line first, rather than merging state incorrectly.
    const variantIds = memberRes.rows.map((r) => r.variant_id);
    const conflictRes = await client.query(
      `SELECT variant_id, combo_id FROM cart_items WHERE cart_id = $1 AND variant_id = ANY($2)`,
      [cartId, variantIds]
    );
    const conflicting = conflictRes.rows.filter((r) => r.combo_id !== comboId);
    if (conflicting.length > 0) {
      const e = new Error("One or more items in this combo are already in your cart individually or as part of another combo. Remove them first.");
      e.status = 409; throw e;
    }

    for (const item of memberRes.rows) {
      const rowQty = item.quantity * quantity;
      await client.query(
        `INSERT INTO cart_items (cart_id, variant_id, quantity, combo_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cart_id, variant_id)
         DO UPDATE SET quantity = cart_items.quantity + $3, combo_id = $4, updated_at = NOW()`,
        [cartId, item.variant_id, rowQty, comboId]
      );
    }

    await client.query("COMMIT");

    console.log(`[Cart Backend Log] Combo added with combo id: ${comboId} (User: ${req.user.id})`);

    const cart = await fetchCart(req.user.id);
    console.log({ route: "POST /api/cart (combo)", userId: req.user.id, status: 201 });
    return res.status(201).json({ success: true, message: "Combo added to cart", cart });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "POST /api/cart (combo)", userId: req.user.id, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "POST /api/cart (combo)", userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// PUT /api/cart/update-combo-qty
// Body: { comboId, quantity }   — quantity is the combo-level count
// (e.g. "2 of this combo"), not a per-member-row quantity. Updates every
// cart_items row sharing that combo_id together in one transaction, so
// they can never drift out of sync with each other. quantity 0 removes
// the whole combo.
// ==================================================================
async function updateComboQty(req, res) {
  const { comboId } = req.body;
  const multiplier = parseInt(req.body.quantity);
  console.log({ route: "PUT /api/cart/update-combo-qty", userId: req.user.id, comboId, quantity: multiplier, status: "updating combo quantity" });

  if (!isValidUuid(comboId)) {
    console.log({ route: "PUT /api/cart/update-combo-qty", userId: req.user.id, status: 400, message: "Valid comboId is required" });
    return res.status(400).json({ success: false, message: "Valid comboId is required" });
  }
  if (isNaN(multiplier) || multiplier < 0) {
    console.log({ route: "PUT /api/cart/update-combo-qty", userId: req.user.id, status: 400, message: "quantity must be 0 or more" });
    return res.status(400).json({ success: false, message: "quantity must be 0 or more" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const memberRowsRes = await client.query(
      `SELECT ci.id, ci.variant_id
       FROM cart_items ci
       JOIN carts c ON c.id = ci.cart_id
       WHERE ci.combo_id = $1 AND c.user_id = $2`,
      [comboId, req.user.id]
    );
    if (memberRowsRes.rows.length === 0) {
      const e = new Error("Combo not found in cart"); e.status = 404; throw e;
    }

    if (multiplier === 0) {
      await client.query(
        `DELETE FROM cart_items WHERE combo_id = $1 AND cart_id = (SELECT id FROM carts WHERE user_id = $2)`,
        [comboId, req.user.id]
      );
    } else {
      const perComboQtyRes = await client.query(
        `SELECT variant_id, quantity FROM combo_items WHERE combo_id = $1`,
        [comboId]
      );
      const perComboQtyMap = {};
      perComboQtyRes.rows.forEach((r) => { perComboQtyMap[r.variant_id] = r.quantity; });

      for (const row of memberRowsRes.rows) {
        const perComboQty = perComboQtyMap[row.variant_id] || 1;
        await client.query(
          `UPDATE cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2`,
          [perComboQty * multiplier, row.id]
        );
      }
    }

    await client.query("COMMIT");

    const cart = await fetchCart(req.user.id);
    console.log({ route: "PUT /api/cart/update-combo-qty", userId: req.user.id, comboId, status: 200 });
    return res.json({ success: true, message: "Cart updated", cart });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "PUT /api/cart/update-combo-qty", userId: req.user.id, comboId, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "PUT /api/cart/update-combo-qty", userId: req.user.id, comboId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// DELETE /api/cart/remove-combo
// Body: { comboId }
// Deletes every cart_items row sharing that combo_id in one statement —
// a customer must never be able to remove only one item out of a combo
// while leaving the rest priced individually.
// ==================================================================
async function removeCombo(req, res) {
  const { comboId } = req.body;
  console.log({ route: "DELETE /api/cart/remove-combo", userId: req.user.id, comboId, status: "removing combo from cart" });

  if (!isValidUuid(comboId)) {
    console.log({ route: "DELETE /api/cart/remove-combo", userId: req.user.id, status: 400, message: "Valid comboId is required" });
    return res.status(400).json({ success: false, message: "Valid comboId is required" });
  }

  try {
    await db.query(
      `DELETE FROM cart_items
       WHERE combo_id = $1
         AND cart_id = (SELECT id FROM carts WHERE user_id = $2)`,
      [comboId, req.user.id]
    );
    console.log(`[Cart Backend Log] Combo removed with combo id: ${comboId} (User: ${req.user.id})`);

    const cart = await fetchCart(req.user.id);
    console.log({ route: "DELETE /api/cart/remove-combo", userId: req.user.id, comboId, status: 200 });
    return res.json({ success: true, message: "Combo removed", cart });
  } catch (err) {
    console.error({ route: "DELETE /api/cart/remove-combo", userId: req.user.id, comboId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getCart, addToCart, updateCartItem, removeCartItem, clearCart,
  updateComboQty, removeCombo,
};