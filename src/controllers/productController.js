const db = require("../config/db.js");

const log = (data) => console.log(data);
const lerr = (data) => console.error(data);

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const num = (v) => parseFloat(v) || 0;

// Full product shape — every column from products + related tables
function formatProduct(p, variants = [], images = [], reviews = []) {
  return {
    id: p.id,
    // Product card label: "English Name (Tamil Name)"
    name: p.name_ta ? `${p.name_en} (${p.name_ta})` : p.name_en,
    nameEn: p.name_en,
    nameTa: p.name_ta,
    slug: p.slug,
    description: p.description,
    howToUse: p.how_to_use,
    storageTips: p.storage_tips,
    categoryId: p.category_id,
    categoryName: p.category_name || null,
    categorySlug: p.category_slug || null,
    isBestseller: p.is_bestseller,
    isNew: p.is_new,
    isActive: p.is_active,
    // Computed from variants
    minPrice: num(p.min_price ?? variants.reduce((m, v) => Math.min(m, v.price), Infinity)),
    minComparePrice: num(p.min_compare_price ?? variants.reduce((m, v) => Math.min(m, v.comparePrice ?? Infinity), Infinity)),
    totalStock: parseInt(p.total_stock ?? variants.reduce((s, v) => s + v.stockQty, 0)),
    inStock: (parseInt(p.total_stock ?? variants.reduce((s, v) => s + v.stockQty, 0))) > 0,
    avgRating: num(p.avg_rating ?? 0),
    reviewCount: parseInt(p.review_count ?? 0),
    primaryImage: p.primary_image || (images.find(i => i.isPrimary)?.imageUrl) || null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    variants,
    images,
    reviews
  };
}

function formatVariant(v) {
  return {
    id: v.id,
    productId: v.product_id,
    weightGrams: v.weight_grams,
    weightLabel: v.weight_label,
    price: num(v.price),
    comparePrice: num(v.compare_price),
    stockQty: parseInt(v.stock_qty),
    isActive: v.is_active,
    createdAt: v.created_at,
    updatedAt: v.updated_at
  };
}

function formatImage(i) {
  return {
    id: i.id,
    productId: i.product_id,
    imageUrl: i.image_url,
    sortOrder: i.sort_order,
    isPrimary: i.is_primary,
    createdAt: i.created_at
  };
}

