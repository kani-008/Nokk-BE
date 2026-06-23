const db     = require("../config/db.js");
const logger = require("../utils/logger.js");

function formatBanner(b) {
  return {
    id:        b.id,
    title:     b.title,
    subtitle:  b.subtitle,
    imageUrl:  b.image_url,
    videoUrl:  b.video_url,
    isActive:  b.is_active,
    createdAt: b.created_at,
    updatedAt: b.updated_at
  };
}

const log  = (data) => logger.info(JSON.stringify(data));
const lerr = (data) => logger.error(JSON.stringify(data));

// ==================================================================
// PUBLIC — GET /api/banners
// ==================================================================
async function getBanners(req, res) {
  log({ route: "GET /api/banners", status: "fetching active banners" });
  try {
    const result = await db.query(
      `SELECT * FROM banners WHERE is_active = TRUE ORDER BY id ASC`
    );
    if (result.rows.length === 0) {
      log({ route: "GET /api/banners", status: 404, message: "No active banners found" });
      return res.status(404).json({ success: false, message: "No active banners found" });
    }
    log({ route: "GET /api/banners", status: 200, count: result.rows.length });
    return res.status(200).json({ success: true, banners: result.rows.map(formatBanner) });
  } catch (err) {
    lerr({ route: "GET /api/banners", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/banners/all
// ==================================================================
async function getAllBanners(req, res) {
  log({ route: "GET /api/banners/all", status: "fetching all banners" });
  try {
    const result = await db.query(`SELECT * FROM banners ORDER BY id ASC`);
    if (result.rows.length === 0) {
      log({ route: "GET /api/banners/all", status: 404, message: "No banners found" });
      return res.status(404).json({ success: false, message: "No banners found" });
    }
    log({ route: "GET /api/banners/all", status: 200, count: result.rows.length });
    return res.status(200).json({ success: true, banners: result.rows.map(formatBanner) });
  } catch (err) {
    lerr({ route: "GET /api/banners/all", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/banners
// ==================================================================
async function createBanner(req, res) {
  const { title, subtitle, imageUrl, videoUrl, isActive } = req.body;
  log({ route: "POST /api/banners", status: "creating", body: { title, subtitle, imageUrl, videoUrl, isActive } });
  if (!title) {
    log({ route: "POST /api/banners", status: 400, message: "title is required" });
    return res.status(400).json({ success: false, message: "title is required" });
  }
  if (!imageUrl) {
    log({ route: "POST /api/banners", status: 400, message: "imageUrl is required" });
    return res.status(400).json({ success: false, message: "imageUrl is required" });
  }
  try {
    const result = await db.query(
      `INSERT INTO banners (title, subtitle, image_url, video_url, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title.trim(), subtitle || null, imageUrl, videoUrl || null, isActive ?? true]
    );
    if (result.rows.length === 0) {
      log({ route: "POST /api/banners", status: 500, message: "Insert returned no rows" });
      return res.status(500).json({ success: false, message: "Banner creation failed" });
    }
    log({ route: "POST /api/banners", status: 201, bannerId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Banner created", banner: formatBanner(result.rows[0]) });
  } catch (err) {
    lerr({ route: "POST /api/banners", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/banners/:id
// ==================================================================
async function updateBanner(req, res) {
  const { id } = req.params;
  const { title, subtitle, imageUrl, videoUrl, isActive } = req.body;
  log({ route: "PUT /api/banners/:id", bannerId: id, body: { title, subtitle, imageUrl, videoUrl, isActive } });
  if (!id) {
    log({ route: "PUT /api/banners/:id", status: 400, message: "Banner id is required" });
    return res.status(400).json({ success: false, message: "Banner id is required" });
  }
  try {
    const result = await db.query(
      `UPDATE banners SET
         title      = COALESCE($1, title),
         subtitle   = COALESCE($2, subtitle),
         image_url  = COALESCE($3, image_url),
         video_url  = COALESCE($4, video_url),
         is_active  = COALESCE($5, is_active),
         updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        title    || null,
        subtitle !== undefined ? subtitle : null,
        imageUrl || null,
        videoUrl !== undefined ? videoUrl : null,
        isActive !== undefined ? isActive : null,
        id
      ]
    );
    if (result.rows.length === 0) {
      log({ route: "PUT /api/banners/:id", bannerId: id, status: 404, message: "Banner not found" });
      return res.status(404).json({ success: false, message: "Banner not found" });
    }
    log({ route: "PUT /api/banners/:id", bannerId: id, status: 200, message: "Banner updated" });
    return res.status(200).json({ success: true, message: "Banner updated", banner: formatBanner(result.rows[0]) });
  } catch (err) {
    lerr({ route: "PUT /api/banners/:id", bannerId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/banners/:id
// ==================================================================
async function deleteBanner(req, res) {
  const { id } = req.params;
  log({ route: "DELETE /api/banners/:id", bannerId: id, status: "deleting" });
  if (!id) {
    log({ route: "DELETE /api/banners/:id", status: 400, message: "Banner id is required" });
    return res.status(400).json({ success: false, message: "Banner id is required" });
  }
  try {
    const result = await db.query(
      "DELETE FROM banners WHERE id = $1 RETURNING id", [id]
    );
    if (result.rows.length === 0) {
      log({ route: "DELETE /api/banners/:id", bannerId: id, status: 404, message: "Banner not found" });
      return res.status(404).json({ success: false, message: "Banner not found" });
    }
    log({ route: "DELETE /api/banners/:id", bannerId: id, status: 200, message: "Banner deleted" });
    return res.status(200).json({ success: true, message: "Banner deleted" });
  } catch (err) {
    lerr({ route: "DELETE /api/banners/:id", bannerId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getBanners, getAllBanners, createBanner, updateBanner, deleteBanner };
