const db = require("../config/db.js");
const { uploadToSupabase } = require("../config/supabase.js");

const num = (v) => parseFloat(v) || 0;

// ------------------------------------------------------------------
// Batch-fetch member items for a set of combos in one query (no N+1),
// joined with product name + variant weight/price so the frontend never
// needs a second request per combo to show what's inside it.
// ------------------------------------------------------------------
async function fetchComboItemsMap(comboIds) {
  const map = {};
  if (!comboIds.length) return map;
  const res = await db.query(
    `SELECT ci.id, ci.combo_id, ci.product_id, ci.variant_id, ci.quantity,
            p.name_en AS product_name, p.name_ta AS product_name_ta,
            pv.weight_label, pv.price, pv.stock_qty
     FROM combo_items ci
     JOIN products p ON p.id = ci.product_id
     JOIN product_variants pv ON pv.id = ci.variant_id
     WHERE ci.combo_id = ANY($1)
     ORDER BY ci.created_at ASC`,
    [comboIds]
  );
  res.rows.forEach((r) => {
    if (!map[r.combo_id]) map[r.combo_id] = [];
    map[r.combo_id].push({
      id: r.id,
      productId: r.product_id,
      variantId: r.variant_id,
      productName: r.product_name,
      productNameTa: r.product_name_ta,
      weightLabel: r.weight_label,
      price: num(r.price),
      quantity: parseInt(r.quantity),
      inStock: parseInt(r.stock_qty) > 0,
    });
  });
  return map;
}

function formatCombo(c, items = []) {
  const now = new Date();
  const started = !c.start_date || new Date(c.start_date) <= now;
  const notEnded = !c.end_date || new Date(c.end_date) >= now;
  const individualTotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const comboPrice = num(c.combo_price);
  const allInStock = items.length > 0 && items.every((i) => i.inStock);
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    imageUrl: c.image_url || null,
    comboPrice,
    isActive: c.is_active,
    isLive: c.is_active && started && notEnded,
    startDate: c.start_date,
    endDate: c.end_date,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    items,
    inStock: allInStock,
    individualTotal: parseFloat(individualTotal.toFixed(2)),
    savings: parseFloat(Math.max(individualTotal - comboPrice, 0).toFixed(2)),
  };
}

function parseItems(raw) {
  let items = raw;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { items = []; }
  }
  return Array.isArray(items) ? items : [];
}

// ------------------------------------------------------------------
// Shared validation for createCombo/updateCombo — every variantId must
// actually exist and belong to its paired productId.
// ------------------------------------------------------------------
async function validateComboItems(items) {
  if (items.length < 2) {
    return "A combo needs at least 2 items";
  }
  const variantIds = items.map((i) => i.variantId);
  const varRes = await db.query(
    `SELECT id, product_id FROM product_variants WHERE id = ANY($1)`,
    [variantIds]
  );
  const variantProductMap = {};
  varRes.rows.forEach((r) => { variantProductMap[r.id] = r.product_id; });
  for (const item of items) {
    const actualProductId = variantProductMap[item.variantId];
    if (!actualProductId) {
      return `Variant not found: ${item.variantId}`;
    }
    if (actualProductId !== item.productId) {
      return `Variant ${item.variantId} does not belong to product ${item.productId}`;
    }
  }
  return null;
}

