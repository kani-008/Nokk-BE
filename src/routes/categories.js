const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, isAdmin } = require('../middleware/auth');

// GET /api/categories - Fetch all active categories
router.get('/', async (req, res) => {
  try {
    const catRes = await db.query(
      'SELECT id, name_en, name_ta, slug, description, image_url, sort_order FROM categories WHERE is_active = TRUE ORDER BY sort_order ASC, created_at DESC'
    );
    return res.json({ success: true, categories: catRes.rows });
  } catch (err) {
    console.error('Categories fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/categories - Create category (Admin Protected)
router.post('/', verifyToken, isAdmin, async (req, res) => {
  const { nameEn, nameTa, slug, description, imageUrl, sortOrder } = req.body;

  if (!nameEn || !slug) {
    return res.status(400).json({ success: false, message: 'Missing nameEn or slug' });
  }

  try {
    const existRes = await db.query('SELECT id FROM categories WHERE slug = $1', [slug]);
    if (existRes.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Category slug already exists' });
    }

    const newCat = await db.query(
      `INSERT INTO categories (name_en, name_ta, slug, description, image_url, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [nameEn, nameTa || null, slug, description || null, imageUrl || null, sortOrder || 0]
    );

    return res.status(201).json({ success: true, category: newCat.rows[0] });
  } catch (err) {
    console.error('Category create error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// PUT /api/categories/:id - Update Category (Admin Protected)
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
  const { nameEn, nameTa, slug, description, imageUrl, sortOrder, isActive } = req.body;

  try {
    await db.query(
      `UPDATE categories 
       SET name_en = COALESCE($1, name_en),
           name_ta = COALESCE($2, name_ta),
           slug = COALESCE($3, slug),
           description = COALESCE($4, description),
           image_url = COALESCE($5, image_url),
           sort_order = COALESCE($6, sort_order),
           is_active = COALESCE($7, is_active),
           updated_at = NOW()
       WHERE id = $8`,
      [nameEn, nameTa, slug, description, imageUrl, sortOrder, isActive, req.params.id]
    );

    return res.json({ success: true, message: 'Category modified successfully!' });
  } catch (err) {
    console.error('Category update error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// DELETE /api/categories/:id - Delete Category (Admin Protected)
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const delRes = await db.query('DELETE FROM categories WHERE id = $1 RETURNING id', [req.params.id]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }
    return res.json({ success: true, message: 'Category deleted successfully!' });
  } catch (err) {
    console.error('Category delete error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
