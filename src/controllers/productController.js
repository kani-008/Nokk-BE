const db = require("../config/db.js");
const { uploadToSupabase, deleteFromSupabase } = require("../config/supabase.js");
const { fetchReviewsForProduct } = require("./reviewController.js");

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const num = (v) => parseFloat(v) || 0;
const isTrue = (val) => val === true || val === "true" || val === 1 || val === "1" || val === "yes";

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
    minPrice: num(p.min_price ?? (variants.length ? Math.min(...variants.map(v => v.price)) : Infinity)),
    minComparePrice: num(p.min_compare_price ?? (variants.length ? Math.min(...variants.map(v => v.comparePrice || Infinity)) : Infinity)),
    inStock: p.in_stock !== undefined
      ? p.in_stock
      : (p.total_stock !== undefined
          ? parseInt(p.total_stock) > 0
          : (variants.length > 0 ? variants.some(v => v.inStock) : false)),
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
    // Customer-facing UI should only ever read this boolean, never
    // stockQty directly — keeps the "no exact numbers" rule enforced
    // at the API boundary, not just by convention in each component.
    inStock: parseInt(v.stock_qty) > 0,
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

async function fetchVariantsImagesReviews(productId) {
  try {
    const [varRes, imgRes, reviews] = await Promise.all([
      db.query(
        `SELECT * FROM product_variants WHERE product_id = $1 ORDER BY weight_grams ASC`,
        [productId]
      ).catch(err => {
        const dbErr = new Error(`Database error fetching product variants for product ${productId}: ${err.message}`);
        dbErr.status = 500;
        throw dbErr;
      }),
      db.query(
        `SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order ASC`,
        [productId]
      ).catch(err => {
        const dbErr = new Error(`Database error fetching product images for product ${productId}: ${err.message}`);
        dbErr.status = 500;
        throw dbErr;
      }),
      fetchReviewsForProduct(productId).catch(err => {
        const dbErr = new Error(`Database error fetching reviews for product ${productId}: ${err.message}`);
        dbErr.status = 500;
        throw dbErr;
      })
    ]);

    return {
      variants: varRes.rows.map(formatVariant),
      images: imgRes.rows.map(formatImage),
      reviews
    };
  } catch (err) {
    console.error(`[fetchVariantsImagesReviews] error: ${err.message}`);
    throw err;
  }
}

