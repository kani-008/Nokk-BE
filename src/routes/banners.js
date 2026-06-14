const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, isAdmin } = require('../middleware/auth');

// GET /api/banners - Fetch active banners (Public)
router.get('/', async (req, res) => {
  try {
    const bannerRes = await db.query(
      'SELECT id, title, subtitle, image_url AS image, link_url AS link, sort_order AS "sortOrder", is_active AS active FROM banners WHERE is_active = TRUE ORDER BY sort_order ASC, created_at DESC'
    );
    return res.json({ success: true, banners: bannerRes.rows });
  } catch (err) {
    console.error('Banners fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// GET /api/banners/admin/list - Fetch all banners (Admin Protected)
router.get('/admin/list', verifyToken, isAdmin, async (req, res) => {
  try {
    const bannerRes = await db.query(
      'SELECT id, title, subtitle, image_url AS image, link_url AS link, sort_order AS "sortOrder", is_active AS active FROM banners ORDER BY sort_order ASC, created_at DESC'
    );
    return res.json({ success: true, banners: bannerRes.rows });
  } catch (err) {
    console.error('Banners fetch admin error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/banners - Add banner (Admin Protected)
router.post('/', verifyToken, isAdmin, async (req, res) => {
  const { title, subtitle, image, link, sortOrder } = req.body;

  if (!title || !image) {
    return res.status(400).json({ success: false, message: 'Title and image URL are required' });
  }

  try {
    const bannerRes = await db.query(
      `INSERT INTO banners (title, subtitle, image_url, link_url, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, subtitle, image_url AS image, link_url AS link, sort_order AS "sortOrder", is_active AS active`,
      [title, subtitle || null, image, link || null, sortOrder || 0]
    );

    return res.status(201).json({ success: true, banner: bannerRes.rows[0] });
  } catch (err) {
    console.error('Banner create error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// PUT /api/banners/:id - Edit banner (Admin Protected)
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
  const { title, subtitle, image, link, sortOrder, active } = req.body;

  try {
    const updateRes = await db.query(
      `UPDATE banners
       SET title = COALESCE($1, title),
           subtitle = COALESCE($2, subtitle),
           image_url = COALESCE($3, image_url),
           link_url = COALESCE($4, link_url),
           sort_order = COALESCE($5, sort_order),
           is_active = COALESCE($6, is_active),
           updated_at = NOW()
       WHERE id = $7
       RETURNING id`,
      [title, subtitle, image, link, sortOrder, active, req.params.id]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Banner not found' });
    }

    return res.json({ success: true, message: 'Banner updated successfully!' });
  } catch (err) {
    console.error('Banner update error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// DELETE /api/banners/:id - Delete banner (Admin Protected)
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const delRes = await db.query('DELETE FROM banners WHERE id = $1 RETURNING id', [req.params.id]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Banner not found' });
    }
    return res.json({ success: true, message: 'Banner deleted successfully' });
  } catch (err) {
    console.error('Banner delete error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
