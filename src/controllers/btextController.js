const db = require("../config/db.js");

function formatBtext(b) {
  return {
    id: b.bt_id,
    bannerId: b.banner_id,
    heading: b.heading,
    subtext: b.subtext,
    isActive: b.is_active,
    createdAt: b.created_at,
    updatedAt: b.updated_at
  };
}

const log = (data) => console.log(data);
const lerr = (data) => console.error(data);

// ==================================================================
// PUBLIC — GET /api/btext?bannerId=<id>
// ==================================================================
async function getBtextByBanner(req, res) {
  const { bannerId } = req.query;
  log({ route: "GET /api/btext", bannerId, status: "fetching active btext" });
  if (!bannerId) {
    log({ route: "GET /api/btext", status: 400, message: "bannerId query param is required" });
    return res.status(400).json({ success: false, message: "bannerId query param is required" });
  }
  try {
    const result = await db.query(
      `SELECT * FROM btext WHERE banner_id = $1 AND is_active = TRUE ORDER BY bt_id ASC`,
      [bannerId]
    );
    log({ route: "GET /api/btext", bannerId, status: 200, count: result.rows.length });
    return res.status(200).json({ success: true, btexts: result.rows.map(formatBtext) });
  } catch (err) {
    lerr({ route: "GET /api/btext", bannerId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/btext/all
// ==================================================================
async function getAllBtext(req, res) {
  log({ route: "GET /api/btext/all", status: "fetching all btext" });
  try {
    const result = await db.query(`SELECT * FROM btext ORDER BY banner_id ASC, bt_id ASC`);
    log({ route: "GET /api/btext/all", status: 200, count: result.rows.length });
    return res.status(200).json({ success: true, btexts: result.rows.map(formatBtext) });
  } catch (err) {
    lerr({ route: "GET /api/btext/all", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/btext/banner/:bannerId
// ==================================================================
async function getBtextForBanner(req, res) {
  const { bannerId } = req.query;
  log({ route: "GET /api/btext/get-for-banner", bannerId, status: "fetching all btext for banner" });
  if (!bannerId) {
    log({ route: "GET /api/btext/get-for-banner", status: 400, message: "bannerId query param is required" });
    return res.status(400).json({ success: false, message: "bannerId query param is required" });
  }
  try {
    const result = await db.query(
      `SELECT * FROM btext WHERE banner_id = $1 ORDER BY bt_id ASC`,
      [bannerId]
    );
    log({ route: "GET /api/btext/get-for-banner", bannerId, status: 200, count: result.rows.length });
    return res.status(200).json({ success: true, btexts: result.rows.map(formatBtext) });
  } catch (err) {
    lerr({ route: "GET /api/btext/get-for-banner", bannerId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/btext
// ==================================================================
async function createBtext(req, res) {
  const { bannerId, heading, subtext, isActive } = req.body;
  log({ route: "POST /api/btext", body: { bannerId, heading, subtext, isActive } });
  if (!bannerId) {
    log({ route: "POST /api/btext", status: 400, message: "bannerId is required" });
    return res.status(400).json({ success: false, message: "bannerId is required" });
  }
  if (!heading) {
    log({ route: "POST /api/btext", status: 400, message: "heading is required" });
    return res.status(400).json({ success: false, message: "heading is required" });
  }
  try {
    const result = await db.query(
      `INSERT INTO btext (banner_id, heading, subtext, is_active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [bannerId, heading.trim(), subtext || null, isActive ?? true]
    );
    if (result.rows.length === 0) {
      log({ route: "POST /api/btext", status: 500, message: "Insert returned no rows" });
      return res.status(500).json({ success: false, message: "Btext creation failed" });
    }
    log({ route: "POST /api/btext", status: 201, btextId: result.rows[0].bt_id });
    return res.status(201).json({ success: true, message: "Btext created", btext: formatBtext(result.rows[0]) });
  } catch (err) {
    if (err.code === "23503") {
      log({ route: "POST /api/btext", bannerId, status: 404, message: "Banner not found (FK violation)" });
      return res.status(404).json({ success: false, message: "Banner not found" });
    }
    lerr({ route: "POST /api/btext", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/btext/:id
// ==================================================================
async function updateBtext(req, res) {
  const { id, heading, subtext, isActive } = req.body;
  log({ route: "PUT /api/btext/update-btext", btextId: id, body: { heading, subtext, isActive } });
  if (!id) {
    log({
      route: "PUT /api/btext/update-btext",
      status: 400,
      message: "Btext id is required"
    });
    return res.status(400).json({ success: false, message: "Btext id is required" });
  }
  try {
    const result = await db.query(
      `UPDATE btext SET
         heading    = COALESCE($1, heading),
         subtext    = COALESCE($2, subtext),
         is_active  = COALESCE($3, is_active),
         updated_at = NOW()
       WHERE bt_id = $4
       RETURNING *`,
      [
        heading || null,
        subtext !== undefined ? subtext : null,
        isActive !== undefined ? isActive : null,
        id
      ]
    );
    if (result.rows.length === 0) {
      log({ route: "PUT /api/btext/update-btext", btextId: id, status: 404, message: "Btext not found" });
      return res.status(404).json({ success: false, message: "Btext not found" });
    }
    log({ route: "PUT /api/btext/update-btext", btextId: id, status: 200, message: "Btext updated" });
    return res.status(200).json({ success: true, message: "Btext updated", btext: formatBtext(result.rows[0]) });
  } catch (err) {
    lerr({ route: "PUT /api/btext/update-btext", btextId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/btext/:id
// ==================================================================
async function deleteBtext(req, res) {
  const { id } = req.body;
  log({ route: "DELETE /api/btext/delete-btext", btextId: id, status: "deleting" });
  if (!id) {
    log({ route: "DELETE /api/btext/delete-btext", status: 400, message: "Btext id is required" });
    return res.status(400).json({ success: false, message: "Btext id is required" });
  }
  try {
    const result = await db.query(
      `DELETE FROM btext WHERE bt_id = $1 RETURNING bt_id`,
      [id]
    );
    if (result.rows.length === 0) {
      log({ route: "DELETE /api/btext/delete-btext", btextId: id, status: 404, message: "Btext not found" });
      return res.status(404).json({ success: false, message: "Btext not found" });
    }
    log({ route: "DELETE /api/btext/delete-btext", btextId: id, status: 200, message: "Btext deleted" });
    return res.status(200).json({ success: true, message: "Btext deleted" });
  } catch (err) {
    lerr({ route: "DELETE /api/btext/delete-btext", btextId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getBtextByBanner, getAllBtext, getBtextForBanner, createBtext, updateBtext, deleteBtext };