// Auto-generate slug from English name
function makeSlug(nameEn) {
  return nameEn.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ==================================================================
// PUBLIC — GET /api/products/get-all
// Full product listing with server-side filters. Uses v_products_with_price.
// Query: ?category=slug  ?search=text  ?sort=popular|newest|
//         price-low-high|price-high-low  ?inStock=true
//         ?isBestseller=true  ?isNew=true  ?minPrice=num  ?maxPrice=num
//         ?rating=num  ?hasOffer=true  ?weight=100g,250g  ?page=1  ?limit=12
// ==================================================================
async function getAllProducts(req, res) {
  const page     = Math.max(parseInt(req.query.page) || 1, 1);
  const limit    = Math.min(parseInt(req.query.limit) || 12, 100);
  const offset   = (page - 1) * limit;
  const search   = req.query.search   || null;
  const catSlug  = req.query.category || null;
  const inStock  = req.query.inStock      === "true";
  const isBest   = req.query.isBestseller === "true";
  const isNew    = req.query.isNew        === "true";
  const hasOffer = req.query.hasOffer     === "true";
  const minPrice = req.query.minPrice ? parseFloat(req.query.minPrice) : null;
  const maxPrice = req.query.maxPrice ? parseFloat(req.query.maxPrice) : null;
  const minRating = req.query.rating ? parseFloat(req.query.rating) : null;
  const weightLabels = req.query.weight
    ? req.query.weight.split(",").filter(Boolean)
    : null;

  const ids = req.query.ids
    ? req.query.ids.split(",").map(id => id.trim()).filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    : null;

  const sortMap = {
    "popular":        "v.avg_rating DESC, v.review_count DESC",
    "newest":         "v.created_at DESC",
    "price-low-high": weightLabels && weightLabels.length > 0
      ? "(SELECT MIN(pv.price) FROM product_variants pv WHERE pv.product_id = v.id AND pv.is_active = TRUE AND pv.weight_label = ANY($10)) ASC"
      : "v.min_price ASC",
    "price-high-low": weightLabels && weightLabels.length > 0
      ? "(SELECT MIN(pv.price) FROM product_variants pv WHERE pv.product_id = v.id AND pv.is_active = TRUE AND pv.weight_label = ANY($10)) DESC"
      : "v.min_price DESC"
  };
  const orderBy = sortMap[req.query.sort] || "v.avg_rating DESC, v.review_count DESC";

  // Shared WHERE params: $1…$11
  const baseParams = [
    catSlug,      // $1
    search,       // $2
    inStock,      // $3
    isBest,       // $4
    isNew,        // $5
    minPrice,     // $6
    maxPrice,     // $7
    minRating,    // $8
    hasOffer,     // $9
    weightLabels, // $10  (null or string[])
    ids,          // $11  (null or integer[])
  ];

  const whereClause = `
    v.is_active = TRUE
    AND ($1::text    IS NULL OR v.category_slug = $1)
    AND ($2::text    IS NULL OR
          v.name_en    ILIKE '%' || $2 || '%' OR
          v.name_ta    ILIKE '%' || $2 || '%' OR
          v.description ILIKE '%' || $2 || '%')
    AND (NOT $3 OR v.total_stock > 0)
    AND (NOT $4 OR v.is_bestseller = TRUE)
    AND (NOT $5 OR v.is_new = TRUE)
    AND ($6::numeric IS NULL OR v.min_price >= $6)
    AND ($7::numeric IS NULL OR v.min_price <= $7)
    AND ($8::numeric IS NULL OR v.avg_rating >= $8)
    AND (NOT $9 OR EXISTS (
          SELECT 1 FROM product_variants pv
          WHERE pv.product_id = v.id
            AND pv.is_active = TRUE
            AND pv.compare_price > pv.price
        ))
    AND ($10::text[] IS NULL OR EXISTS (
          SELECT 1 FROM product_variants pv
          WHERE pv.product_id = v.id
            AND pv.is_active = TRUE
            AND pv.weight_label = ANY($10)
        ))
    AND ($11::uuid[] IS NULL OR v.id = ANY($11::uuid[]))
  `;

  console.log({
    route: "GET /api/products",
    query: { page, limit, search, category: catSlug, inStock, isBest, isNew, hasOffer, minPrice, maxPrice, minRating, weightLabels, ids },
    status: "fetching products"
  });

  try {
    const result = await db.query(
      `SELECT v.*
       FROM v_products_with_price v
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $12 OFFSET $13`,
      [...baseParams, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total
       FROM v_products_with_price v
       WHERE ${whereClause}`,
      baseParams
    );

    console.log({ route: "GET /api/products", status: 200, count: result.rows.length });

    let variantsByProduct = {};
    let imagesByProduct   = {};
    if (result.rows.length > 0) {
      const productIds = result.rows.map(r => r.id);
      const [varRes, imgRes] = await Promise.all([
        db.query(
          `SELECT * FROM product_variants WHERE product_id = ANY($1) AND is_active = TRUE ORDER BY weight_grams ASC`,
          [productIds]
        ).catch(err => {
          const dbErr = new Error(`Database error fetching product variants: ${err.message}`);
          dbErr.status = 500;
          throw dbErr;
        }),
        db.query(
          `SELECT * FROM product_images WHERE product_id = ANY($1) ORDER BY sort_order ASC`,
          [productIds]
        ).catch(err => {
          const dbErr = new Error(`Database error fetching product images: ${err.message}`);
          dbErr.status = 500;
          throw dbErr;
        })
      ]);

      varRes.rows.forEach(v => {
        const pid = v.product_id;
        if (!variantsByProduct[pid]) variantsByProduct[pid] = [];
        variantsByProduct[pid].push(formatVariant(v));
      });

      imgRes.rows.forEach(i => {
        const pid = i.product_id;
        if (!imagesByProduct[pid]) imagesByProduct[pid] = [];
        imagesByProduct[pid].push(formatImage(i));
      });
    }

    return res.json({
      success: true,
      pagination: {
        page, limit,
        total:      parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      products: result.rows.map(p =>
        formatProduct(p, variantsByProduct[p.id] || [], imagesByProduct[p.id] || [])
      )
    });
  } catch (err) {
    const statusCode = err.status || 500;
    console.error({ route: "GET /api/products", status: statusCode, error: err.message });
    const clientMsg = statusCode === 500 ? "Internal server error" : (err.message || "Internal server error");
    return res.status(statusCode).json({ success: false, message: clientMsg });
  }
}

// ==================================================================
// PUBLIC — GET /api/products/weight-labels
// Returns all distinct weight labels available across active variants.
// Used by the Products page sidebar filter.
// ==================================================================
async function getWeightLabels(req, res) {
  try {
    const result = await db.query(
      `SELECT DISTINCT weight_label
       FROM product_variants
       WHERE is_active = TRUE
         AND weight_label IS NOT NULL
         AND weight_label <> ''
       ORDER BY weight_label`
    );
    return res.json({
      success: true,
      weightLabels: result.rows.map(r => r.weight_label)
    });
  } catch (err) {
    console.error({ route: "GET /api/products/weight-labels", error: err.message });
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
  console.log({ route: "GET /api/products/get-by-slug", slug, status: "fetching product by slug" });
  try {
    const result = await db.query(
      `SELECT v.* FROM v_products_with_price v WHERE v.slug = $1 AND v.is_active = TRUE`,
      [slug]
    );
    if (result.rows.length === 0) {
      console.log({ route: "GET /api/products/get-by-slug", slug, status: 404, message: "Product not found" });
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const { variants, images, reviews } = await fetchVariantsImagesReviews(result.rows[0].id);
    console.log({ route: "GET /api/products/get-by-slug", slug, status: 200 });
    return res.json({ success: true, product: formatProduct(result.rows[0], variants, images, reviews) });
  } catch (err) {
    console.error({ route: "GET /api/products/get-by-slug", slug, status: 500, error: err.message });
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
  console.log({ route: "POST /api/products", body: { nameEn, nameTa, slug, categoryId, isBestseller, isNew, variantsCount: variants?.length, imagesCount: images?.length }, status: "creating product" });

  if (!nameEn) {
    console.log({ route: "POST /api/products", status: 400, message: "nameEn is required" });
    return res.status(400).json({ success: false, message: "nameEn is required" });
  }
  if (!variants.length) {
    console.log({ route: "POST /api/products", status: 400, message: "variants are required" });
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
      const stockVal = v.inStock !== undefined ? (isTrue(v.inStock) ? 1 : 0) : (v.stockQty !== undefined ? (parseInt(v.stockQty) > 0 ? 1 : 0) : 1);
      await client.query(
        `INSERT INTO product_variants
           (product_id, weight_grams, weight_label, price, compare_price, stock_qty, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
        [product.id, v.weightGrams || 0, v.weightLabel, v.price, v.comparePrice || null, stockVal]
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
    console.log({ route: "POST /api/products", status: 201, productId: product.id });
    return res.status(201).json({ success: true, message: "Product created", product: formatProduct(product, v, i, r) });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "POST /api/products", status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "POST /api/products", status: 500, error: err.message });
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

  const hasVariants = Array.isArray(req.body.variants);
  const hasImages = Array.isArray(req.body.images);

  console.log({ 
    route: "PUT /api/products/update-product", 
    productId: id, 
    body: { nameEn, nameTa, slug, categoryId, isBestseller, isNew, isActive, hasVariants, hasImages }, 
    status: "updating product" 
  });

  if (!id) {
    return res.status(400).json({ success: false, message: "Product ID is required" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const existing = await client.query("SELECT id FROM products WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      console.log({ route: "PUT /api/products/update-product", productId: id, status: 404, message: "Product not found" });
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    if (slug) {
      const dup = await client.query(
        "SELECT id FROM products WHERE slug = $1 AND id != $2",
        [slug.trim(), id]
      );
      if (dup.rows.length > 0) {
        await client.query("ROLLBACK");
        console.log({ route: "PUT /api/products/update-product", productId: id, status: 409, message: "slug already exists" });
        return res.status(409).json({ success: false, message: "Slug already used by another product" });
      }
    }

    // 1. Update Core Product Table
    const prodUpdateRes = await client.query(
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

    // 2. Sync Variants (if provided)
    if (hasVariants) {
      const currentVarsRes = await client.query(
        "SELECT id FROM product_variants WHERE product_id = $1", 
        [id]
      );
      const currentVarIds = currentVarsRes.rows.map(r => r.id);
      const incomingVarIds = req.body.variants.filter(v => v.id).map(v => v.id);

      // Deactivate variants not in incoming request body
      const varIdsToDeactivate = currentVarIds.filter(cid => !incomingVarIds.includes(cid));
      if (varIdsToDeactivate.length > 0) {
        await client.query(
          "UPDATE product_variants SET is_active = FALSE, updated_at = NOW() WHERE product_id = $1 AND id = ANY($2)",
          [id, varIdsToDeactivate]
        );
      }

      // Upsert incoming variants
      for (const v of req.body.variants) {
        if (!v.weightLabel || !v.price) continue;
        const stockVal = v.inStock !== undefined ? (isTrue(v.inStock) ? 1 : 0) : (v.stockQty !== undefined ? (parseInt(v.stockQty) > 0 ? 1 : 0) : undefined);
        if (v.id && currentVarIds.includes(v.id)) {
          // Update
          await client.query(
            `UPDATE product_variants SET
               weight_grams  = COALESCE($1, weight_grams),
               weight_label  = COALESCE($2, weight_label),
               price         = COALESCE($3, price),
               compare_price = $4,
               stock_qty     = COALESCE($5, stock_qty),
               is_active     = COALESCE($6, is_active),
               updated_at    = NOW()
             WHERE id = $7 AND product_id = $8`,
            [
              v.weightGrams !== undefined ? v.weightGrams : null,
              v.weightLabel || null,
              v.price !== undefined ? v.price : null,
              v.comparePrice !== undefined ? v.comparePrice : null,
              stockVal !== undefined ? stockVal : null,
              v.isActive !== undefined ? v.isActive : null,
              v.id,
              id
            ]
          );
        } else {
          // Insert
          await client.query(
            `INSERT INTO product_variants
               (product_id, weight_grams, weight_label, price, compare_price, stock_qty, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              id,
              v.weightGrams || 0,
              v.weightLabel,
              v.price,
              v.comparePrice || null,
              stockVal !== undefined ? stockVal : 1,
              v.isActive !== undefined ? v.isActive : true
            ]
          );
        }
      }
    }

    // 3. Sync Images (if provided)
    if (hasImages) {
      const currentImgsRes = await client.query(
        "SELECT id, image_url FROM product_images WHERE product_id = $1", 
        [id]
      );
      const currentImgMap = new Map(currentImgsRes.rows.map(r => [r.id, r]));
      const incomingImgIds = req.body.images.filter(img => img.id).map(img => img.id);

      // Delete images not in incoming request body
      const imgsToDelete = currentImgsRes.rows.filter(img => !incomingImgIds.includes(img.id));
      if (imgsToDelete.length > 0) {
        const idsToDelete = imgsToDelete.map(img => img.id);
        await client.query(
          "DELETE FROM product_images WHERE product_id = $1 AND id = ANY($2)",
          [id, idsToDelete]
        );
        // Delete files from Supabase Storage asynchronously
        const urlsToDelete = imgsToDelete.map(img => img.image_url);
        Promise.all(urlsToDelete.map(url => deleteFromSupabase(url))).catch(err => {
          console.warn(`[Supabase] async delete failed during update of product ${id}: ${err.message}`);
        });
      }

      // Upsert incoming images
      let primaryImageIndex = req.body.images.findIndex(img => img.isPrimary);
      if (primaryImageIndex === -1 && req.body.images.length > 0) {
        primaryImageIndex = 0; // default first one to primary
      }

      for (let idx = 0; idx < req.body.images.length; idx++) {
        const img = req.body.images[idx];
        if (!img.imageUrl) continue;
        const isPrimary = (idx === primaryImageIndex);

        if (img.id && currentImgMap.has(img.id)) {
          // Update
          await client.query(
            `UPDATE product_images SET
               sort_order = COALESCE($1, sort_order),
               is_primary = $2
             WHERE id = $3 AND product_id = $4`,
            [
              img.sortOrder !== undefined ? img.sortOrder : null,
              isPrimary,
              img.id,
              id
            ]
          );
        } else {
          // Insert
          await client.query(
            `INSERT INTO product_images (product_id, image_url, sort_order, is_primary)
             VALUES ($1, $2, $3, $4)`,
            [
              id,
              img.imageUrl,
              img.sortOrder || 0,
              isPrimary
            ]
          );
        }
      }
    }

    await client.query("COMMIT");

    // Retrieve fresh/updated state
    const { variants, images, reviews } = await fetchVariantsImagesReviews(id);
    console.log({ route: "PUT /api/products/update-product", productId: id, status: 200 });
    return res.json({ success: true, message: "Product updated", product: formatProduct(prodUpdateRes.rows[0], variants, images, reviews) });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error({ route: "PUT /api/products/update-product", productId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/:id
// Soft-delete: set is_active = FALSE (preserves order history).
// ==================================================================
async function deleteProduct(req, res) {
  const { id } = req.body;
  console.log({ route: "DELETE /api/products/delete-product", productId: id, status: "deactivating product and cleaning up images" });
  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      "UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      console.log({ route: "DELETE /api/products/delete-product", productId: id, status: 404, message: "Product not found" });
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    // Delete image records from DB and get their URLs
    const imgRes = await client.query(
      "DELETE FROM product_images WHERE product_id = $1 RETURNING image_url",
      [id]
    );

    await client.query("COMMIT");

    // Asynchronously delete files from Supabase Storage (non-blocking)
    if (imgRes.rows.length > 0) {
      const urls = imgRes.rows.map(r => r.image_url);
      Promise.all(urls.map(url => deleteFromSupabase(url))).catch(err => {
        console.warn(`[Supabase] async bulk delete failed for product ${id}: ${err.message}`);
      });
    }

    console.log({ route: "DELETE /api/products/delete-product", productId: id, status: 200 });
    return res.json({ success: true, message: "Product deactivated (soft delete — order history preserved) and images cleared" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error({ route: "DELETE /api/products/delete-product", productId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// ADMIN — POST /api/products/:id/variants
// Add a variant to an existing product.
// ==================================================================
async function addVariant(req, res) {
  const { productId: id, weightGrams, weightLabel, price, comparePrice, stockQty, inStock } = req.body;
  console.log({ route: "POST /api/products/add-variant", productId: id, body: { weightGrams, weightLabel, price, comparePrice, stockQty, inStock }, status: "adding variant" });

  if (!weightLabel || !price) {
    console.log({ route: "POST /api/products/add-variant", productId: id, status: 400, message: "missing fields" });
    return res.status(400).json({ success: false, message: "weightLabel and price are required" });
  }
  const stockVal = inStock !== undefined ? (isTrue(inStock) ? 1 : 0) : (stockQty !== undefined ? (parseInt(stockQty) > 0 ? 1 : 0) : 1);
  try {
    const result = await db.query(
      `INSERT INTO product_variants
         (product_id, weight_grams, weight_label, price, compare_price, stock_qty, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE)
       RETURNING *`,
      [id, weightGrams || 0, weightLabel, price, comparePrice || null, stockVal]
    );
    console.log({ route: "POST /api/products/add-variant", productId: id, status: 201, variantId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Variant added", variant: formatVariant(result.rows[0]) });
  } catch (err) {
    console.error({ route: "POST /api/products/add-variant", productId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/products/:id/variants/:variantId
// Update price / stock / comparePrice / isActive on a variant.
// ==================================================================
async function updateVariant(req, res) {
  const { productId: id, variantId, weightGrams, weightLabel, price, comparePrice, stockQty, inStock, isActive } = req.body;
  console.log({ route: "PUT /api/products/update-variant", productId: id, variantId, body: { weightGrams, weightLabel, price, comparePrice, stockQty, inStock, isActive }, status: "updating variant" });

  const stockVal = inStock !== undefined ? (isTrue(inStock) ? 1 : 0) : (stockQty !== undefined ? (parseInt(stockQty) > 0 ? 1 : 0) : undefined);
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
        stockVal !== undefined ? stockVal : null,
        isActive !== undefined ? isActive : null,
        variantId,
        id
      ]
    );
    if (result.rows.length === 0) {
      console.log({ route: "PUT /api/products/update-variant", productId: id, variantId, status: 404, message: "Variant not found" });
      return res.status(404).json({ success: false, message: "Variant not found" });
    }
    console.log({ route: "PUT /api/products/update-variant", productId: id, variantId, status: 200 });
    return res.json({ success: true, message: "Variant updated", variant: formatVariant(result.rows[0]) });
  } catch (err) {
    console.error({ route: "PUT /api/products/update-variant", productId: id, variantId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/:id/variants/:variantId
// ==================================================================
async function deleteVariant(req, res) {
  const { productId: id, variantId } = req.body;
  console.log({ route: "DELETE /api/products/delete-variant", productId: id, variantId, status: "deleting variant" });
  try {
    const result = await db.query(
      "DELETE FROM product_variants WHERE id = $1 AND product_id = $2 RETURNING id",
      [variantId, id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/products/delete-variant", productId: id, variantId, status: 404, message: "Variant not found" });
      return res.status(404).json({ success: false, message: "Variant not found" });
    }
    console.log({ route: "DELETE /api/products/delete-variant", productId: id, variantId, status: 200 });
    return res.json({ success: true, message: "Variant deleted successfully" });
  } catch (err) {
    if (err.code === "23503") {
      console.log({ route: "DELETE /api/products/delete-variant", productId: id, variantId, status: 200, info: "foreign key constraint violation, soft-deactivating variant instead" });
      try {
        const softDelRes = await db.query(
          "UPDATE product_variants SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND product_id = $2 RETURNING id",
          [variantId, id]
        );
        if (softDelRes.rows.length === 0) {
          return res.status(404).json({ success: false, message: "Variant not found" });
        }
        return res.json({ success: true, message: "Variant cannot be hard deleted due to order history; deactivated instead" });
      } catch (softErr) {
        console.error({ route: "DELETE /api/products/delete-variant", productId: id, variantId, status: 500, error: softErr.message });
        return res.status(500).json({ success: false, message: "Internal server error" });
      }
    }
    console.error({ route: "DELETE /api/products/delete-variant", productId: id, variantId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/products/add-image
// Accepts multipart/form-data (imageFile) OR JSON (imageUrl).
// Stored under Supabase path: product/{slug}/{filename}
// ==================================================================
async function addImage(req, res) {
  let { productId: id, imageUrl, sortOrder, isPrimary } = req.body;
  console.log({ route: "POST /api/products/add-image", productId: id });

  if (!id) {
    return res.status(400).json({ success: false, message: "productId is required" });
  }

  try {
    if (req.file) {
      const prodRes = await db.query("SELECT slug FROM products WHERE id = $1", [id]);
      if (prodRes.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Product not found" });
      }
      imageUrl = await uploadToSupabase(req.file.buffer, req.file.mimetype, req.file.originalname, `product/${prodRes.rows[0].slug}`);
    }

    if (!imageUrl) {
      return res.status(400).json({ success: false, message: "imageUrl or imageFile is required" });
    }

    if (isPrimary) {
      await db.query("UPDATE product_images SET is_primary = FALSE WHERE product_id = $1", [id]);
    }
    const result = await db.query(
      `INSERT INTO product_images (product_id, image_url, sort_order, is_primary)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, imageUrl, sortOrder || 0, isPrimary || false]
    );
    console.log({ route: "POST /api/products/add-image", productId: id, status: 201, imageId: result.rows[0].id });
    return res.status(201).json({ success: true, message: "Image added", image: formatImage(result.rows[0]) });
  } catch (err) {
    const isSupabaseError = err.message && err.message.includes("Storage upload failed");
    const statusCode = isSupabaseError ? 502 : 500;
    const msg = isSupabaseError ? err.message : "Internal server error";
    console.error({ route: "POST /api/products/add-image", productId: id, status: statusCode, error: err.message });
    return res.status(statusCode).json({ success: false, message: msg });
  }
}

// ==================================================================
// ADMIN — POST /api/products/add-images
// Bulk upload (3-5 typical) in ONE request.
// Multipart field: imageFiles (array, max 5) — see uploadRoute wiring.
// Body (multipart fields, all optional): primaryIndex (0-based index
// into the uploaded files array that should become the primary image)
// Stored under Supabase path: product/{slug}/{filename}
// Response: { success, message, images: [...] }
// ==================================================================
async function addImages(req, res) {
  const { productId: id } = req.body;
  const files = req.files || [];
  const primaryIndex = req.body.primaryIndex !== undefined ? parseInt(req.body.primaryIndex) : null;

  console.log({ route: "POST /api/products/add-images", productId: id, fileCount: files.length, status: "uploading batch" });

  if (!id) {
    return res.status(400).json({ success: false, message: "productId is required" });
  }
  if (!files.length) {
    return res.status(400).json({ success: false, message: "At least one imageFile is required" });
  }

  try {
    const prodRes = await db.query("SELECT slug FROM products WHERE id = $1", [id]);
    if (prodRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const slug = prodRes.rows[0].slug;

    // Check whether the product already has a primary image
    const existingPrimary = await db.query(
      "SELECT id FROM product_images WHERE product_id = $1 AND is_primary = TRUE",
      [id]
    );
    let primaryAlreadySet = existingPrimary.rows.length > 0;

    // Current max sort_order so new images append after existing ones
    const maxSortRes = await db.query(
      "SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM product_images WHERE product_id = $1",
      [id]
    );
    let nextSort = parseInt(maxSortRes.rows[0].max_sort) + 1;

    // Upload all files to Supabase in parallel: product/{slug}/{filename}
    const uploadedUrls = await Promise.all(
      files.map(f => uploadToSupabase(f.buffer, f.mimetype, f.originalname, `product/${slug}`))
    );

    const insertedImages = [];
    for (let idx = 0; idx < uploadedUrls.length; idx++) {
      const shouldBePrimary = !primaryAlreadySet && (
        primaryIndex !== null ? idx === primaryIndex : idx === 0
      );
      if (shouldBePrimary) primaryAlreadySet = true;

      const result = await db.query(
        `INSERT INTO product_images (product_id, image_url, sort_order, is_primary)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [id, uploadedUrls[idx], nextSort, shouldBePrimary]
      );
      insertedImages.push(formatImage(result.rows[0]));
      nextSort += 1;
    }

    console.log({ route: "POST /api/products/add-images", productId: id, status: 201, count: insertedImages.length });
    return res.status(201).json({ success: true, message: `${insertedImages.length} image(s) added`, images: insertedImages });
  } catch (err) {
    const isSupabaseError = err.message && err.message.includes("Storage upload failed");
    const statusCode = isSupabaseError ? 502 : 500;
    const msg = isSupabaseError ? err.message : "Internal server error";
    console.error({ route: "POST /api/products/add-images", productId: id, status: statusCode, error: err.message });
    return res.status(statusCode).json({ success: false, message: msg });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/delete-image
// Removes DB record and deletes the file from Supabase storage.
// ==================================================================
async function deleteImage(req, res) {
  const { productId: id, imageId } = req.body;
  console.log({ route: "DELETE /api/products/delete-image", productId: id, imageId });
  try {
    const result = await db.query(
      "DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING image_url",
      [imageId, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Image not found" });
    }
    // Delete from Supabase asynchronously to prevent API response delays
    deleteFromSupabase(result.rows[0].image_url).catch(err => {
      console.warn(`[Supabase] async delete failed for "${result.rows[0].image_url}": ${err.message}`);
    });
    console.log({ route: "DELETE /api/products/delete-image", productId: id, imageId, status: 200 });
    return res.json({ success: true, message: "Image deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/products/delete-image", productId: id, imageId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// PUBLIC — GET /api/products/similar?productId=&limit=
// Returns products in the same category, excluding the given product.
// ==================================================================
async function getSimilarProducts(req, res) {
  const { productId, limit = 8 } = req.query;
  if (!productId) return res.status(400).json({ success: false, message: "productId is required" });
  try {
    // Get the category of the product
    const catRes = await db.query("SELECT category_id FROM products WHERE id = $1", [productId]);
    if (!catRes.rows.length) return res.status(404).json({ success: false, message: "Product not found" });
    const categoryId = catRes.rows[0].category_id;

    let rows;
    if (categoryId) {
      const result = await db.query(
        `SELECT v.* FROM v_products_with_price v
         WHERE v.category_id = $1 AND v.id != $2 AND v.is_active = TRUE
         ORDER BY v.is_bestseller DESC, v.avg_rating DESC NULLS LAST
         LIMIT $3`,
        [categoryId, productId, parseInt(limit)]
      );
      rows = result.rows;
    }

    // Fallback: if no same-category products, return popular products
    if (!rows || rows.length === 0) {
      const fallback = await db.query(
        `SELECT v.* FROM v_products_with_price v
         WHERE v.id != $1 AND v.is_active = TRUE
         ORDER BY v.is_bestseller DESC, v.avg_rating DESC NULLS LAST
         LIMIT $2`,
        [productId, parseInt(limit)]
      );
      rows = fallback.rows;
    }

    const productIds = rows.map((r) => r.id);
    let variantsByProduct = {};
    if (productIds.length > 0) {
      const varRes = await db.query(
        `SELECT * FROM product_variants WHERE product_id = ANY($1) AND is_active = TRUE ORDER BY weight_grams ASC`,
        [productIds]
      );
      varRes.rows.forEach((v) => {
        if (!variantsByProduct[v.product_id]) variantsByProduct[v.product_id] = [];
        variantsByProduct[v.product_id].push(formatVariant(v));
      });
    }
    const products = rows.map((p) => formatProduct(p, variantsByProduct[p.id] || []));
    return res.json({ success: true, products });
  } catch (err) {
    console.error({ route: "GET /api/products/similar", productId, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getAllProducts, getProductBySlug, getWeightLabels, getSimilarProducts,
  createProduct, updateProduct, deleteProduct,
  addVariant, updateVariant, deleteVariant,
  addImage, addImages, deleteImage
};