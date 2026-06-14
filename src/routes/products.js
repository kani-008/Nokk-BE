const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, isAdmin } = require('../middleware/auth');

// Helper to fetch details (variants & images) for a list of products
async function populateProductDetails(productList) {
  if (productList.length === 0) return [];

  const populated = [];
  for (const p of productList) {
    // Fetch variants
    const varRes = await db.query(
      'SELECT id, weight_label, price, compare_price, stock_qty FROM product_variants WHERE product_id = $1 AND is_active = TRUE ORDER BY price ASC',
      [p.id]
    );
    // Fetch all images
    const imgRes = await db.query(
      'SELECT image_url FROM product_images WHERE product_id = $1 ORDER BY sort_order ASC',
      [p.id]
    );

    populated.push({
      id: p.id,
      nameEn: p.name_en,
      nameTa: p.name_ta,
      slug: p.slug,
      category: p.category_slug || p.category_name, // slug filter link
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

// GET /api/products - List products (supports search, category, maxPrice, inStock, sort)
router.get('/', async (req, res) => {
  const { search, category, maxPrice, inStock, sort } = req.query;

  try {
    let queryText = 'SELECT * FROM v_products_with_price WHERE is_active = TRUE';
    const params = [];
    let paramIndex = 1;

    // Filters
    if (search) {
      queryText += ` AND (name_en ILIKE $${paramIndex} OR name_ta ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (category) {
      queryText += ` AND category_slug = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (maxPrice) {
      queryText += ` AND min_price <= $${paramIndex}`;
      params.push(parseFloat(maxPrice));
      paramIndex++;
    }

    if (inStock === 'true') {
      queryText += ' AND total_stock > 0';
    }

    // Sort order
    if (sort === 'price-low-high') {
      queryText += ' ORDER BY min_price ASC';
    } else if (sort === 'price-high-low') {
      queryText += ' ORDER BY min_price DESC';
    } else if (sort === 'newest') {
      queryText += ' ORDER BY is_new DESC, created_at DESC';
    } else {
      queryText += ' ORDER BY avg_rating DESC NULLS LAST, review_count DESC';
    }

    const prodRes = await db.query(queryText, params);
    const populated = await populateProductDetails(prodRes.rows);

    return res.json({ success: true, products: populated });
  } catch (err) {
    console.error('Products fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// GET /api/products/:slug - Retrieve single product details
router.get('/:slug', async (req, res) => {
  try {
    const prodRes = await db.query(
      'SELECT * FROM v_products_with_price WHERE slug = $1 AND is_active = TRUE',
      [req.params.slug]
    );

    if (prodRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const populated = await populateProductDetails(prodRes.rows);
    const product = populated[0];

    // Fetch verified reviews details
    const reviewsRes = await db.query(
      `SELECT pr.*, u.full_name 
       FROM product_reviews pr 
       JOIN users u ON u.id = pr.user_id 
       WHERE pr.product_id = $1 AND pr.is_approved = TRUE 
       ORDER BY pr.created_at DESC`,
      [product.id]
    );

    product.reviews = reviewsRes.rows.map(r => ({
      id: r.id,
      userName: r.full_name,
      rating: r.rating,
      comment: r.comment,
      title: r.title,
      isVerified: r.is_verified,
      date: r.created_at
    }));

    return res.json({ success: true, product });
  } catch (err) {
    console.error('Product details error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// ============================================================
// ADMIN WORKSPACE CONTROLS (Admin Protected)
// ============================================================

// POST /api/products - Create a product catalog entry with variants and images
router.post('/', verifyToken, isAdmin, async (req, res) => {
  const { 
    nameEn, nameTa, slug, category, description, howToUse, 
    storageTips, image, images, variants, isBestseller, isNew, discountPercent 
  } = req.body;

  if (!nameEn || !slug || !variants || variants.length === 0) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  // Sourced category ID from slug/id
  try {
    const catRes = await db.query('SELECT id FROM categories WHERE slug = $1 OR id::text = $1', [category]);
    const categoryId = catRes.rows[0] ? catRes.rows[0].id : null;

    // Transaction
    await db.query('BEGIN');

    // 1. Insert product
    const prodRes = await db.query(
      `INSERT INTO products (name_en, name_ta, slug, description, how_to_use, storage_tips, category_id, is_bestseller, is_new)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [nameEn, nameTa || null, slug, description || null, howToUse || null, storageTips || null, categoryId, isBestseller || false, isNew || false]
    );
    const productId = prodRes.rows[0].id;

    // 2. Insert primary and details images
    const allImages = images && images.length > 0 ? images : [image || '/assets/products/nethili.jpg'];
    for (let i = 0; i < allImages.length; i++) {
      await db.query(
        `INSERT INTO product_images (product_id, image_url, sort_order, is_primary)
         VALUES ($1, $2, $3, $4)`,
        [productId, allImages[i], i, i === 0]
      );
    }

    // 3. Insert weight variants
    for (const v of variants) {
      const g = v.weight === '1kg' ? 1000 : v.weight === '500g' ? 500 : 250;
      await db.query(
        `INSERT INTO product_variants (product_id, weight_grams, weight_label, price, compare_price, stock_qty)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [productId, g, v.weight, v.price, v.mrp || v.price, v.stock || 0]
      );
    }

    await db.query('COMMIT');
    return res.status(201).json({ success: true, message: 'Product added to catalog!' });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Product catalog error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// PUT /api/products/:id - Update product catalog entry
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
  const { 
    nameEn, nameTa, slug, category, description, howToUse, 
    storageTips, image, images, variants, isBestseller, isNew 
  } = req.body;

  try {
    const catRes = await db.query('SELECT id FROM categories WHERE slug = $1 OR id::text = $1', [category]);
    const categoryId = catRes.rows[0] ? catRes.rows[0].id : null;

    await db.query('BEGIN');

    // 1. Update product info
    await db.query(
      `UPDATE products 
       SET name_en = $1, name_ta = $2, slug = $3, description = $4, how_to_use = $5, storage_tips = $6, category_id = $7, is_bestseller = $8, is_new = $9, updated_at = NOW()
       WHERE id = $10`,
      [nameEn, nameTa, slug, description, howToUse, storageTips, categoryId, isBestseller || false, isNew || false, req.params.id]
    );

    // 2. Re-create images (simple clear & insert)
    await db.query('DELETE FROM product_images WHERE product_id = $1', [req.params.id]);
    const allImages = images && images.length > 0 ? images : [image || '/assets/products/nethili.jpg'];
    for (let i = 0; i < allImages.length; i++) {
      await db.query(
        `INSERT INTO product_images (product_id, image_url, sort_order, is_primary)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, allImages[i], i, i === 0]
      );
    }

    // 3. Re-create variants
    await db.query('DELETE FROM product_variants WHERE product_id = $1', [req.params.id]);
    for (const v of variants) {
      const g = v.weight === '1kg' ? 1000 : v.weight === '500g' ? 500 : 250;
      await db.query(
        `INSERT INTO product_variants (product_id, weight_grams, weight_label, price, compare_price, stock_qty)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.params.id, g, v.weight, v.price, v.mrp || v.price, v.stock || 0]
      );
    }

    await db.query('COMMIT');
    return res.json({ success: true, message: 'Product updated successfully!' });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Product update error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// DELETE /api/products/:id - Delete product catalog entry
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const delRes = await db.query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    return res.json({ success: true, message: 'Product removed from catalog.' });
  } catch (err) {
    console.error('Product delete error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
