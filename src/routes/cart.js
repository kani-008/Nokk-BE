const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');

// Helper to get or create a cart for a user
async function getOrCreateCart(userId) {
  let cartRes = await db.query('SELECT id FROM carts WHERE user_id = $1', [userId]);
  
  if (cartRes.rows.length === 0) {
    cartRes = await db.query(
      'INSERT INTO carts (user_id) VALUES ($1) RETURNING id',
      [userId]
    );
  }
  return cartRes.rows[0].id;
}

// GET /api/cart - Fetch all items in user's cart (Protected)
router.get('/', verifyToken, async (req, res) => {
  try {
    const cartId = await getOrCreateCart(req.user.id);
    
    const itemsRes = await db.query(
      `SELECT ci.id, ci.variant_id AS "variantId", ci.quantity, 
              pv.weight_label AS weight, pv.price, pv.compare_price AS mrp, 
              p.id AS "productId", p.name_en AS "nameEn", p.name_ta AS "nameTa", p.slug, 
              pi.image_url AS image
       FROM cart_items ci
       JOIN product_variants pv ON pv.id = ci.variant_id
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = TRUE
       WHERE ci.cart_id = $1
       ORDER BY ci.created_at DESC`,
      [cartId]
    );

    // Format output matching client Zustand store structure
    const cartItems = itemsRes.rows.map(item => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      nameEn: item.nameEn,
      nameTa: item.nameTa,
      weight: item.weight,
      price: parseFloat(item.price),
      quantity: parseInt(item.quantity),
      image: item.image || '/placeholder.jpg',
      slug: item.slug
    }));

    return res.json({ success: true, items: cartItems });
  } catch (err) {
    console.error('Cart fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/cart/items - Add item or update quantity if exists (Protected)
router.post('/items', verifyToken, async (req, res) => {
  const { productId, weight, quantity } = req.body;

  if (!productId || !weight) {
    return res.status(400).json({ success: false, message: 'Missing product ID or variant weight' });
  }

  try {
    // 1. Fetch variant ID matching product ID and weight
    const varRes = await db.query(
      'SELECT id FROM product_variants WHERE product_id = $1 AND weight_label = $2 AND is_active = TRUE',
      [productId, weight]
    );

    if (varRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Matching variant not found' });
    }
    const variantId = varRes.rows[0].id;

    // 2. Fetch/create user cart
    const cartId = await getOrCreateCart(req.user.id);

    // 3. Upsert cart item quantity
    await db.query(
      `INSERT INTO cart_items (cart_id, variant_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, variant_id) 
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [cartId, variantId, quantity || 1]
    );

    return res.json({ success: true, message: 'Cart items updated successfully!' });
  } catch (err) {
    console.error('Cart add error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// PUT /api/cart/items/:id - Update cart item quantity (Protected)
router.put('/items/:id', verifyToken, async (req, res) => {
  const { quantity } = req.body;

  if (!quantity || quantity < 1) {
    return res.status(400).json({ success: false, message: 'Invalid quantity' });
  }

  try {
    const cartId = await getOrCreateCart(req.user.id);

    const updateRes = await db.query(
      'UPDATE cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2 AND cart_id = $3 RETURNING id',
      [quantity, req.params.id, cartId]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Cart item not found or unauthorized' });
    }

    return res.json({ success: true, message: 'Quantity modified!' });
  } catch (err) {
    console.error('Cart item update error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// DELETE /api/cart/items/:id - Remove item from cart (Protected)
router.delete('/items/:id', verifyToken, async (req, res) => {
  try {
    const cartId = await getOrCreateCart(req.user.id);

    const delRes = await db.query(
      'DELETE FROM cart_items WHERE id = $1 AND cart_id = $2 RETURNING id',
      [req.params.id, cartId]
    );

    if (delRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Cart item not found or unauthorized' });
    }

    return res.json({ success: true, message: 'Item removed from cart.' });
  } catch (err) {
    console.error('Cart item delete error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// DELETE /api/cart - Clear whole cart (Protected)
router.delete('/', verifyToken, async (req, res) => {
  try {
    const cartId = await getOrCreateCart(req.user.id);
    await db.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
    return res.json({ success: true, message: 'Cart cleared successfully!' });
  } catch (err) {
    console.error('Cart clear error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
