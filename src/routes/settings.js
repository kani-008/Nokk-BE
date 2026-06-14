const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, isAdmin } = require('../middleware/auth');

// GET /api/settings - Fetch global website settings (Public)
router.get('/', async (req, res) => {
  try {
    const settingsRes = await db.query('SELECT key, value FROM settings');
    
    const settings = {};
    settingsRes.rows.forEach(row => {
      let val = row.value;
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (!isNaN(val) && val.trim() !== '') val = Number(val);
      settings[row.key] = val;
    });

    return res.json({ success: true, settings });
  } catch (err) {
    console.error('Settings fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// PUT /api/settings - Update settings (Admin Protected)
router.put('/', verifyToken, isAdmin, async (req, res) => {
  try {
    await db.query('BEGIN');

    for (const [key, value] of Object.entries(req.body)) {
      await db.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) 
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, String(value)]
      );
    }

    await db.query('COMMIT');
    return res.json({ success: true, message: 'Settings updated successfully!' });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Settings update error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
