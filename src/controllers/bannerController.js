const db = require("../config/db.js");

// banners.id is SERIAL (integer), not UUID
function formatBanner(b) {
  return {
    id:        b.id,
    title:     b.title,
    subtitle:  b.subtitle,
    imageUrl:  b.image_url,
    linkUrl:   b.link_url,
    sortOrder: b.sort_order,
    isActive:  b.is_active,
    createdAt: b.created_at,
    updatedAt: b.updated_at
  };
}

// ==================================================================
// PUBLIC — GET /api/banners
// All active banners ordered by sort_order.
// Used by: Home page hero/slider.
// ==================================================================
async function getBanners(req, res) {
  try {
    const result = await db.query(
      `SELECT * FROM banners WHERE is_active = TRUE ORDER BY sort_order ASC`
    );
    return res.json({ success: true, banners: result.rows.map(formatBanner) });
  } catch (err) {
    console.error("Get banners error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/banners/all
// All banners (active + inactive) for the admin manage screen.
// ==================================================================
async function getAllBanners(req, res) {
  try {
    const result = await db.query(`SELECT * FROM banners ORDER BY sort_order ASC`);
    return res.json({ success: true, banners: result.rows.map(formatBanner) });
  } catch (err) {
    console.error("Get all banners error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/banners
// Body: { title, subtitle?, imageUrl, linkUrl?, sortOrder?, isActive? }
// ==================================================================
async function createBanner(req, res) {
  const { title, subtitle, imageUrl, linkUrl, sortOrder, isActive } = req.body;
  if (!title || !imageUrl) {
    return res.status(400).json({ success: false, message: "title and imageUrl are required" });
  }
  try {
    const result = await db.query(
      `INSERT INTO banners (title, subtitle, image_url, link_url, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [title.trim(), subtitle || null, imageUrl, linkUrl || null, sortOrder ?? 0, isActive ?? true]
    );
    return res.status(201).json({ success: true, message: "Banner created", banner: formatBanner(result.rows[0]) });
  } catch (err) {
    console.error("Create banner error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/banners/:id
// ==================================================================
async function updateBanner(req, res) {
  const { title, subtitle, imageUrl, linkUrl, sortOrder, isActive } = req.body;
  try {
    const result = await db.query(
      `UPDATE banners SET
         title      = COALESCE($1, title),
         subtitle   = COALESCE($2, subtitle),
         image_url  = COALESCE($3, image_url),
         link_url   = COALESCE($4, link_url),
         sort_order = COALESCE($5, sort_order),
         is_active  = COALESCE($6, is_active),
         updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        title    || null,
        subtitle !== undefined ? subtitle : null,
        imageUrl || null,
        linkUrl  !== undefined ? linkUrl  : null,
        sortOrder !== undefined ? sortOrder : null,
        isActive  !== undefined ? isActive  : null,
        req.params.id
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }
    return res.json({ success: true, message: "Banner updated", banner: formatBanner(result.rows[0]) });
  } catch (err) {
    console.error("Update banner error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/banners/:id
// ==================================================================
async function deleteBanner(req, res) {
  try {
    const result = await db.query(
      "DELETE FROM banners WHERE id = $1 RETURNING id", [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }
    return res.json({ success: true, message: "Banner deleted" });
  } catch (err) {
    console.error("Delete banner error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getBanners, getAllBanners, createBanner, updateBanner, deleteBanner };