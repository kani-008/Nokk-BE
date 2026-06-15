const db = require("../config/db.js");

// Shape for every category response — every column included
function formatCategory(c) {
  return {
    id:          c.id,
    nameEn:      c.name_en,
    nameTa:      c.name_ta,
    // Product card label rule: "English Name (Tamil Name)"
    label:       c.name_ta ? `${c.name_en} (${c.name_ta})` : c.name_en,
    slug:        c.slug,
    description: c.description,
    imageUrl:    c.image_url,
    sortOrder:   c.sort_order,
    isActive:    c.is_active,
    createdAt:   c.created_at,
    updatedAt:   c.updated_at
  };
}

// ==================================================================
// PUBLIC — GET /api/categories
// All active categories ordered by sort_order.
// Used by: Products page sidebar, Home page, Checkout filters.
// ==================================================================
async function getAllCategories(req, res) {
  try {
    const result = await db.query(
      `SELECT * FROM categories WHERE is_active = TRUE ORDER BY sort_order ASC, name_en ASC`
    );
    return res.json({ success: true, categories: result.rows.map(formatCategory) });
  } catch (err) {
    console.error("Get categories error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// PUBLIC — GET /api/categories/:slug
// Single category by slug + its active products (lightweight).
// Used by: Category landing page.
// ==================================================================
async function getCategoryBySlug(req, res) {
  try {
    const catRes = await db.query(
      `SELECT * FROM categories WHERE slug = $1 AND is_active = TRUE`,
      [req.params.slug]
    );
    if (catRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const productRes = await db.query(
      `SELECT p.id, p.name_en, p.name_ta, p.slug, p.is_bestseller, p.is_new,
              pi.image_url AS primary_image,
              COALESCE(MIN(pv.price), 0)          AS min_price,
              COALESCE(MIN(pv.compare_price), 0)  AS min_compare_price,
              COALESCE(SUM(pv.stock_qty), 0)      AS total_stock
       FROM products p
       LEFT JOIN product_images pi  ON pi.product_id = p.id AND pi.is_primary = TRUE
       LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.is_active = TRUE
       WHERE p.category_id = $1 AND p.is_active = TRUE
       GROUP BY p.id, p.name_en, p.name_ta, p.slug, p.is_bestseller, p.is_new, pi.image_url
       ORDER BY p.is_bestseller DESC, p.created_at DESC`,
      [catRes.rows[0].id]
    );

    return res.json({
      success: true,
      category: formatCategory(catRes.rows[0]),
      products: productRes.rows.map(p => ({
        id:              p.id,
        name:            p.name_ta ? `${p.name_en} (${p.name_ta})` : p.name_en,
        nameEn:          p.name_en,
        nameTa:          p.name_ta,
        slug:            p.slug,
        primaryImage:    p.primary_image,
        minPrice:        parseFloat(p.min_price),
        minComparePrice: parseFloat(p.min_compare_price),
        totalStock:      parseInt(p.total_stock),
        inStock:         parseInt(p.total_stock) > 0,
        isBestseller:    p.is_bestseller,
        isNew:           p.is_new
      }))
    });
  } catch (err) {
    console.error("Get category by slug error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/categories
// Create a new category.
// Body: { nameEn, nameTa?, slug, description?, imageUrl?, sortOrder?, isActive? }
// ==================================================================
async function createCategory(req, res) {
  const { nameEn, nameTa, slug, description, imageUrl, sortOrder, isActive } = req.body;

  if (!nameEn || !slug) {
    return res.status(400).json({ success: false, message: "nameEn and slug are required" });
  }

  try {
    // Slug uniqueness check — parameterized
    const dup = await db.query("SELECT id FROM categories WHERE slug = $1", [slug.trim()]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ success: false, message: "A category with this slug already exists" });
    }

    const result = await db.query(
      `INSERT INTO categories (name_en, name_ta, slug, description, image_url, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        nameEn.trim(),
        nameTa   || null,
        slug.trim().toLowerCase(),
        description || null,
        imageUrl    || null,
        sortOrder   ?? 0,
        isActive    ?? true
      ]
    );
    return res.status(201).json({ success: true, message: "Category created", category: formatCategory(result.rows[0]) });
  } catch (err) {
    console.error("Create category error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/categories/:id
// Update a category — any field.
// ==================================================================
async function updateCategory(req, res) {
  const { nameEn, nameTa, slug, description, imageUrl, sortOrder, isActive } = req.body;

  try {
    const existing = await db.query("SELECT id FROM categories WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    // Slug uniqueness (if being changed)
    if (slug) {
      const dup = await db.query(
        "SELECT id FROM categories WHERE slug = $1 AND id != $2",
        [slug.trim(), req.params.id]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ success: false, message: "Slug already used by another category" });
      }
    }

    const result = await db.query(
      `UPDATE categories SET
         name_en     = COALESCE($1, name_en),
         name_ta     = COALESCE($2, name_ta),
         slug        = COALESCE($3, slug),
         description = COALESCE($4, description),
         image_url   = COALESCE($5, image_url),
         sort_order  = COALESCE($6, sort_order),
         is_active   = COALESCE($7, is_active),
         updated_at  = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        nameEn   || null,
        nameTa   || null,
        slug     ? slug.trim().toLowerCase() : null,
        description !== undefined ? description : null,
        imageUrl    !== undefined ? imageUrl    : null,
        sortOrder   !== undefined ? sortOrder   : null,
        isActive    !== undefined ? isActive    : null,
        req.params.id
      ]
    );
    return res.json({ success: true, message: "Category updated", category: formatCategory(result.rows[0]) });
  } catch (err) {
    console.error("Update category error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/categories/:id
// Blocked if any active products use this category.
// ==================================================================
async function deleteCategory(req, res) {
  try {
    const inUse = await db.query(
      "SELECT COUNT(*) AS c FROM products WHERE category_id = $1 AND is_active = TRUE",
      [req.params.id]
    );
    if (parseInt(inUse.rows[0].c) > 0) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete — active products belong to this category. Deactivate them first."
      });
    }
    const result = await db.query("DELETE FROM categories WHERE id = $1 RETURNING id", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }
    return res.json({ success: true, message: "Category deleted" });
  } catch (err) {
    console.error("Delete category error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getAllCategories, getCategoryBySlug, createCategory, updateCategory, deleteCategory };