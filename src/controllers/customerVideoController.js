const db = require("../config/db.js");
const { uploadToImageKit, deleteFromImageKit } = require("../config/imagekit.js");

function formatCustomerVideo(v) {
  return {
    id: v.id,
    videoUrl: v.video_url,
    posterUrl: v.poster_url || null,
    customerName: v.customer_name || null,
    caption: v.caption || null,
    sortOrder: v.sort_order || 0,
    isActive: v.is_active ?? true,
    createdAt: v.created_at,
  };
}

// PUBLIC — GET /api/customer-videos/get-active
async function getActiveCustomerVideos(req, res) {
  try {
    const result = await db.query(
      `SELECT * FROM customer_videos 
       WHERE is_active = TRUE 
       ORDER BY sort_order ASC, created_at DESC`
    );
    console.log({ route: "GET /api/customer-videos/get-active", status: 200, count: result.rows.length });
    return res.status(200).json({ success: true, videos: result.rows.map(formatCustomerVideo) });
  } catch (err) {
    console.error({ route: "GET /api/customer-videos/get-active", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ADMIN — GET /api/customer-videos/get-all
async function getAllCustomerVideos(req, res) {
  try {
    const result = await db.query(
      `SELECT * FROM customer_videos 
       ORDER BY sort_order ASC, created_at DESC`
    );
    console.log({ route: "GET /api/customer-videos/get-all", status: 200, count: result.rows.length });
    return res.status(200).json({ success: true, videos: result.rows.map(formatCustomerVideo) });
  } catch (err) {
    console.error({ route: "GET /api/customer-videos/get-all", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ADMIN — POST /api/customer-videos/create
async function createCustomerVideo(req, res) {
  const { customerName, caption, sortOrder, isActive, videoUrl, posterUrl } = req.body;
  console.log({ route: "POST /api/customer-videos/create", body: { customerName, sortOrder, videoUrl } });

  if (!videoUrl) {
    return res.status(400).json({ success: false, message: "Video URL is required" });
  }

  try {
    const result = await db.query(
      `INSERT INTO customer_videos (video_url, poster_url, customer_name, caption, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        videoUrl,
        posterUrl || null,
        customerName ? customerName.trim() : null,
        caption ? caption.trim() : null,
        parseInt(sortOrder) || 0,
        isActive === false ? false : true,
      ]
    );

    console.log({ route: "POST /api/customer-videos/create", status: 201, videoId: result.rows[0].id });
    return res.status(201).json({
      success: true,
      message: "Customer video testimonial created successfully",
      video: formatCustomerVideo(result.rows[0]),
    });
  } catch (err) {
    console.error({ route: "POST /api/customer-videos/create", error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ADMIN — PUT /api/customer-videos/update
async function updateCustomerVideo(req, res) {
  const { id, customerName, caption, sortOrder, isActive, videoUrl, posterUrl } = req.body;
  console.log({ route: "PUT /api/customer-videos/update", videoId: id });

  if (!id) {
    return res.status(400).json({ success: false, message: "ID is required" });
  }

  try {
    const existing = await db.query("SELECT * FROM customer_videos WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Customer video not found" });
    }
    const current = existing.rows[0];

    const result = await db.query(
      `UPDATE customer_videos SET
         video_url = COALESCE($1, video_url),
         poster_url = $2,
         customer_name = COALESCE($3, customer_name),
         caption = COALESCE($4, caption),
         sort_order = COALESCE($5, sort_order),
         is_active = COALESCE($6, is_active)
       WHERE id = $7
       RETURNING *`,
      [
        videoUrl || current.video_url,
        posterUrl !== undefined ? posterUrl : current.poster_url,
        customerName !== undefined ? (customerName ? customerName.trim() : null) : null,
        caption !== undefined ? (caption ? caption.trim() : null) : null,
        sortOrder !== undefined ? parseInt(sortOrder) : null,
        isActive !== undefined ? (isActive === false ? false : true) : null,
        id,
      ]
    );

    // Delete old ImageKit files if replaced
    if (videoUrl && current.video_url && videoUrl !== current.video_url) {
      await deleteFromImageKit(current.video_url);
    }
    if (posterUrl && current.poster_url && posterUrl !== current.poster_url) {
      await deleteFromImageKit(current.poster_url);
    }

    console.log({ route: "PUT /api/customer-videos/update", videoId: id, status: 200 });
    return res.status(200).json({
      success: true,
      message: "Customer video testimonial updated successfully",
      video: formatCustomerVideo(result.rows[0]),
    });
  } catch (err) {
    console.error({ route: "PUT /api/customer-videos/update", videoId: id, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ADMIN — DELETE /api/customer-videos/delete
async function deleteCustomerVideo(req, res) {
  const { id } = req.body;
  console.log({ route: "DELETE /api/customer-videos/delete", videoId: id });

  if (!id) {
    return res.status(400).json({ success: false, message: "ID is required" });
  }

  try {
    const result = await db.query(
      "DELETE FROM customer_videos WHERE id = $1 RETURNING video_url, poster_url",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Customer video not found" });
    }

    const { video_url, poster_url } = result.rows[0];

    // Delete from ImageKit asynchronously to prevent API response delays
    if (video_url) {
      deleteFromImageKit(video_url).catch((err) => {
        console.warn(`[ImageKit] async delete failed for video "${video_url}": ${err.message}`);
      });
    }
    if (poster_url) {
      deleteFromImageKit(poster_url).catch((err) => {
        console.warn(`[ImageKit] async delete failed for poster "${poster_url}": ${err.message}`);
      });
    }

    console.log({ route: "DELETE /api/customer-videos/delete", videoId: id, status: 200 });
    return res.status(200).json({ success: true, message: "Customer video testimonial deleted successfully" });
  } catch (err) {
    console.error({ route: "DELETE /api/customer-videos/delete", videoId: id, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getActiveCustomerVideos,
  getAllCustomerVideos,
  createCustomerVideo,
  updateCustomerVideo,
  deleteCustomerVideo,
};
