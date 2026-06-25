const bcrypt = require("bcryptjs");
const db     = require("../config/db.js");

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const num = (v) => parseFloat(v) || 0;

// Every column from the users table except password_hash
function publicUser(u) {
  return {
    id:            u.id,
    fullName:      u.full_name,
    email:         u.email,
    phone:         u.phone,
    avatarUrl:     u.avatar_url,
    role:          u.role,
    status:        u.status,
    emailVerified: u.email_verified,
    phoneVerified: u.phone_verified,
    authProvider:  u.auth_provider,
    createdAt:     u.created_at,
    updatedAt:     u.updated_at
  };
}

// ==================================================================
// ADMIN — GET /api/users
// List all users with order count + total spent.
// Query params: ?role=customer|admin  ?status=active|blocked
//               ?search=text  ?page=1  ?limit=20
// ==================================================================
async function getAllUsers(req, res) {
  const page   = Math.max(parseInt(req.query.page)  || 1, 1);
  const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;
  const role   = req.query.role   || null;
  const status = req.query.status || null;
  const search = req.query.search ? `%${req.query.search}%` : null;

  console.log({ route: "GET /api/users", adminId: req.user?.id, role, status, search: req.query.search, page, limit, status: "fetching all users" });

  try {
    const result = await db.query(`
      SELECT
        u.id, u.full_name, u.email, u.phone, u.avatar_url,
        u.role, u.status, u.email_verified, u.phone_verified,
        u.auth_provider, u.created_at, u.updated_at,
        COUNT(DISTINCT o.id)   AS order_count,
        COALESCE(SUM(o.total), 0) AS total_spent
      FROM users u
      LEFT JOIN orders o ON o.user_id = u.id AND o.status != 'cancelled' AND o.payment_method != 'replacement'
      WHERE
        ($1::text IS NULL OR u.role::text   = $1) AND
        ($2::text IS NULL OR u.status::text = $2) AND
        ($3::text IS NULL OR
          u.full_name ILIKE $3 OR
          u.email     ILIKE $3 OR
          u.phone     ILIKE $3
        )
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT $4 OFFSET $5
    `, [role, status, search, limit, offset]);

    const countRes = await db.query(`
      SELECT COUNT(*) AS total FROM users
      WHERE
        ($1::text IS NULL OR role::text   = $1) AND
        ($2::text IS NULL OR status::text = $2) AND
        ($3::text IS NULL OR full_name ILIKE $3 OR email ILIKE $3 OR phone ILIKE $3)
    `, [role, status, search]);

    console.log({ route: "GET /api/users", adminId: req.user?.id, status: 200, count: result.rows.length });
    return res.json({
      success: true,
      pagination: {
        page,
        limit,
        total:      parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      users: result.rows.map(u => ({
        ...publicUser(u),
        orderCount: parseInt(u.order_count),
        totalSpent: num(u.total_spent)
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/users", adminId: req.user?.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/users/:id
// Full user profile + addresses + order history + return requests.
// ==================================================================
async function getUserById(req, res) {
  const { id } = req.query;
  console.log({ route: "GET /api/users/get-by-id", adminId: req.user?.id, targetUserId: id, status: "fetching user by id" });

  try {
    const userRes = await db.query(
      `SELECT id, full_name, email, phone, avatar_url, role, status,
              email_verified, phone_verified, auth_provider, created_at, updated_at
       FROM users WHERE id = $1`,
      [id]
    );
    if (userRes.rows.length === 0) {
      console.log({ route: "GET /api/users/get-by-id", adminId: req.user?.id, targetUserId: id, status: 404, message: "User not found" });
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Addresses — every column
    const addrRes = await db.query(
      `SELECT id, label, full_name, phone, address_line1, address_line2,
              city, state, pincode, is_default, created_at, updated_at
       FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
      [id]
    );

    // Order summary (lightweight — no items)
    const ordersRes = await db.query(
      `SELECT id, customer_name, total, status, payment_status,
              payment_method, created_at
       FROM orders WHERE user_id = $1 ORDER BY created_at DESC`,
      [id]
    );

    // Replacement requests
    const replacementsRes = await db.query(
      `SELECT id, order_id, reason, details, status, admin_notes, new_order_id, created_at
       FROM replacement_requests WHERE user_id = $1 ORDER BY created_at DESC`,
      [id]
    );

    // Stats
    const statsRes = await db.query(
      `SELECT
         COUNT(*)                                          AS total_orders,
         COALESCE(SUM(total), 0)                          AS total_spent,
         COUNT(*) FILTER (WHERE status = 'delivered')     AS delivered,
         COUNT(*) FILTER (WHERE status = 'cancelled')     AS cancelled
       FROM orders WHERE user_id = $1`,
      [id]
    );

    const s = statsRes.rows[0];

    console.log({ route: "GET /api/users/get-by-id", adminId: req.user?.id, targetUserId: id, status: 200 });
    return res.json({
      success: true,
      user: publicUser(userRes.rows[0]),
      addresses: addrRes.rows,
      stats: {
        totalOrders: parseInt(s.total_orders),
        totalSpent:  num(s.total_spent),
        delivered:   parseInt(s.delivered),
        cancelled:   parseInt(s.cancelled)
      },
      orders:              ordersRes.rows,
      replacementRequests: replacementsRes.rows
    });
  } catch (err) {
    console.error({ route: "GET /api/users/get-by-id", adminId: req.user?.id, targetUserId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/users/:id
// Admin updates any user field (role, status, name, phone, email,
// avatar_url, email_verified, phone_verified).
// password_hash is intentionally excluded — use reset-password flow.
// ==================================================================
async function adminUpdateUser(req, res) {
  const {
    id, fullName, email, phone, avatarUrl,
    role, status, emailVerified, phoneVerified
  } = req.body;

  console.log({ route: "PUT /api/users/update-user", adminId: req.user?.id, targetUserId: id, body: { fullName, email, phone, avatarUrl, role, status, emailVerified, phoneVerified }, status: "updating user as admin" });

  try {
    const existing = await db.query("SELECT id FROM users WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      console.log({ route: "PUT /api/users/update-user", adminId: req.user?.id, targetUserId: id, status: 404, message: "User not found" });
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Check email/phone uniqueness (if changed) — parameterized
    if (email) {
      const dup = await db.query(
        "SELECT id FROM users WHERE email = $1 AND id != $2", [email.trim().toLowerCase(), id]
      );
      if (dup.rows.length > 0) {
        console.log({ route: "PUT /api/users/update-user", adminId: req.user?.id, targetUserId: id, status: 409, message: "Email already in use" });
        return res.status(409).json({ success: false, message: "Email already in use by another account" });
      }
    }
    if (phone) {
      const dup = await db.query(
        "SELECT id FROM users WHERE phone = $1 AND id != $2", [phone.trim(), id]
      );
      if (dup.rows.length > 0) {
        console.log({ route: "PUT /api/users/update-user", adminId: req.user?.id, targetUserId: id, status: 409, message: "Phone already in use" });
        return res.status(409).json({ success: false, message: "Phone already in use by another account" });
      }
    }

    const result = await db.query(
      `UPDATE users SET
        full_name      = COALESCE($1, full_name),
        email          = COALESCE($2, email),
        phone          = COALESCE($3, phone),
        avatar_url     = COALESCE($4, avatar_url),
        role           = COALESCE($5, role),
        status         = COALESCE($6, status),
        email_verified = COALESCE($7, email_verified),
        phone_verified = COALESCE($8, phone_verified),
        updated_at     = NOW()
       WHERE id = $9
       RETURNING id, full_name, email, phone, avatar_url, role, status,
                 email_verified, phone_verified, auth_provider, created_at, updated_at`,
      [
        fullName   || null,
        email      ? email.trim().toLowerCase() : null,
        phone      ? phone.trim() : null,
        avatarUrl  || null,
        role       || null,
        status     || null,
        emailVerified != null ? emailVerified : null,
        phoneVerified != null ? phoneVerified : null,
        id
      ]
    );

    console.log({ route: "PUT /api/users/update-user", adminId: req.user?.id, targetUserId: id, status: 200 });
    return res.json({ success: true, message: "User updated", user: publicUser(result.rows[0]) });
  } catch (err) {
    console.error({ route: "PUT /api/users/update-user", adminId: req.user?.id, targetUserId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PATCH /api/users/:id/status
// Block or unblock a user. Cannot block another admin.
// ==================================================================
async function toggleUserStatus(req, res) {
  const { id, status } = req.body; // 'active' | 'blocked'

  console.log({ route: "PATCH /api/users/toggle-status", adminId: req.user?.id, targetUserId: id, targetStatus: status, status: "toggling user status" });

  if (!["active", "blocked"].includes(status)) {
    console.log({ route: "PATCH /api/users/toggle-status", adminId: req.user?.id, targetUserId: id, targetStatus: status, status: 400, message: "invalid status" });
    return res.status(400).json({ success: false, message: "status must be 'active' or 'blocked'" });
  }

  try {
    const existing = await db.query(
      "SELECT id, role FROM users WHERE id = $1", [id]
    );
    if (existing.rows.length === 0) {
      console.log({ route: "PATCH /api/users/toggle-status", adminId: req.user?.id, targetUserId: id, targetStatus: status, status: 404, message: "User not found" });
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (existing.rows[0].role === "admin") {
      console.log({ route: "PATCH /api/users/toggle-status", adminId: req.user?.id, targetUserId: id, targetStatus: status, status: 403, message: "Cannot toggle status of admin" });
      return res.status(403).json({ success: false, message: "Cannot change status of an admin account" });
    }

    await db.query(
      "UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2",
      [status, id]
    );

    console.log({ route: "PATCH /api/users/toggle-status", adminId: req.user?.id, targetUserId: id, targetStatus: status, status: 200 });
    return res.json({
      success: true,
      message: `User ${status === "blocked" ? "blocked" : "unblocked"} successfully`
    });
  } catch (err) {
    console.error({ route: "PATCH /api/users/toggle-status", adminId: req.user?.id, targetUserId: id, targetStatus: status, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/users/:id
// Permanently delete a user. Blocked if they have active/processing orders.
// ==================================================================
async function deleteUser(req, res) {
  const { id } = req.body;

  console.log({ route: "DELETE /api/users/delete-user", adminId: req.user?.id, targetUserId: id, status: "deleting user" });

  // Prevent self-delete
  if (req.user.id === id) {
    console.log({ route: "DELETE /api/users/delete-user", adminId: req.user?.id, targetUserId: id, status: 400, message: "Cannot self-delete" });
    return res.status(400).json({ success: false, message: "You cannot delete your own account" });
  }

  try {
    const existing = await db.query("SELECT id, role FROM users WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      console.log({ route: "DELETE /api/users/delete-user", adminId: req.user?.id, targetUserId: id, status: 404, message: "User not found" });
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (existing.rows[0].role === "admin") {
      console.log({ route: "DELETE /api/users/delete-user", adminId: req.user?.id, targetUserId: id, status: 403, message: "Cannot delete admin account" });
      return res.status(403).json({ success: false, message: "Cannot delete an admin account" });
    }

    // Block delete if they have live orders
    const activeOrders = await db.query(
      `SELECT COUNT(*) AS c FROM orders
       WHERE user_id = $1 AND status IN ('pending','confirmed','processing','shipped','out_for_delivery')`,
      [id]
    );
    if (parseInt(activeOrders.rows[0].c) > 0) {
      console.log({ route: "DELETE /api/users/delete-user", adminId: req.user?.id, targetUserId: id, status: 409, message: "User has active orders" });
      return res.status(409).json({
        success: false,
        message: "Cannot delete user — they have active orders in progress"
      });
    }

    await db.query("DELETE FROM users WHERE id = $1", [id]);
    console.log({ route: "DELETE /api/users/delete-user", adminId: req.user?.id, targetUserId: id, status: 200 });
    return res.json({ success: true, message: "User deleted permanently" });
  } catch (err) {
    console.error({ route: "DELETE /api/users/delete-user", adminId: req.user?.id, targetUserId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// SELF — GET /api/users/me
// Logged-in user reads their own full profile + addresses.
// ==================================================================
async function getMyProfile(req, res) {
  console.log({ route: "GET /api/users/me", userId: req.user?.id, status: "fetching own profile" });
  try {
    const userRes = await db.query(
      `SELECT id, full_name, email, phone, avatar_url, role, status,
              email_verified, phone_verified, auth_provider, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (userRes.rows.length === 0) {
      console.log({ route: "GET /api/users/me", userId: req.user?.id, status: 404, message: "User not found" });
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const addrRes = await db.query(
      `SELECT id, label, full_name, phone, address_line1, address_line2,
              city, state, pincode, is_default, created_at, updated_at
       FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
      [req.user.id]
    );

    console.log({ route: "GET /api/users/me", userId: req.user?.id, status: 200 });
    return res.json({
      success: true,
      user:      publicUser(userRes.rows[0]),
      addresses: addrRes.rows
    });
  } catch (err) {
    console.error({ route: "GET /api/users/me", userId: req.user?.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// SELF — PUT /api/users/me
// User updates their own name, phone, avatar.
// Email cannot be changed here (sensitive — needs re-verification).
// ==================================================================
async function updateMyProfile(req, res) {
  const { fullName, phone, avatarUrl } = req.body;
  console.log({ route: "PUT /api/users/me", userId: req.user?.id, fullName, phone, avatarUrl, status: "updating own profile" });

  if (!fullName && !phone && !avatarUrl) {
    console.log({ route: "PUT /api/users/me", userId: req.user?.id, status: 400, message: "Nothing to update" });
    return res.status(400).json({ success: false, message: "Nothing to update" });
  }

  try {
    if (phone) {
      const dup = await db.query(
        "SELECT id FROM users WHERE phone = $1 AND id != $2",
        [phone.trim(), req.user.id]
      );
      if (dup.rows.length > 0) {
        console.log({ route: "PUT /api/users/me", userId: req.user?.id, status: 409, message: "Phone already in use" });
        return res.status(409).json({ success: false, message: "Phone already in use by another account" });
      }
    }

    const result = await db.query(
      `UPDATE users SET
        full_name  = COALESCE($1, full_name),
        phone      = COALESCE($2, phone),
        avatar_url = COALESCE($3, avatar_url),
        updated_at = NOW()
       WHERE id = $4
       RETURNING id, full_name, email, phone, avatar_url, role, status,
                 email_verified, phone_verified, auth_provider, created_at, updated_at`,
      [
        fullName  || null,
        phone     ? phone.trim() : null,
        avatarUrl || null,
        req.user.id
      ]
    );

    console.log({ route: "PUT /api/users/me", userId: req.user?.id, status: 200 });
    return res.json({ success: true, message: "Profile updated", user: publicUser(result.rows[0]) });
  } catch (err) {
    console.error({ route: "PUT /api/users/me", userId: req.user?.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// SELF — PUT /api/users/me/password
// Change password (must know current password).
// ==================================================================
async function changeMyPassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  console.log({ route: "PUT /api/users/me/password", userId: req.user?.id, status: "changing password" });

  if (!currentPassword || !newPassword) {
    console.log({ route: "PUT /api/users/me/password", userId: req.user?.id, status: 400, message: "currentPassword and newPassword are required" });
    return res.status(400).json({ success: false, message: "currentPassword and newPassword are required" });
  }
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    console.log({ route: "PUT /api/users/me/password", userId: req.user?.id, status: 400, message: "New password too short" });
    return res.status(400).json({ success: false, message: "New password must be at least 6 characters" });
  }

  try {
    const userRes = await db.query(
      "SELECT password_hash FROM users WHERE id = $1", [req.user.id]
    );

    const ok = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash || "");
    if (!ok) {
      console.log({ route: "PUT /api/users/me/password", userId: req.user?.id, status: 401, message: "Incorrect current password" });
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await db.query(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
      [hash, req.user.id]
    );

    // Revoke all refresh tokens so other sessions are logged out
    await db.query("DELETE FROM refresh_tokens WHERE user_id = $1", [req.user.id]);

    console.log({ route: "PUT /api/users/me/password", userId: req.user?.id, status: 200 });
    return res.json({ success: true, message: "Password changed. Please log in again." });
  } catch (err) {
    console.error({ route: "PUT /api/users/me/password", userId: req.user?.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADDRESSES — GET /api/users/me/addresses
// ==================================================================
async function getMyAddresses(req, res) {
  console.log({ route: "GET /api/users/me/addresses", userId: req.user?.id, status: "fetching addresses" });
  try {
    const result = await db.query(
      `SELECT id, label, full_name, phone, address_line1, address_line2,
              city, state, pincode, is_default, created_at, updated_at
       FROM addresses WHERE user_id = $1
       ORDER BY is_default DESC, created_at DESC`,
      [req.user.id]
    );
    console.log({ route: "GET /api/users/me/addresses", userId: req.user?.id, status: 200, count: result.rows.length });
    return res.json({ success: true, addresses: result.rows });
  } catch (err) {
    console.error({ route: "GET /api/users/me/addresses", userId: req.user?.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADDRESSES — POST /api/users/me/addresses
// ==================================================================
async function addAddress(req, res) {
  const { label, fullName, phone, addressLine1, addressLine2, city, state, pincode, isDefault } = req.body;
  console.log({ route: "POST /api/users/me/addresses", userId: req.user?.id, label, fullName, phone, addressLine1, city, state, pincode, isDefault, status: "adding address" });

  if (!fullName || !phone || !addressLine1 || !city || !pincode) {
    console.log({ route: "POST /api/users/me/addresses", userId: req.user?.id, status: 400, message: "Missing required address fields" });
    return res.status(400).json({ success: false, message: "fullName, phone, addressLine1, city and pincode are required" });
  }
  if (String(fullName).trim().length > 100)    return res.status(400).json({ success: false, message: "Name too long" });
  if (String(phone).trim().length > 15)         return res.status(400).json({ success: false, message: "Invalid phone number" });
  if (String(addressLine1).trim().length > 200) return res.status(400).json({ success: false, message: "Address line 1 too long" });
  if (addressLine2 && String(addressLine2).trim().length > 200) return res.status(400).json({ success: false, message: "Address line 2 too long" });
  if (String(city).trim().length > 100)         return res.status(400).json({ success: false, message: "City name too long" });
  if (state && String(state).trim().length > 100) return res.status(400).json({ success: false, message: "State name too long" });
  if (!/^\d{6}$/.test(String(pincode).trim()))  return res.status(400).json({ success: false, message: "Pincode must be 6 digits" });

  try {
    // If this is marked default, clear the current default first
    if (isDefault) {
      await db.query(
        "UPDATE addresses SET is_default = FALSE WHERE user_id = $1",
        [req.user.id]
      );
    }

    const result = await db.query(
      `INSERT INTO addresses
         (user_id, label, full_name, phone, address_line1, address_line2, city, state, pincode, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, label, full_name, phone, address_line1, address_line2,
                 city, state, pincode, is_default, created_at, updated_at`,
      [
        req.user.id,
        label        || "Home",
        fullName,
        phone.trim(),
        addressLine1,
        addressLine2 || null,
        city,
        state        || "Tamil Nadu",
        pincode,
        isDefault    || false
      ]
    );

    console.log({ route: "POST /api/users/me/addresses", userId: req.user?.id, addressId: result.rows[0].id, status: 201 });
    return res.status(201).json({ success: true, message: "Address added", address: result.rows[0] });
  } catch (err) {
    console.error({ route: "POST /api/users/me/addresses", userId: req.user?.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADDRESSES — PUT /api/users/me/addresses/:addressId
// ==================================================================
async function updateAddress(req, res) {
  const { addressId, label, fullName, phone, addressLine1, addressLine2, city, state, pincode, isDefault } = req.body;
  console.log({ route: "PUT /api/users/me/update-address", userId: req.user?.id, addressId, label, fullName, phone, addressLine1, city, state, pincode, isDefault, status: "updating address" });

  try {
    const existing = await db.query(
      "SELECT id FROM addresses WHERE id = $1 AND user_id = $2",
      [addressId, req.user.id]
    );
    if (existing.rows.length === 0) {
      console.log({ route: "PUT /api/users/me/update-address", userId: req.user?.id, addressId, status: 404, message: "Address not found" });
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    if (isDefault) {
      await db.query(
        "UPDATE addresses SET is_default = FALSE WHERE user_id = $1",
        [req.user.id]
      );
    }

    const result = await db.query(
      `UPDATE addresses SET
        label         = COALESCE($1, label),
        full_name     = COALESCE($2, full_name),
        phone         = COALESCE($3, phone),
        address_line1 = COALESCE($4, address_line1),
        address_line2 = COALESCE($5, address_line2),
        city          = COALESCE($6, city),
        state         = COALESCE($7, state),
        pincode       = COALESCE($8, pincode),
        is_default    = COALESCE($9, is_default),
        updated_at    = NOW()
       WHERE id = $10 AND user_id = $11
       RETURNING id, label, full_name, phone, address_line1, address_line2,
                 city, state, pincode, is_default, created_at, updated_at`,
      [
        label        || null,
        fullName     || null,
        phone        ? phone.trim() : null,
        addressLine1 || null,
        addressLine2 !== undefined ? addressLine2 : null,
        city         || null,
        state        || null,
        pincode      || null,
        isDefault    != null ? isDefault : null,
        addressId,
        req.user.id
      ]
    );

    console.log({ route: "PUT /api/users/me/update-address", userId: req.user?.id, addressId, status: 200 });
    return res.json({ success: true, message: "Address updated", address: result.rows[0] });
  } catch (err) {
    console.error({ route: "PUT /api/users/me/update-address", userId: req.user?.id, addressId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADDRESSES — DELETE /api/users/me/addresses/:addressId
// ==================================================================
async function deleteAddress(req, res) {
  const { addressId } = req.body;
  console.log({ route: "DELETE /api/users/me/delete-address", userId: req.user?.id, addressId, status: "deleting address" });

  try {
    const result = await db.query(
      "DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING id",
      [addressId, req.user.id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/users/me/delete-address", userId: req.user?.id, addressId, status: 404, message: "Address not found" });
      return res.status(404).json({ success: false, message: "Address not found" });
    }
    console.log({ route: "DELETE /api/users/me/delete-address", userId: req.user?.id, addressId, status: 200 });
    return res.json({ success: true, message: "Address deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/users/me/delete-address", userId: req.user?.id, addressId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  // Admin
  getAllUsers,
  getUserById,
  adminUpdateUser,
  toggleUserStatus,
  deleteUser,
  // Self
  getMyProfile,
  updateMyProfile,
  changeMyPassword,
  // Addresses
  getMyAddresses,
  addAddress,
  updateAddress,
  deleteAddress
};