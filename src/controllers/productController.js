const db = require("../config/db.js");

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const num = (v) => parseFloat(v) || 0;

// Full product shape — every column from products + related tables
function formatProduct(p, variants = [], images = [], reviews = []) {
  return {
    id:           p.id,
    // Product card label: "English Name (Tamil Name)"
    name:         p.name_ta ? `${p.name_en} (${p.name_ta})` : p.name_en,
    nameEn:       p.name_en,
    nameTa:       p.name_ta,
    slug:         p.slug,
    description:  p.description,
    howToUse:     p.how_to_use,
    storageTips:  p.storage_tips,
    categoryId:   p.category_id,
    categoryName: p.category_name   || null,
    categorySlug: p.category_slug   || null,
    isBestseller: p.is_bestseller,
    isNew:        p.is_new,
    isActive:     p.is_active,
    // Computed from variants
    minPrice:        num(p.min_price        ?? variants.reduce((m, v) => Math.min(m, v.price), Infinity)),
    minComparePrice: num(p.min_compare_price ?? variants.reduce((m, v) => Math.min(m, v.comparePrice ?? Infinity), Infinity)),
    totalStock:      parseInt(p.total_stock ?? variants.reduce((s, v) => s + v.stockQty, 0)),
    inStock:         (parseInt(p.total_stock ?? variants.reduce((s, v) => s + v.stockQty, 0))) > 0,
    avgRating:    num(p.avg_rating    ?? 0),
    reviewCount:  parseInt(p.review_count ?? 0),
    primaryImage: p.primary_image || (images.find(i => i.isPrimary)?.imageUrl) || null,
    createdAt:    p.created_at,
    updatedAt:    p.updated_at,
    variants,
    images,
    reviews
  };
}

function formatVariant(v) {
  return {
    id:           v.id,
    productId:    v.product_id,
    weightGrams:  v.weight_grams,
    weightLabel:  v.weight_label,
    price:        num(v.price),
    comparePrice: num(v.compare_price),
    stockQty:     parseInt(v.stock_qty),
    isActive:     v.is_active,
    createdAt:    v.created_at,
    updatedAt:    v.updated_at
  };
}

function formatImage(i) {
  return {
    id:        i.id,
    productId: i.product_id,
    imageUrl:  i.image_url,
    sortOrder: i.sort_order,
    isPrimary: i.is_primary,
    createdAt: i.created_at
  };
}

function formatReview(r) {
  return {
    id:         r.id,
    productId:  r.product_id,
    userId:     r.user_id,
    userName:   r.full_name || null,
    rating:     r.rating,
    title:      r.title,
    comment:    r.comment,
    isApproved: r.is_approved,
    isVerified: r.is_verified,
    createdAt:  r.created_at
  };
}

async function fetchVariantsImagesReviews(productId) {
  const [varRes, imgRes, revRes] = await Promise.all([
    db.query(
      `SELECT * FROM product_variants WHERE product_id = $1 ORDER BY weight_grams ASC`,
      [productId]
    ),
    db.query(
      `SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order ASC`,
      [productId]
    ),
    db.query(
      `SELECT pr.*, u.full_name
       FROM product_reviews pr
       LEFT JOIN users u ON u.id = pr.user_id
       WHERE pr.product_id = $1 AND pr.is_approved = TRUE
       ORDER BY pr.created_at DESC`,
      [productId]
    )
  ]);
  return {
    variants: varRes.rows.map(formatVariant),
    images:   imgRes.rows.map(formatImage),
    reviews:  revRes.rows.map(formatReview)
  };
}