function formatReview(r) {
  return {
    id: r.id,
    productId: r.product_id,
    userId: r.user_id,
    userName: r.full_name || null,
    rating: r.rating,
    title: r.title,
    comment: r.comment,
    isApproved: r.is_approved,
    isVerified: r.is_verified,
    createdAt: r.created_at
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
    images: imgRes.rows.map(formatImage),
    reviews: revRes.rows.map(formatReview)
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
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 12, 100);
  const offset = (page - 1) * limit;
  const search = req.query.search || null;
  const catSlug = req.query.category || null;
  const inStock = req.query.inStock === "true";
  const isBest = req.query.isBestseller === "true";
  const isNew = req.query.isNew === "true";
  log({ route: "GET /api/products", query: { page, limit, search, category: catSlug, inStock, isBestseller: isBest, isNew }, status: "fetching products" });

  const sortMap = {
    "popular": "avg_rating DESC, review_count DESC",
    "newest": "created_at DESC",
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

    log({ route: "GET /api/products", status: 200, count: result.rows.length });

    let variantsByProduct = {};
    if (result.rows.length > 0) {
      const productIds = result.rows.map(r => r.id);
      const varRes = await db.query(
        `SELECT * FROM product_variants WHERE product_id = ANY($1) AND is_active = TRUE ORDER BY weight_grams ASC`,
        [productIds]
      );
      varRes.rows.forEach(v => {
        const pid = v.product_id;
        if (!variantsByProduct[pid]) variantsByProduct[pid] = [];
        variantsByProduct[pid].push(formatVariant(v));
      });
    }

    return res.json({
      success: true,
      pagination: {
        page, limit,
        total: parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      products: result.rows.map(p => formatProduct(p, variantsByProduct[p.id] || []))
    });
  } catch (err) {
    lerr({ route: "GET /api/products", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// PUBLIC — GET /api/products/:slug
// Single product detail with all variants, images, reviews.
// Used by: Product detail page.
// ==================================================================
async function getProductBySlug(req, res) {
  const { slug } = req.query;
  log({ route: "GET /api/products/get-by-slug", slug, status: "fetching product by slug" });
  try {
    const result = await db.query(
      `SELECT v.* FROM v_products_with_price v WHERE v.slug = $1 AND v.is_active = TRUE`,
      [slug]
    );
    if (result.rows.length === 0) {
      log({ route: "GET /api/products/get-by-slug", slug, status: 404, message: "Product not found" });
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const { variants, images, reviews } = await fetchVariantsImagesReviews(result.rows[0].id);
    log({ route: "GET /api/products/get-by-slug", slug, status: 200 });
    return res.json({ success: true, product: formatProduct(result.rows[0], variants, images, reviews) });
  } catch (err) {
    lerr({ route: "GET /api/products/get-by-slug", slug, status: 500, error: err.message });
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
  log({ route: "POST /api/products", body: { nameEn, nameTa, slug, categoryId, isBestseller, isNew, variantsCount: variants?.length, imagesCount: images?.length }, status: "creating product" });

  if (!nameEn) {
    log({ route: "POST /api/products", status: 400, message: "nameEn is required" });
    return res.status(400).json({ success: false, message: "nameEn is required" });
  }
  if (!variants.length) {
    log({ route: "POST /api/products", status: 400, message: "variants are required" });
    return res.status(400).json({ success: false, message: "At least one variant is required" });
  }

  const finalSlug = (slug || makeSlug(nameEn));

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    // Slug uniqueness
    const dup = await client.query("SELECT id FROM products WHERE slug = $1", [finalSlug]);
    if (dup.rows.length > 0) {
      const e = new Error("A product with this slug already exists"); e.status = 409; throw e;
    }

    // Insert product
    const prodRes = await client.query(
      `INSERT INTO products
         (name_en, name_ta, slug, description, how_to_use, storage_tips,
          category_id, is_bestseller, is_new, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
       RETURNING *`,
      [
        nameEn.trim(), nameTa || null, finalSlug,
        description || null, howToUse || null, storageTips || null,
        categoryId || null, isBestseller || false, isNew || false
      ]
    );
    const product = prodRes.rows[0];

    // Insert variants
    for (const v of variants) {
      if (!v.weightLabel || !v.price) continue;
      await client.query(
        `INSERT INTO product_variants
           (product_id, weight_grams, weight_label, price, compare_price, stock_qty, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
        [product.id, v.weightGrams || 0, v.weightLabel, v.price, v.comparePrice || null, v.stockQty || 0]
      );
    }

    // Insert images
    let hasPrimary = false;
    for (const img of images) {
      if (!img.imageUrl) continue;
      const isPrimary = img.isPrimary && !hasPrimary;
      if (isPrimary) hasPrimary = true;
      await client.query(
        `INSERT INTO product_images (product_id, image_url, sort_order, is_primary)
         VALUES ($1,$2,$3,$4)`,
        [product.id, img.imageUrl, img.sortOrder || 0, isPrimary]
      );
    }
    // If no image marked primary, mark the first one
    if (images.length > 0 && !hasPrimary) {
      await client.query(
        `UPDATE product_images SET is_primary = TRUE
         WHERE product_id = $1 AND sort_order = (SELECT MIN(sort_order) FROM product_images WHERE product_id = $1)`,
        [product.id]
      );
    }

    await client.query("COMMIT");

    const { variants: v, images: i, reviews: r } = await fetchVariantsImagesReviews(product.id);
    log({ route: "POST /api/products", status: 201, productId: product.id });
    return res.status(201).json({ success: true, message: "Product created", product: formatProduct(product, v, i, r) });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      log({ route: "POST /api/products", status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    lerr({ route: "POST /api/products", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// ADMIN — PUT /api/products/:id
// Update product core fields only. Variants/images managed separately.
// ==================================================================
async function updateProduct(req, res) {
  const {
    id, nameEn, nameTa, slug, description, howToUse,
    storageTips, categoryId, isBestseller, isNew, isActive
  } = req.body;
  log({ route: "PUT /api/products/update-product", productId: id, body: { nameEn, nameTa, slug, categoryId, isBestseller, isNew, isActive }, status: "updating product" });

  try {
    const existing = await db.query("SELECT id FROM products WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      log({ route: "PUT /api/products/update-product", productId: id, status: 404, message: "Product not found" });
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    if (slug) {
      const dup = await db.query(
        "SELECT id FROM products WHERE slug = $1 AND id != $2",
        [slug.trim(), id]
      );
      if (dup.rows.length > 0) {
        log({ route: "PUT /api/products/update-product", productId: id, status: 409, message: "slug already exists" });
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
        nameEn || null,
        nameTa !== undefined ? nameTa : null,
        slug ? slug.trim() : null,
        description !== undefined ? description : null,
        howToUse !== undefined ? howToUse : null,
        storageTips !== undefined ? storageTips : null,
        categoryId !== undefined ? categoryId : null,
        isBestseller !== undefined ? isBestseller : null,
        isNew !== undefined ? isNew : null,
        isActive !== undefined ? isActive : null,
        id
      ]
    );
    const { variants, images, reviews } = await fetchVariantsImagesReviews(id);
    log({ route: "PUT /api/products/update-product", productId: id, status: 200 });
    return res.json({ success: true, message: "Product updated", product: formatProduct(result.rows[0], variants, images, reviews) });
  } catch (err) {
    lerr({ route: "PUT /api/products/update-product", productId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/:id
// Soft-delete: set is_active = FALSE (preserves order history).
// ==================================================================
async function deleteProduct(req, res) {
  const { id } = req.body;
  log({ route: "DELETE /api/products/delete-product", productId: id, status: "deactivating product" });
  try {
    const result = await db.query(
      "UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rows.length === 0) {
      log({ route: "DELETE /api/products/delete-product", productId: id, status: 404, message: "Product not found" });
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    log({ route: "DELETE /api/products/delete-product", productId: id, status: 200 });
    return res.json({ success: true, message: "Product deactivated (soft delete — order history preserved)" });
  } catch (err) {
    lerr({ route: "DELETE /api/products/delete-product", productId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/products/:id/variants
// Add a variant to an existing product.
// ==================================================================
async function addVariant(req, res) {
  const { productId: id, weightGrams, weightLabel, price, comparePrice, stockQty } = req.body;
  log({ route: "POST /api/products/add-variant", productId: id, body: { weightGrams, weightLabel, price, comparePrice, stockQty }, status: "adding variant" });

  if (!weightLabel || !price) {
    log({ route: "POST /api/products/add-variant", productId: id, status: 400, message: "missing fields" });
    return res.status(400).json({ success: false, message: "weightLabel and price are required" });
  }
  try {
    const result = await db.query(
      `INSERT INTO product_variants
         (product_id, weight_grams, weight_label, price, compare_price, stock_qty, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE)
       RETURNING *`,
      [id, weightGrams || 0, weightLabel, price, comparePrice || null, stockQty || 0]
    );
    log({ route: "POST /api/products/add-variant", productId: id, status: 201, variantId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Variant added", variant: formatVariant(result.rows[0]) });
  } catch (err) {
    lerr({ route: "POST /api/products/add-variant", productId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/products/:id/variants/:variantId
// Update price / stock / comparePrice / isActive on a variant.
// ==================================================================
async function updateVariant(req, res) {
  const { productId: id, variantId, weightGrams, weightLabel, price, comparePrice, stockQty, isActive } = req.body;
  log({ route: "PUT /api/products/update-variant", productId: id, variantId, body: { weightGrams, weightLabel, price, comparePrice, stockQty, isActive }, status: "updating variant" });

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
        weightGrams !== undefined ? weightGrams : null,
        weightLabel || null,
        price !== undefined ? price : null,
        comparePrice !== undefined ? comparePrice : null,
        stockQty !== undefined ? stockQty : null,
        isActive !== undefined ? isActive : null,
        variantId,
        id
      ]
    );
    if (result.rows.length === 0) {
      log({ route: "PUT /api/products/update-variant", productId: id, variantId, status: 404, message: "Variant not found" });
      return res.status(404).json({ success: false, message: "Variant not found" });
    }
    log({ route: "PUT /api/products/update-variant", productId: id, variantId, status: 200 });
    return res.json({ success: true, message: "Variant updated", variant: formatVariant(result.rows[0]) });
  } catch (err) {
    lerr({ route: "PUT /api/products/update-variant", productId: id, variantId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/:id/variants/:variantId
// ==================================================================
async function deleteVariant(req, res) {
  const { productId: id, variantId } = req.body;
  log({ route: "DELETE /api/products/delete-variant", productId: id, variantId, status: "deleting variant" });
  try {
    const result = await db.query(
      "DELETE FROM product_variants WHERE id = $1 AND product_id = $2 RETURNING id",
      [variantId, id]
    );
    if (result.rows.length === 0) {
      log({ route: "DELETE /api/products/delete-variant", productId: id, variantId, status: 404, message: "Variant not found" });
      return res.status(404).json({ success: false, message: "Variant not found" });
    }
    log({ route: "DELETE /api/products/delete-variant", productId: id, variantId, status: 200 });
    return res.json({ success: true, message: "Variant deleted" });
  } catch (err) {
    lerr({ route: "DELETE /api/products/delete-variant", productId: id, variantId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/products/:id/images
// Add image(s) to a product.
// ==================================================================
async function addImage(req, res) {
  const { productId: id, imageUrl, sortOrder, isPrimary } = req.body;
  log({ route: "POST /api/products/add-image", productId: id, body: { imageUrl, sortOrder, isPrimary }, status: "adding image" });

  if (!imageUrl) {
    log({ route: "POST /api/products/add-image", productId: id, status: 400, message: "imageUrl is required" });
    return res.status(400).json({ success: false, message: "imageUrl is required" });
  }
  try {
    // If marking as primary, clear current primary first
    if (isPrimary) {
      await db.query(
        "UPDATE product_images SET is_primary = FALSE WHERE product_id = $1",
        [id]
      );
    }
    const result = await db.query(
      `INSERT INTO product_images (product_id, image_url, sort_order, is_primary)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, imageUrl, sortOrder || 0, isPrimary || false]
    );
    log({ route: "POST /api/products/add-image", productId: id, status: 201, imageId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Image added", image: formatImage(result.rows[0]) });
  } catch (err) {
    lerr({ route: "POST /api/products/add-image", productId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/:id/images/:imageId
// ==================================================================
async function deleteImage(req, res) {
  const { productId: id, imageId } = req.body;
  log({ route: "DELETE /api/products/delete-image", productId: id, imageId, status: "deleting image" });
  try {
    const result = await db.query(
      "DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING id",
      [imageId, id]
    );
    if (result.rows.length === 0) {
      log({ route: "DELETE /api/products/delete-image", productId: id, imageId, status: 404, message: "Image not found" });
      return res.status(404).json({ success: false, message: "Image not found" });
    }
    log({ route: "DELETE /api/products/delete-image", productId: id, imageId, status: 200 });
    return res.json({ success: true, message: "Image deleted" });
  } catch (err) {
    lerr({ route: "DELETE /api/products/delete-image", productId: id, imageId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// CUSTOMER — POST /api/products/:id/reviews   (login required)
// Submit a review. One review per product per user.
// ==================================================================
async function addReview(req, res) {
  const { productId: id, rating, title, comment } = req.body;
  log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, body: { rating, title }, status: "submitting review" });

  if (!rating || rating < 1 || rating > 5) {
    log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 400, message: "invalid rating" });
    return res.status(400).json({ success: false, message: "rating must be between 1 and 5" });
  }
  try {
    // Duplicate check
    const dup = await db.query(
      "SELECT id FROM product_reviews WHERE product_id = $1 AND user_id = $2",
      [id, req.user.id]
    );
    if (dup.rows.length > 0) {
      log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 409, message: "already reviewed" });
      return res.status(409).json({ success: false, message: "You have already reviewed this product" });
    }
    // Check if verified purchase
    const purchase = await db.query(
      `SELECT oi.id FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.product_id = $1 AND o.user_id = $2 AND o.status = 'delivered'
       LIMIT 1`,
      [id, req.user.id]
    );
    const isVerified = purchase.rows.length > 0;

    const result = await db.query(
      `INSERT INTO product_reviews
         (product_id, user_id, rating, title, comment, is_approved, is_verified)
       VALUES ($1,$2,$3,$4,$5,TRUE,$6)
       RETURNING *`,
      [id, req.user.id, rating, title || null, comment || null, isVerified]
    );
    log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 201, reviewId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Review submitted", review: formatReview(result.rows[0]) });
  } catch (err) {
    lerr({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/:id/reviews/:reviewId
// ==================================================================
async function deleteReview(req, res) {
  const { productId: id, reviewId } = req.body;
  log({ route: "DELETE /api/products/delete-review", productId: id, reviewId, status: "deleting review" });
  try {
    const result = await db.query(
      "DELETE FROM product_reviews WHERE id = $1 AND product_id = $2 RETURNING id",
      [reviewId, id]
    );
    if (result.rows.length === 0) {
      log({ route: "DELETE /api/products/delete-review", productId: id, reviewId, status: 404, message: "Review not found" });
      return res.status(404).json({ success: false, message: "Review not found" });
    }
    log({ route: "DELETE /api/products/delete-review", productId: id, reviewId, status: 200 });
    return res.json({ success: true, message: "Review deleted" });
  } catch (err) {
    lerr({ route: "DELETE /api/products/delete-review", productId: id, reviewId, status: 500, error: err.message });
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