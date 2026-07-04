const db = require("../config/db.js");
const { uploadToSupabase, deleteFromSupabase } = require("../config/supabase.js");

// Shape for every category response — every column included
function formatCategory(c) {
  return {
    id: c.id,
    nameEn: c.name_en,
    nameTa: c.name_ta,
    // Product card label rule: "English Name (Tamil Name)"
    label: c.name_ta ? `${c.name_en} (${c.name_ta})` : c.name_en,
    slug: c.slug,
    imageUrl: c.image_url,
    sortOrder: c.sort_order,
    isActive: c.is_active,
    createdAt: c.created_at,
    updatedAt: c.updated_at
  };
}

// ==================================================================
// PUBLIC — GET /api/categories
// All active categories ordered by sort_order.
// Used by: Products page sidebar, Home page, Checkout filters.
// ==================================================================
async function getAllCategories(req, res) {
  console.log({ route: "GET /api/categories", status: "fetching active categories" });
  try {
    const result = await db.query(
      `SELECT * FROM categories WHERE is_active = TRUE ORDER BY sort_order ASC, name_en ASC`
    );
    console.log({ route: "GET /api/categories", status: 200, count: result.rows.length });
    return res.json({ success: true, categories: result.rows.map(formatCategory) });
  } catch (err) {
    console.error({ route: "GET /api/categories", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// PUBLIC — GET /api/categories/:slug
// Single category by slug + its active products (lightweight).
// Used by: Category landing page.
// ==================================================================
async function getCategoryBySlug(req, res) {
  const { slug } = req.query;
  console.log({ route: "GET /api/categories/get-by-slug", slug, status: "fetching category by slug" });
  try {
    const catRes = await db.query(
      `SELECT * FROM categories WHERE slug = $1 AND is_active = TRUE`,
      [slug]
    );
    if (catRes.rows.length === 0) {
      console.log({ route: "GET /api/categories/get-by-slug", slug, status: 404, message: "Category not found" });
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const productRes = await db.query(
      `SELECT p.id, p.name_en, p.name_ta, p.slug, p.is_bestseller, p.is_new,
              pi.image_url AS primary_image,
              COALESCE(MIN(pv.price), 0)          AS min_price,
              COALESCE(MIN(pv.compare_price), 0)  AS min_compare_price,
              COALESCE(BOOL_OR(pv.stock_qty > 0), FALSE) AS in_stock
       FROM products p
       LEFT JOIN product_images pi  ON pi.product_id = p.id AND pi.is_primary = TRUE
       LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.is_active = TRUE
       WHERE p.category_id = $1 AND p.is_active = TRUE
       GROUP BY p.id, p.name_en, p.name_ta, p.slug, p.is_bestseller, p.is_new, pi.image_url
       ORDER BY p.is_bestseller DESC, p.created_at DESC`,
      [catRes.rows[0].id]
    );

    console.log({ route: "GET /api/categories/get-by-slug", slug, status: 200, productCount: productRes.rows.length });
    return res.json({
      success: true,
      category: formatCategory(catRes.rows[0]),
      products: productRes.rows.map(p => ({
        id: p.id,
        name: p.name_ta ? `${p.name_en} (${p.name_ta})` : p.name_en,
        nameEn: p.name_en,
        nameTa: p.name_ta,
        slug: p.slug,
        primaryImage: p.primary_image,
        minPrice: parseFloat(p.min_price),
        minComparePrice: parseFloat(p.min_compare_price),
        inStock: p.in_stock,
        isBestseller: p.is_bestseller,
        isNew: p.is_new
      }))
    });
  } catch (err) {
    console.error({ route: "GET /api/categories/get-by-slug", slug, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/categories
// Create a new category.
// Body: { nameEn, nameTa?, slug, description?, imageUrl?, sortOrder?, isActive? }
// ==================================================================
async function createCategory(req, res) {
  let { nameEn, nameTa, slug, description, imageUrl, sortOrder, isActive } = req.body;
  console.log({ route: "POST /api/categories", body: { nameEn, nameTa, slug }, status: "creating category" });

  try {
    if (req.file) {
      imageUrl = await uploadToSupabase(req.file.buffer, req.file.mimetype, req.file.originalname, "category");
    }

    if (!nameEn || !slug) {
      console.log({ route: "POST /api/categories", status: 400, message: "nameEn and slug are required" });
      return res.status(400).json({ success: false, message: "nameEn and slug are required" });
    }

    const dup = await db.query("SELECT id FROM categories WHERE slug = $1", [slug.trim()]);
    if (dup.rows.length > 0) {
      console.log({ route: "POST /api/categories", status: 409, message: "A category with this slug already exists" });
      return res.status(409).json({ success: false, message: "A category with this slug already exists" });
    }

    const result = await db.query(
      `INSERT INTO categories (name_en, name_ta, slug, description, image_url, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        nameEn.trim(),
        nameTa || null,
        slug.trim().toLowerCase(),
        description || null,
        imageUrl || null,
        sortOrder ?? 0,
        isActive ?? true
      ]
    );
    console.log({ route: "POST /api/categories", status: 201, categoryId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Category created", category: formatCategory(result.rows[0]) });
  } catch (err) {
    console.error({ route: "POST /api/categories", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/categories/:id
// Update a category — any field.
// ==================================================================
async function updateCategory(req, res) {
  let { id, nameEn, nameTa, slug, description, imageUrl, sortOrder, isActive } = req.body;
  console.log({ route: "PUT /api/categories/update-category", categoryId: id });

  try {
    const existing = await db.query("SELECT id, image_url FROM categories WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      console.log({ route: "PUT /api/categories/update-category", categoryId: id, status: 404, message: "Category not found" });
      return res.status(404).json({ success: false, message: "Category not found" });
    }
    const oldImageUrl = existing.rows[0].image_url;

    if (req.file) {
      imageUrl = await uploadToSupabase(req.file.buffer, req.file.mimetype, req.file.originalname, "category");
    }

    if (slug) {
      const dup = await db.query(
        "SELECT id FROM categories WHERE slug = $1 AND id != $2",
        [slug.trim(), id]
      );
      if (dup.rows.length > 0) {
        console.log({ route: "PUT /api/categories/update-category", categoryId: id, status: 409, message: "Slug already used by another category" });
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
        nameEn || null,
        nameTa || null,
        slug ? slug.trim().toLowerCase() : null,
        description !== undefined ? description : null,
        imageUrl !== undefined ? imageUrl : null,
        sortOrder !== undefined ? sortOrder : null,
        isActive !== undefined ? isActive : null,
        id
      ]
    );

    if (imageUrl && oldImageUrl && imageUrl !== oldImageUrl) {
      await deleteFromSupabase(oldImageUrl);
    }

    console.log({ route: "PUT /api/categories/update-category", categoryId: id, status: 200 });
    return res.json({ success: true, message: "Category updated", category: formatCategory(result.rows[0]) });
  } catch (err) {
    console.error({ route: "PUT /api/categories/update-category", categoryId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/categories/:id
// Blocked if any active products use this category.
// ==================================================================
async function deleteCategory(req, res) {
  const { id } = req.body;
  console.log({ route: "DELETE /api/categories/delete-category", categoryId: id });
  try {
    const inUse = await db.query(
      "SELECT COUNT(*) AS c FROM products WHERE category_id = $1 AND is_active = TRUE",
      [id]
    );
    if (parseInt(inUse.rows[0].c) > 0) {
      console.log({ route: "DELETE /api/categories/delete-category", categoryId: id, status: 409, message: "Cannot delete — active products belong to this category" });
      return res.status(409).json({
        success: false,
        message: "Cannot delete — active products belong to this category. Deactivate them first."
      });
    }
    const result = await db.query(
      "DELETE FROM categories WHERE id = $1 RETURNING image_url", [id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/categories/delete-category", categoryId: id, status: 404, message: "Category not found" });
      return res.status(404).json({ success: false, message: "Category not found" });
    }
    await deleteFromSupabase(result.rows[0].image_url);
    console.log({ route: "DELETE /api/categories/delete-category", categoryId: id, status: 200 });
    return res.json({ success: true, message: "Category deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/categories/delete-category", categoryId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

async function adminGetAllCategories(req, res) {
  console.log({ route: "GET /api/categories/admin-all", userId: req.user?.id, status: "fetching all categories for admin" });
  try {
    const result = await db.query(
      `SELECT * FROM categories ORDER BY sort_order ASC, name_en ASC`
    );
    console.log({ route: "GET /api/categories/admin-all", userId: req.user?.id, status: 200, count: result.rows.length });
    return res.json({ success: true, categories: result.rows.map(formatCategory) });
  } catch (err) {
    console.error({ route: "GET /api/categories/admin-all", error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getAllCategories,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
  adminGetAllCategories
};