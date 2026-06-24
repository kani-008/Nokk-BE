const db = require("../config/db.js");
const { uploadToSupabase, deleteFromSupabase } = require("../config/supabase.js");

// Convert legacy signed URLs to public URLs (signing-key rotation recovery)
function toPublicUrl(url) {
  if (!url || !url.includes("/object/sign/")) return url;
  return url.replace("/object/sign/", "/object/public/").split("?")[0];
}

function formatBanner(b) {
  return {
    id: b.id,
    title: b.title,
    subtitle: b.subtitle,
    imageUrl: toPublicUrl(b.image_url),
    videoUrl: toPublicUrl(b.video_url),
    isActive: b.is_active,
    createdAt: b.created_at,
    updatedAt: b.updated_at
  };
}

// ==================================================================
// PUBLIC — GET /api/banners/get-banners
// ==================================================================
async function getBanners(req, res) {
  console.log({ route: "GET /api/banners/get-banners", status: "fetching active banners" });
  try {
    const result = await db.query(
      `SELECT * FROM banners WHERE is_active = TRUE ORDER BY id ASC`
    );
    return res.status(200).json({ success: true, banners: result.rows.map(formatBanner) });
  } catch (err) {
    console.error({ route: "GET /api/banners/get-banners", error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/banners/get-all
// ==================================================================
async function getAllBanners(req, res) {
  console.log({ route: "GET /api/banners/get-all", status: "fetching all banners" });
  try {
    const result = await db.query(`SELECT * FROM banners ORDER BY id ASC`);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "No banners found" });
    }
    return res.status(200).json({ success: true, banners: result.rows.map(formatBanner) });
  } catch (err) {
    console.error({ route: "GET /api/banners/get-all", error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/banners/create-banner
// Accepts multipart/form-data (imageFile, videoFile) OR JSON (imageUrl, videoUrl).
// ==================================================================
async function createBanner(req, res) {
  let { title, subtitle, imageUrl, videoUrl, isActive } = req.body;
  console.log({ route: "POST /api/banners/create-banner", body: { title, subtitle, isActive } });

  try {
    if (req.files?.imageFile?.[0]) {
      const f = req.files.imageFile[0];
      imageUrl = await uploadToSupabase(f.buffer, f.mimetype, f.originalname, "banner");
    }
    if (req.files?.videoFile?.[0]) {
      const f = req.files.videoFile[0];
      videoUrl = await uploadToSupabase(f.buffer, f.mimetype, f.originalname, "banner");
    }

    if (!title) {
      return res.status(400).json({ success: false, message: "title is required" });
    }
    if (!imageUrl) {
      return res.status(400).json({ success: false, message: "imageUrl or imageFile is required" });
    }

    const result = await db.query(
      `INSERT INTO banners (title, subtitle, image_url, video_url, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title.trim(), subtitle || null, imageUrl, videoUrl || null, isActive ?? true]
    );
    console.log({ route: "POST /api/banners/create-banner", status: 201, bannerId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Banner created", banner: formatBanner(result.rows[0]) });
  } catch (err) {
    console.error({ route: "POST /api/banners/create-banner", error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/banners/update-banner
// Accepts multipart/form-data or JSON. Deletes replaced files from storage.
// ==================================================================
async function updateBanner(req, res) {
  let { id, title, subtitle, imageUrl, videoUrl, isActive } = req.body;
  console.log({ route: "PUT /api/banners/update-banner", bannerId: id });

  if (!id) {
    return res.status(400).json({ success: false, message: "Banner id is required" });
  }

  try {
    const current = await db.query(
      "SELECT image_url, video_url FROM banners WHERE id = $1", [id]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }
    const { image_url: oldImageUrl, video_url: oldVideoUrl } = current.rows[0];

    if (req.files?.imageFile?.[0]) {
      const f = req.files.imageFile[0];
      imageUrl = await uploadToSupabase(f.buffer, f.mimetype, f.originalname, "banner");
    }
    if (req.files?.videoFile?.[0]) {
      const f = req.files.videoFile[0];
      videoUrl = await uploadToSupabase(f.buffer, f.mimetype, f.originalname, "banner");
    }

    const result = await db.query(
      `UPDATE banners SET
         title      = COALESCE($1, title),
         subtitle   = COALESCE($2, subtitle),
         image_url  = COALESCE($3, image_url),
         video_url  = COALESCE($4, video_url),
         is_active  = COALESCE($5, is_active),
         updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [
        title || null,
        subtitle !== undefined ? subtitle : null,
        imageUrl || null,
        videoUrl !== undefined ? videoUrl : null,
        isActive !== undefined ? isActive : null,
        id
      ]
    );

    // Delete old Supabase files only if they were actually replaced
    if (imageUrl && oldImageUrl && imageUrl !== oldImageUrl) {
      await deleteFromSupabase(oldImageUrl);
    }
    if (videoUrl && oldVideoUrl && videoUrl !== oldVideoUrl) {
      await deleteFromSupabase(oldVideoUrl);
    }

    console.log({ route: "PUT /api/banners/update-banner", bannerId: id, status: 200 });
    return res.status(200).json({ success: true, message: "Banner updated", banner: formatBanner(result.rows[0]) });
  } catch (err) {
    console.error({ route: "PUT /api/banners/update-banner", bannerId: id, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/banners/delete-banner
// Removes the DB record and deletes associated files from Supabase.
// ==================================================================
async function deleteBanner(req, res) {
  const { id } = req.body;
  console.log({ route: "DELETE /api/banners/delete-banner", bannerId: id });

  if (!id) {
    return res.status(400).json({ success: false, message: "Banner id is required" });
  }

  try {
    const result = await db.query(
      "DELETE FROM banners WHERE id = $1 RETURNING image_url, video_url", [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }

    const { image_url, video_url } = result.rows[0];
    await Promise.allSettled([
      deleteFromSupabase(image_url),
      deleteFromSupabase(video_url),
    ]);

    console.log({ route: "DELETE /api/banners/delete-banner", bannerId: id, status: 200 });
    return res.status(200).json({ success: true, message: "Banner deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/banners/delete-banner", bannerId: id, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getBanners, getAllBanners, createBanner, updateBanner, deleteBanner };