// Auto-generate slug from English name
function makeSlug(nameEn) {
  return nameEn.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ==================================================================
// PUBLIC — GET /api/products
// Full product listing with filters. Uses v_products_with_price view.
// Query: ?category=slug  ?search=text  ?sort=popular|newest|
//         price-low-high|price-high-low  ?inStock=true
//         ?isBestseller=true  ?isNew=true  ?page=1  ?limit=12
// ==================================================================
async function getAllProducts(req, res) {
  const page    = Math.max(parseInt(req.query.page)  || 1, 1);
  const limit   = Math.min(parseInt(req.query.limit) || 12, 100);
  const offset  = (page - 1) * limit;
  const search  = req.query.search        || null;
  const catSlug = req.query.category      || null;
  const inStock = req.query.inStock === "true";
  const isBest  = req.query.isBestseller === "true";
  const isNew   = req.query.isNew         === "true";

  const sortMap = {
    "popular":        "avg_rating DESC, review_count DESC",
    "newest":         "created_at DESC",
    "price-low-high": "min_price ASC",
    "price-high-low": "min_price DESC"
  };
  const orderBy = sortMap[req.query.sort] || "avg_rating DESC, review_count DESC";

  try {
    const result = await db.query(
      `SELECT v.*
       FROM v_products_with_price v
       WHERE v.is_active = TRUE
         AND ($1::text IS NULL OR v.category_slug = $1)
         AND ($2::text IS NULL OR
               v.name_en    ILIKE '%' || $2 || '%' OR
               v.name_ta    ILIKE '%' || $2 || '%' OR
               v.description ILIKE '%' || $2 || '%')
         AND (NOT $3 OR v.total_stock > 0)
         AND (NOT $4 OR v.is_bestseller = TRUE)
         AND (NOT $5 OR v.is_new = TRUE)
       ORDER BY ${orderBy}
       LIMIT $6 OFFSET $7`,
      [catSlug, search, inStock, isBest, isNew, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total
       FROM v_products_with_price v
       WHERE v.is_active = TRUE
         AND ($1::text IS NULL OR v.category_slug = $1)
         AND ($2::text IS NULL OR v.name_en ILIKE '%' || $2 || '%' OR v.name_ta ILIKE '%' || $2 || '%')
         AND (NOT $3 OR v.total_stock > 0)
         AND (NOT $4 OR v.is_bestseller = TRUE)
         AND (NOT $5 OR v.is_new = TRUE)`,
      [catSlug, search, inStock, isBest, isNew]
    );

    return res.json({
      success: true,
      pagination: {
        page, limit,
        total:      parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      products: result.rows.map(p => formatProduct(p))
    });
  } catch (err) {
    console.error("Get all products error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// PUBLIC — GET /api/products/:slug
// Single product detail with all variants, images, reviews.
// Used by: Product detail page.
// ==================================================================
async function getProductBySlug(req, res) {
  try {
    const result = await db.query(
      `SELECT v.* FROM v_products_with_price v WHERE v.slug = $1 AND v.is_active = TRUE`,
      [req.params.slug]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const { variants, images, reviews } = await fetchVariantsImagesReviews(result.rows[0].id);
    return res.json({ success: true, product: formatProduct(result.rows[0], variants, images, reviews) });
  } catch (err) {
    console.error("Get product by slug error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/products
// Create product + variants + images in one request.
// Body: { nameEn, nameTa?, slug?, description?, howToUse?,
//         storageTips?, categoryId?, isBestseller?, isNew?,
//         variants: [{ weightGrams, weightLabel, price, comparePrice?, stockQty }],
//         images:   [{ imageUrl, sortOrder?, isPrimary? }] }
// ==================================================================
async function createProduct(req, res) {
  const {
    nameEn, nameTa, slug, description, howToUse,
    storageTips, categoryId, isBestseller, isNew,
    variants = [], images = []
  } = req.body;

  if (!nameEn) {
    return res.status(400).json({ success: false, message: "nameEn is required" });
  }
  if (!variants.length) {
    return res.status(400).json({ success: false, message: "At least one variant is required" });
  }

  const finalSlug = (slug || makeSlug(nameEn));

  try {
    await db.query("BEGIN");

    // Slug uniqueness
    const dup = await db.query("SELECT id FROM products WHERE slug = $1", [finalSlug]);
    if (dup.rows.length > 0) {
      await db.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "A product with this slug already exists" });
    }

    // Insert product
    const prodRes = await db.query(
      `INSERT INTO products
         (name_en, name_ta, slug, description, how_to_use, storage_tips,
          category_id, is_bestseller, is_new, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
       RETURNING *`,
      [
        nameEn.trim(), nameTa || null, finalSlug,
        description || null, howToUse || null, storageTips || null,
        categoryId  || null, isBestseller || false, isNew || false
      ]
    );
    const product = prodRes.rows[0];

    // Insert variants
    for (const v of variants) {
      if (!v.weightLabel || !v.price) continue;
      await db.query(
        `INSERT INTO product_variants
           (product_id, weight_grams, weight_label, price, compare_price, stock_qty, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
        [
          product.id,
          v.weightGrams || 0,
          v.weightLabel,
          v.price,
          v.comparePrice || null,
          v.stockQty     || 0
        ]
      );
    }

    // Insert images
    let hasPrimary = false;
    for (const img of images) {
      if (!img.imageUrl) continue;
      const isPrimary = img.isPrimary && !hasPrimary;
      if (isPrimary) hasPrimary = true;
      await db.query(
        `INSERT INTO product_images (product_id, image_url, sort_order, is_primary)
         VALUES ($1,$2,$3,$4)`,
        [product.id, img.imageUrl, img.sortOrder || 0, isPrimary]
      );
    }
    // If no image marked primary, mark the first one
    if (images.length > 0 && !hasPrimary) {
      await db.query(
        `UPDATE product_images SET is_primary = TRUE
         WHERE product_id = $1 AND sort_order = (SELECT MIN(sort_order) FROM product_images WHERE product_id = $1)`,
        [product.id]
      );
    }

    await db.query("COMMIT");

    const { variants: v, images: i, reviews: r } = await fetchVariantsImagesReviews(product.id);
    return res.status(201).json({ success: true, message: "Product created", product: formatProduct(product, v, i, r) });
  } catch (err) {
    await db.query("ROLLBACK");
    console.error("Create product error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/products/:id
// Update product core fields only. Variants/images managed separately.
// ==================================================================
async function updateProduct(req, res) {
  const {
    nameEn, nameTa, slug, description, howToUse,
    storageTips, categoryId, isBestseller, isNew, isActive
  } = req.body;

  try {
    const existing = await db.query("SELECT id FROM products WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    if (slug) {
      const dup = await db.query(
        "SELECT id FROM products WHERE slug = $1 AND id != $2",
        [slug.trim(), req.params.id]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ success: false, message: "Slug already used by another product" });
      }
    }

    const result = await db.query(
      `UPDATE products SET
         name_en      = COALESCE($1, name_en),
         name_ta      = COALESCE($2, name_ta),
         slug         = COALESCE($3, slug),
         description  = COALESCE($4, description),
         how_to_use   = COALESCE($5, how_to_use),
         storage_tips = COALESCE($6, storage_tips),
         category_id  = COALESCE($7, category_id),
         is_bestseller= COALESCE($8, is_bestseller),
         is_new       = COALESCE($9, is_new),
         is_active    = COALESCE($10, is_active),
         updated_at   = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        nameEn   || null,
        nameTa   !== undefined ? nameTa   : null,
        slug     ? slug.trim() : null,
        description  !== undefined ? description  : null,
        howToUse     !== undefined ? howToUse     : null,
        storageTips  !== undefined ? storageTips  : null,
        categoryId   !== undefined ? categoryId   : null,
        isBestseller !== undefined ? isBestseller : null,
        isNew        !== undefined ? isNew        : null,
        isActive     !== undefined ? isActive     : null,
        req.params.id
      ]
    );
    const { variants, images, reviews } = await fetchVariantsImagesReviews(req.params.id);
    return res.json({ success: true, message: "Product updated", product: formatProduct(result.rows[0], variants, images, reviews) });
  } catch (err) {
    console.error("Update product error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/:id
// Soft-delete: set is_active = FALSE (preserves order history).
// ==================================================================
async function deleteProduct(req, res) {
  try {
    const result = await db.query(
      "UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    return res.json({ success: true, message: "Product deactivated (soft delete — order history preserved)" });
  } catch (err) {
    console.error("Delete product error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/products/:id/variants
// Add a variant to an existing product.
// ==================================================================
async function addVariant(req, res) {
  const { weightGrams, weightLabel, price, comparePrice, stockQty } = req.body;
  if (!weightLabel || !price) {
    return res.status(400).json({ success: false, message: "weightLabel and price are required" });
  }
  try {
    const result = await db.query(
      `INSERT INTO product_variants
         (product_id, weight_grams, weight_label, price, compare_price, stock_qty, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE)
       RETURNING *`,
      [req.params.id, weightGrams || 0, weightLabel, price, comparePrice || null, stockQty || 0]
    );
    return res.status(201).json({ success: true, message: "Variant added", variant: formatVariant(result.rows[0]) });
  } catch (err) {
    console.error("Add variant error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/products/:id/variants/:variantId
// Update price / stock / comparePrice / isActive on a variant.
// ==================================================================
async function updateVariant(req, res) {
  const { weightGrams, weightLabel, price, comparePrice, stockQty, isActive } = req.body;
  try {
    const result = await db.query(
      `UPDATE product_variants SET
         weight_grams  = COALESCE($1, weight_grams),
         weight_label  = COALESCE($2, weight_label),
         price         = COALESCE($3, price),
         compare_price = COALESCE($4, compare_price),
         stock_qty     = COALESCE($5, stock_qty),
         is_active     = COALESCE($6, is_active),
         updated_at    = NOW()
       WHERE id = $7 AND product_id = $8
       RETURNING *`,
      [
        weightGrams  !== undefined ? weightGrams  : null,
        weightLabel  || null,
        price        !== undefined ? price        : null,
        comparePrice !== undefined ? comparePrice : null,
        stockQty     !== undefined ? stockQty     : null,
        isActive     !== undefined ? isActive     : null,
        req.params.variantId,
        req.params.id
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }
    return res.json({ success: true, message: "Variant updated", variant: formatVariant(result.rows[0]) });
  } catch (err) {
    console.error("Update variant error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/:id/variants/:variantId
// ==================================================================
async function deleteVariant(req, res) {
  try {
    const result = await db.query(
      "DELETE FROM product_variants WHERE id = $1 AND product_id = $2 RETURNING id",
      [req.params.variantId, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }
    return res.json({ success: true, message: "Variant deleted" });
  } catch (err) {
    console.error("Delete variant error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/products/:id/images
// Add image(s) to a product.
// ==================================================================
async function addImage(req, res) {
  const { imageUrl, sortOrder, isPrimary } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ success: false, message: "imageUrl is required" });
  }
  try {
    // If marking as primary, clear current primary first
    if (isPrimary) {
      await db.query(
        "UPDATE product_images SET is_primary = FALSE WHERE product_id = $1",
        [req.params.id]
      );
    }
    const result = await db.query(
      `INSERT INTO product_images (product_id, image_url, sort_order, is_primary)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, imageUrl, sortOrder || 0, isPrimary || false]
    );
    return res.status(201).json({ success: true, message: "Image added", image: formatImage(result.rows[0]) });
  } catch (err) {
    console.error("Add image error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/:id/images/:imageId
// ==================================================================
async function deleteImage(req, res) {
  try {
    const result = await db.query(
      "DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING id",
      [req.params.imageId, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Image not found" });
    }
    return res.json({ success: true, message: "Image deleted" });
  } catch (err) {
    console.error("Delete image error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// CUSTOMER — POST /api/products/:id/reviews   (login required)
// Submit a review. One review per product per user.
// ==================================================================
async function addReview(req, res) {
  const { rating, title, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ success: false, message: "rating must be between 1 and 5" });
  }
  try {
    // Duplicate check
    const dup = await db.query(
      "SELECT id FROM product_reviews WHERE product_id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ success: false, message: "You have already reviewed this product" });
    }
    // Check if verified purchase
    const purchase = await db.query(
      `SELECT oi.id FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.product_id = $1 AND o.user_id = $2 AND o.status = 'delivered'
       LIMIT 1`,
      [req.params.id, req.user.id]
    );
    const isVerified = purchase.rows.length > 0;

    const result = await db.query(
      `INSERT INTO product_reviews
         (product_id, user_id, rating, title, comment, is_approved, is_verified)
       VALUES ($1,$2,$3,$4,$5,TRUE,$6)
       RETURNING *`,
      [req.params.id, req.user.id, rating, title || null, comment || null, isVerified]
    );
    return res.status(201).json({ success: true, message: "Review submitted", review: formatReview(result.rows[0]) });
  } catch (err) {
    console.error("Add review error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/:id/reviews/:reviewId
// ==================================================================
async function deleteReview(req, res) {
  try {
    const result = await db.query(
      "DELETE FROM product_reviews WHERE id = $1 AND product_id = $2 RETURNING id",
      [req.params.reviewId, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Review not found" });
    }
    return res.json({ success: true, message: "Review deleted" });
  } catch (err) {
    console.error("Delete review error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getAllProducts, getProductBySlug,
  createProduct, updateProduct, deleteProduct,
  addVariant, updateVariant, deleteVariant,
  addImage, deleteImage,
  addReview, deleteReview
};