// ==================================================================
// PUBLIC — GET /api/combos/get-active
// Live combos with member items joined in, plus each combo's computed
// individual-purchase total and savings.
// ==================================================================
async function getActiveCombos(req, res) {
  console.log({ route: "GET /api/combos/get-active", status: "fetching active combos" });
  try {
    const result = await db.query(
      `SELECT * FROM combos
       WHERE is_active = TRUE
         AND (start_date IS NULL OR start_date <= NOW())
         AND (end_date   IS NULL OR end_date   >= NOW())
       ORDER BY created_at DESC`
    );
    const itemsMap = await fetchComboItemsMap(result.rows.map((r) => r.id));
    console.log({ route: "GET /api/combos/get-active", status: 200, count: result.rows.length });
    return res.json({ success: true, combos: result.rows.map((c) => formatCombo(c, itemsMap[c.id] || [])) });
  } catch (err) {
    console.error({ route: "GET /api/combos/get-active", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/combos/get-all
// All combos regardless of active/date status — for the admin table.
// ==================================================================
async function getAllCombos(req, res) {
  console.log({ route: "GET /api/combos/get-all", status: "fetching all combos" });
  try {
    const result = await db.query(`SELECT * FROM combos ORDER BY created_at DESC`);
    const itemsMap = await fetchComboItemsMap(result.rows.map((r) => r.id));
    console.log({ route: "GET /api/combos/get-all", status: 200, count: result.rows.length });
    return res.json({ success: true, combos: result.rows.map((c) => formatCombo(c, itemsMap[c.id] || [])) });
  } catch (err) {
    console.error({ route: "GET /api/combos/get-all", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/combos/get-by-id?id=
// ==================================================================
async function getComboById(req, res) {
  const { id } = req.query;
  console.log({ route: "GET /api/combos/get-by-id", comboId: id, status: "fetching combo by id" });
  if (!id) {
    return res.status(400).json({ success: false, message: "id is required" });
  }
  try {
    const result = await db.query(`SELECT * FROM combos WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      console.log({ route: "GET /api/combos/get-by-id", comboId: id, status: 404, message: "Combo not found" });
      return res.status(404).json({ success: false, message: "Combo not found" });
    }
    const itemsMap = await fetchComboItemsMap([id]);
    console.log({ route: "GET /api/combos/get-by-id", comboId: id, status: 200 });
    return res.json({ success: true, combo: formatCombo(result.rows[0], itemsMap[id] || []) });
  } catch (err) {
    console.error({ route: "GET /api/combos/get-by-id", comboId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/combos/create-combo
// Multipart: name, description?, comboPrice, isActive?, startDate?,
// endDate?, items (JSON string: [{ productId, variantId, quantity }]),
// imageFile?
// ==================================================================
async function createCombo(req, res) {
  const { name, description, comboPrice, isActive, startDate, endDate } = req.body;
  const items = parseItems(req.body.items);
  console.log({ route: "POST /api/combos/create-combo", body: { name, comboPrice, itemsCount: items.length }, status: "creating combo" });

  if (!name || comboPrice == null) {
    console.log({ route: "POST /api/combos/create-combo", status: 400, message: "name and comboPrice are required" });
    return res.status(400).json({ success: false, message: "name and comboPrice are required" });
  }
  const price = parseFloat(comboPrice);
  if (!(price > 0)) {
    console.log({ route: "POST /api/combos/create-combo", status: 400, message: "comboPrice must be greater than 0" });
    return res.status(400).json({ success: false, message: "comboPrice must be greater than 0" });
  }

  const itemsError = await validateComboItems(items);
  if (itemsError) {
    console.log({ route: "POST /api/combos/create-combo", status: 400, message: itemsError });
    return res.status(400).json({ success: false, message: itemsError });
  }

  let imageUrl = null;
  if (req.file) {
    imageUrl = await uploadToSupabase(req.file.buffer, req.file.mimetype, req.file.originalname, "combo");
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const comboRes = await client.query(
      `INSERT INTO combos (name, description, image_url, combo_price, is_active, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [name.trim(), description || null, imageUrl, price, isActive ?? true, startDate || null, endDate || null]
    );
    const combo = comboRes.rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO combo_items (combo_id, product_id, variant_id, quantity)
         VALUES ($1,$2,$3,$4)`,
        [combo.id, item.productId, item.variantId, parseInt(item.quantity) || 1]
      );
    }

    await client.query("COMMIT");

    const itemsMap = await fetchComboItemsMap([combo.id]);
    console.log({ route: "POST /api/combos/create-combo", status: 201, comboId: combo.id });
    return res.status(201).json({ success: true, message: "Combo created", combo: formatCombo(combo, itemsMap[combo.id] || []) });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error({ route: "POST /api/combos/create-combo", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// ADMIN — PUT /api/combos/update-combo
// Same validation as create. When `items` is present, replaces the
// entire combo_items set for that combo in the same transaction.
// ==================================================================
async function updateCombo(req, res) {
  const { id, name, description, comboPrice, isActive, startDate, endDate } = req.body;
  const itemsProvided = req.body.items !== undefined;
  const items = itemsProvided ? parseItems(req.body.items) : null;
  console.log({ route: "PUT /api/combos/update-combo", comboId: id, body: { name, comboPrice, itemsProvided }, status: "updating combo" });

  if (!id) {
    return res.status(400).json({ success: false, message: "id is required" });
  }

  try {
    const existingRes = await db.query(`SELECT * FROM combos WHERE id = $1`, [id]);
    if (existingRes.rows.length === 0) {
      console.log({ route: "PUT /api/combos/update-combo", comboId: id, status: 404, message: "Combo not found" });
      return res.status(404).json({ success: false, message: "Combo not found" });
    }
    const existing = existingRes.rows[0];

    const finalPrice = comboPrice !== undefined ? parseFloat(comboPrice) : parseFloat(existing.combo_price);
    if (!(finalPrice > 0)) {
      return res.status(400).json({ success: false, message: "comboPrice must be greater than 0" });
    }

    if (itemsProvided) {
      const itemsError = await validateComboItems(items);
      if (itemsError) {
        console.log({ route: "PUT /api/combos/update-combo", comboId: id, status: 400, message: itemsError });
        return res.status(400).json({ success: false, message: itemsError });
      }
    }

    let newImageUrl = req.file
      ? await uploadToSupabase(req.file.buffer, req.file.mimetype, req.file.originalname, "combo")
      : undefined;

    const finalName = name !== undefined ? name.trim() : existing.name;
    const finalDesc = description !== undefined ? (description || null) : existing.description;
    const finalIsActive = isActive !== undefined ? isActive : existing.is_active;
    const finalStartDate = startDate !== undefined ? (startDate || null) : existing.start_date;
    const finalEndDate = endDate !== undefined ? (endDate || null) : existing.end_date;
    const finalImageUrl = newImageUrl !== undefined ? newImageUrl : existing.image_url;

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const comboRes = await client.query(
        `UPDATE combos SET
           name = $1, description = $2, image_url = $3, combo_price = $4,
           is_active = $5, start_date = $6, end_date = $7, updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [finalName, finalDesc, finalImageUrl, finalPrice, finalIsActive, finalStartDate, finalEndDate, id]
      );
      const combo = comboRes.rows[0];

      if (itemsProvided) {
        await client.query(`DELETE FROM combo_items WHERE combo_id = $1`, [id]);
        for (const item of items) {
          await client.query(
            `INSERT INTO combo_items (combo_id, product_id, variant_id, quantity)
             VALUES ($1,$2,$3,$4)`,
            [id, item.productId, item.variantId, parseInt(item.quantity) || 1]
          );
        }
      }

      await client.query("COMMIT");

      const itemsMap = await fetchComboItemsMap([id]);
      console.log({ route: "PUT /api/combos/update-combo", comboId: id, status: 200 });
      return res.json({ success: true, message: "Combo updated", combo: formatCombo(combo, itemsMap[id] || []) });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error({ route: "PUT /api/combos/update-combo", comboId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/combos/delete-combo
// combo_items rows cascade-delete automatically (ON DELETE CASCADE).
// ==================================================================
async function deleteCombo(req, res) {
  const { id } = req.body;
  console.log({ route: "DELETE /api/combos/delete-combo", comboId: id, status: "deleting combo" });
  if (!id) {
    return res.status(400).json({ success: false, message: "id is required" });
  }
  try {
    const result = await db.query(`DELETE FROM combos WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/combos/delete-combo", comboId: id, status: 404, message: "Combo not found" });
      return res.status(404).json({ success: false, message: "Combo not found" });
    }
    console.log({ route: "DELETE /api/combos/delete-combo", comboId: id, status: 200 });
    return res.json({ success: true, message: "Combo deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/combos/delete-combo", comboId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getActiveCombos, getAllCombos, getComboById,
  createCombo, updateCombo, deleteCombo,
};
