const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { verifyToken, isAdmin, JWT_SECRET } = require('../middleware/auth');

// POST /api/auth/register - Register a new customer
router.post('/register', async (req, res) => {
  const { email, phone, fullName, password } = req.body;

  if (!email || !fullName || !password) {
    return res.status(400).json({ success: false, message: 'Missing required parameters: email, fullName, password' });
  }

  try {
    // Check if email already registered
    const existsRes = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existsRes.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Insert user (default is 'customer')
    const userRes = await db.query(
      `INSERT INTO users (email, phone, full_name, role, status, password_hash)
       VALUES ($1, $2, $3, 'customer', 'active', $4)
       RETURNING id, email, phone, full_name, role, status`,
      [email, phone || null, fullName, passwordHash]
    );
    const newUser = userRes.rows[0];

    // Create a mock OTP entry (code "1234" for simplicity)
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 10);
    await db.query(
      `INSERT INTO otp_verifications (user_id, email, phone, otp_code, expires_at)
       VALUES ($1, $2, $3, '1234', $4)`,
      [newUser.id, email, phone || null, expiresAt]
    );

    return res.status(201).json({
      success: true,
      message: 'Account created. OTP verification required.',
      user: newUser
    });
  } catch (err) {
    console.error('Register error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/auth/verify-otp - Verify OTP and generate JWT session
router.post('/verify-otp', async (req, res) => {
  const { userId, otpCode } = req.body;

  if (!userId || !otpCode) {
    return res.status(400).json({ success: false, message: 'Missing userId or otpCode' });
  }

  try {
    const otpRes = await db.query(
      `SELECT * FROM otp_verifications 
       WHERE user_id = $1 AND otp_code = $2 AND verified = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [userId, otpCode]
    );

    if (otpRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP code. Use demo code "1234".' });
    }

    const verification = otpRes.rows[0];

    // Mark OTP verified
    await db.query('UPDATE otp_verifications SET verified = TRUE WHERE id = $1', [verification.id]);
    
    // Update user verify status
    await db.query(
      `UPDATE users 
       SET email_verified = CASE WHEN email IS NOT NULL THEN TRUE ELSE email_verified END,
           phone_verified = CASE WHEN phone IS NOT NULL THEN TRUE ELSE phone_verified END
       WHERE id = $1`,
      [userId]
    );

    // Get updated user
    const userRes = await db.query('SELECT id, email, full_name, role, status FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Account verified successfully!',
      token,
      user
    });
  } catch (err) {
    console.error('OTP verify error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/auth/login - User Sign In
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Missing required parameters: email, password' });
  }

  try {
    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const user = userRes.rows[0];

    if (user.status === 'blocked') {
      return res.status(403).json({ success: false, message: 'This account has been blocked. Please contact support.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Generate token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Signed in successfully!',
      token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        name: user.full_name,
        role: user.role,
        status: user.status
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// GET /api/auth/profile - Fetch user profile & addresses (Protected)
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const userRes = await db.query('SELECT id, email, phone, full_name, role, status FROM users WHERE id = $1', [req.user.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = userRes.rows[0];

    // Fetch addresses
    const addrRes = await db.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [req.user.id]);
    
    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        name: user.full_name,
        role: user.role,
        status: user.status,
        addresses: addrRes.rows
      }
    });
  } catch (err) {
    console.error('Profile fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// PUT /api/auth/profile - Edit user info (Protected)
router.put('/profile', verifyToken, async (req, res) => {
  const { name, phone, email } = req.body;

  try {
    await db.query(
      `UPDATE users 
       SET full_name = COALESCE($1, full_name), 
           phone = COALESCE($2, phone),
           email = COALESCE($3, email),
           updated_at = NOW() 
       WHERE id = $4`,
      [name, phone, email, req.user.id]
    );

    return res.json({ success: true, message: 'Profile updated successfully!' });
  } catch (err) {
    console.error('Profile update error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// ============================================================
// ADDRESS BOOK (Protected)
// ============================================================

// GET /api/auth/addresses - Fetch all user addresses
router.get('/addresses', verifyToken, async (req, res) => {
  try {
    const addrRes = await db.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [req.user.id]);
    return res.json({ success: true, addresses: addrRes.rows });
  } catch (err) {
    console.error('Addresses fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// POST /api/auth/addresses - Add address
router.post('/addresses', verifyToken, async (req, res) => {
  const { label, fullName, phone, addressLine1, addressLine2, city, state, pincode, isDefault } = req.body;

  if (!fullName || !phone || !addressLine1 || !city || !pincode) {
    return res.status(400).json({ success: false, message: 'Missing shipping particulars' });
  }

  try {
    // If setting default, unset old default
    if (isDefault) {
      await db.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [req.user.id]);
    }

    const addrRes = await db.query(
      `INSERT INTO addresses (user_id, label, full_name, phone, address_line1, address_line2, city, state, pincode, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.id, label || 'Home', fullName, phone, addressLine1, addressLine2 || null, city, state || 'Tamil Nadu', pincode, isDefault || false]
    );

    return res.status(201).json({ success: true, message: 'Address added to catalog!', address: addrRes.rows[0] });
  } catch (err) {
    console.error('Address add error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// DELETE /api/auth/addresses/:id - Delete Address
router.delete('/addresses/:id', verifyToken, async (req, res) => {
  try {
    const delRes = await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Address not found or unauthorized' });
    }
    return res.json({ success: true, message: 'Address removed successfully!' });
  } catch (err) {
    console.error('Address delete error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// GET /api/auth/admin/users - Fetch all users directory (Admin Protected)
router.get('/admin/users', verifyToken, isAdmin, async (req, res) => {
  try {
    const usersRes = await db.query(
      `SELECT id, email, phone, full_name AS name, role, status, created_at AS "joinedDate"
       FROM users 
       ORDER BY created_at DESC`
    );
    
    const users = [];
    for (const u of usersRes.rows) {
      // Sourced order count
      const countRes = await db.query('SELECT COUNT(id) FROM orders WHERE user_id = $1', [u.id]);
      // Sourced addresses
      const addrRes = await db.query('SELECT * FROM addresses WHERE user_id = $1', [u.id]);
      
      users.push({
        ...u,
        ordersCount: parseInt(countRes.rows[0].count),
        addresses: addrRes.rows
      });
    }

    return res.json({ success: true, users });
  } catch (err) {
    console.error('Fetch users admin error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// PUT /api/auth/admin/users/:id/toggle-status - Block/Unblock user (Admin Protected)
router.put('/admin/users/:id/toggle-status', verifyToken, isAdmin, async (req, res) => {
  try {
    const userRes = await db.query('SELECT status FROM users WHERE id = $1', [req.params.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const currentStatus = userRes.rows[0].status;
    const newStatus = currentStatus === 'active' ? 'blocked' : 'active';

    await db.query('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', [newStatus, req.params.id]);
    
    return res.json({ success: true, message: `User status changed to ${newStatus}` });
  } catch (err) {
    console.error('Toggle user status error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
