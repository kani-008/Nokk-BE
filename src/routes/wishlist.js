const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');

// Helper to fetch details (variants & images) for a list of products
// (Matches the helper in products.js to keep structures consistent)
async function populateProductDetails(productList) {
  if (productList.length === 0) return [];

  const populated = [];
  for (const p of productList) {
    const varRes = await db.query(
      'SELECT id, weight_label, price, compare_price, stock_qty FROM product_variants WHERE product_id = $1 AND is_active = TRUE ORDER BY price ASC',
      [p.id]
    );
    const imgRes = await db.query(
      'SELECT image_url FROM product_images WHERE product_id = $1 ORDER BY sort_order ASC',
      [p.id]
    );

    populated.push({
      id: p.id,
      nameEn: p.name_en,
      nameTa: p.name_ta,
      slug: p.slug,
      category: p.category_slug || p.category_name,
      description: p.description,
      howToUse: p.how_to_use || '',
      storageTips: p.storage_tips || '',
      rating: parseFloat(p.avg_rating) || 0,
      reviewsCount: parseInt(p.review_count) || 0,
      image: p.primary_image || (imgRes.rows[0] ? imgRes.rows[0].image_url : '/placeholder.jpg'),
      images: imgRes.rows.map(i => i.image_url),
      isBestseller: p.is_bestseller || false,
      isNew: p.is_new || false,
      discountPercent: p.min_compare_price > p.min_price 
        ? Math.round(((p.min_compare_price - p.min_price) / p.min_compare_price) * 100)
        : 0,
      inStock: p.total_stock > 0,
      variants: varRes.rows.map(v => ({
        weight: v.weight_label,
        price: parseFloat(v.price),
        mrp: parseFloat(v.compare_price) || parseFloat(v.price),
        stock: parseInt(v.stock_qty)
      }))
    });
  }
  return populated;
}

// GET /api/wishlist - Fetch user's wishlist (Protected)
router.get('/', verifyToken, async (req, res) => {
  try {
    const wishlistRes = await db.query(
      `SELECT w.product_id, v.* 
       FROM wishlists w
       JOIN v_products_with_price v ON v.id = w.product_id
       WHERE w.user_id = $1 AND v.is_active = TRUE
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );

    const populated = await populateProductDetails(wishlistRes.rows);
    const productIds = wishlistRes.rows.map(r => r.product_id);

    return res.json({
      success: true,
      items: populated,
      productIds
    });
  } catch (err) {
    console.error('Wishlist fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/wishlist/toggle - Toggle product in wishlist (Protected)
router.post('/toggle', verifyToken, async (req, res) => {
  const { productId } = req.body;

  if (!productId) {
    return res.status(400).json({ success: false, message: 'Missing product ID' });
  }

  try {
    // Check if product exists in database
    const prodCheck = await db.query('SELECT id FROM products WHERE id = $1', [productId]);
    if (prodCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Check if already in wishlist
    const wishCheck = await db.query(
      'SELECT 1 FROM wishlists WHERE user_id = $1 AND product_id = $2',
      [req.user.id, productId]
    );

    if (wishCheck.rows.length > 0) {
      // Remove it
      await db.query('DELETE FROM wishlists WHERE user_id = $1 AND product_id = $2', [req.user.id, productId]);
      return res.json({ success: true, message: 'Removed from wishlist', isAdded: false });
    } else {
      // Add it
      await db.query(
        'INSERT INTO wishlists (user_id, product_id) VALUES ($1, $2)',
        [req.user.id, productId]
      );
      return res.json({ success: true, message: 'Added to wishlist', isAdded: true });
    }
  } catch (err) {
    console.error('Wishlist toggle error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/wishlist - Add item to wishlist (Protected)
router.post('/', verifyToken, async (req, res) => {
  const { productId } = req.body;

  if (!productId) {
    return res.status(400).json({ success: false, message: 'Missing product ID' });
  }

  try {
    await db.query(
      `INSERT INTO wishlists (user_id, product_id) 
       VALUES ($1, $2)
       ON CONFLICT (user_id, product_id) DO NOTHING`,
      [req.user.id, productId]
    );
    return res.json({ success: true, message: 'Added to wishlist' });
  } catch (err) {
    console.error('Wishlist add error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// DELETE /api/wishlist/:productId - Delete item from wishlist (Protected)
router.delete('/:productId', verifyToken, async (req, res) => {
  const { productId } = req.params;

  try {
    const delRes = await db.query(
      'DELETE FROM wishlists WHERE user_id = $1 AND product_id = $2 RETURNING product_id',
      [req.user.id, productId]
    );

    if (delRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Item not in wishlist' });
    }

    return res.json({ success: true, message: 'Removed from wishlist' });
  } catch (err) {
    console.error('Wishlist delete error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
