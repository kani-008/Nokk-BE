const db = require("../config/db.js");
const { deleteFromSupabase } = require("../config/supabase.js");

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function formatReview(r, images = []) {
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
    createdAt: r.created_at,
    images: images.map(img => ({ id: img.id, imageUrl: img.image_url }))
  };
}

// ------------------------------------------------------------------
// Fetches all approved reviews for a product, plus each review's images,
// in exactly 2 queries (no N+1). Used by productController's product-detail
// / create / update responses to embed the reviews array on a product.
// ------------------------------------------------------------------
async function fetchReviewsForProduct(productId) {
  const revRes = await db.query(
    `SELECT pr.*, u.full_name
     FROM product_reviews pr
     LEFT JOIN users u ON u.id = pr.user_id
     WHERE pr.product_id = $1 AND pr.is_approved = TRUE
     ORDER BY pr.created_at DESC`,
    [productId]
  );

  // One extra query for ALL review images, keyed by review id — avoids
  // issuing a separate product_review_images query per review row.
  const reviewIds = revRes.rows.map(r => r.id);
  let reviewImagesMap = {};
  if (reviewIds.length > 0) {
    const revImgRes = await db.query(
      `SELECT * FROM product_review_images WHERE review_id = ANY($1) ORDER BY sort_order ASC`,
      [reviewIds]
    );
    revImgRes.rows.forEach(img => {
      if (!reviewImagesMap[img.review_id]) reviewImagesMap[img.review_id] = [];
      reviewImagesMap[img.review_id].push(img);
    });
  }

  return revRes.rows.map(r => formatReview(r, reviewImagesMap[r.id] || []));
}

// ==================================================================
// CUSTOMER — POST /api/products/add-review   (login required)
// Submit a review. One review per product per user per order.
// Body: { productId, rating, title?, comment?, orderId, imageUrls? }
// orderId is REQUIRED — review eligibility is scoped to a specific
// delivered order. A user may review the same product again after
// completing a separate delivered order.
// ==================================================================
async function addReview(req, res) {
  const { productId: id, rating, title, comment, orderId, imageUrls } = req.body;
  console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, body: { rating, title, orderId, imageCount: imageUrls?.length }, status: "submitting review" });

  if (!orderId) {
    console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 400, message: "orderId is required" });
    return res.status(400).json({ success: false, message: "orderId is required" });
  }
  if (!rating || rating < 1 || rating > 5) {
    console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 400, message: "invalid rating" });
    return res.status(400).json({ success: false, message: "rating must be between 1 and 5" });
  }
  if (imageUrls !== undefined && (!Array.isArray(imageUrls) || imageUrls.length > 3)) {
    console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 400, message: "invalid imageUrls" });
    return res.status(400).json({ success: false, message: "imageUrls must be an array of at most 3 URLs" });
  }

  try {
    // Validate the order belongs to this user and is delivered
    const orderRes = await db.query(
      "SELECT id, status FROM orders WHERE id = $1 AND user_id = $2",
      [orderId, req.user.id]
    );
    if (orderRes.rows.length === 0) {
      console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, orderId, status: 400, message: "order not found for user" });
      return res.status(400).json({ success: false, message: "Order not found" });
    }
    if (orderRes.rows[0].status !== "delivered") {
      console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, orderId, status: 400, message: "order not delivered" });
      return res.status(400).json({ success: false, message: "You can only review products from delivered orders" });
    }
    const itemRes = await db.query(
      "SELECT id FROM order_items WHERE order_id = $1 AND product_id = $2",
      [orderId, id]
    );
    if (itemRes.rows.length === 0) {
      console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, orderId, status: 400, message: "product not in order" });
      return res.status(400).json({ success: false, message: "This product was not part of the given order" });
    }

    // Duplicate check scoped to this specific product + user + order combination.
    // A fresh review against a different delivered order for the same product is allowed.
    const dup = await db.query(
      "SELECT id FROM product_reviews WHERE product_id = $1 AND user_id = $2 AND order_id = $3",
      [id, req.user.id, orderId]
    );
    if (dup.rows.length > 0) {
      console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, orderId, status: 409, message: "already reviewed this order item" });
      return res.status(409).json({ success: false, message: "You have already reviewed this product for this order" });
    }

    const result = await db.query(
      `INSERT INTO product_reviews
         (product_id, user_id, rating, title, comment, is_approved, is_verified, order_id)
       VALUES ($1,$2,$3,$4,$5,$7,TRUE,$6)
       RETURNING *`,
      [id, req.user.id, rating, title || null, comment || null, orderId, rating >= 3]
    );
    const review = result.rows[0];

    const insertedImages = [];
    if (Array.isArray(imageUrls) && imageUrls.length > 0) {
      for (let idx = 0; idx < imageUrls.length; idx++) {
        const imgResult = await db.query(
          `INSERT INTO product_review_images (review_id, image_url, sort_order)
           VALUES ($1,$2,$3)
           RETURNING *`,
          [review.id, imageUrls[idx], idx]
        );
        insertedImages.push(imgResult.rows[0]);
      }
    }

    console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, orderId, status: 201, reviewId: review.id, imageCount: insertedImages.length });
    return res.status(201).json({ success: true, message: "Review submitted", review: formatReview(review, insertedImages) });
  } catch (err) {
    console.error({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/products/delete-review
// Body: { productId, reviewId }
// ==================================================================
async function deleteReview(req, res) {
  const { productId: id, reviewId } = req.body;
  console.log({ route: "DELETE /api/products/delete-review", productId: id, reviewId, status: "deleting review" });
  try {
    // Grab image URLs before the row (and its cascaded images) disappear
    const imgRes = await db.query(
      "SELECT image_url FROM product_review_images WHERE review_id = $1",
      [reviewId]
    );

    const result = await db.query(
      "DELETE FROM product_reviews WHERE id = $1 AND product_id = $2 RETURNING id",
      [reviewId, id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/products/delete-review", productId: id, reviewId, status: 404, message: "Review not found" });
      return res.status(404).json({ success: false, message: "Review not found" });
    }

    // product_review_images rows are gone via ON DELETE CASCADE — clean up
    // the actual Supabase files asynchronously so nothing gets orphaned.
    if (imgRes.rows.length > 0) {
      const urls = imgRes.rows.map(r => r.image_url);
      Promise.all(urls.map(url => deleteFromSupabase(url))).catch(err => {
        console.warn(`[Supabase] async delete failed for review ${reviewId}: ${err.message}`);
      });
    }

    console.log({ route: "DELETE /api/products/delete-review", productId: id, reviewId, status: 200 });
    return res.json({ success: true, message: "Review deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/products/delete-review", productId: id, reviewId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// CUSTOMER — PUT /api/products/update-review   (login required)
// Body: { reviewId, rating, title, comment, imageUrls? }
// Edits the logged-in user's own review. Rating/title/comment/images only.
// ==================================================================
async function updateReview(req, res) {
  const { reviewId, rating, title, comment, imageUrls } = req.body;
  console.log({ route: "PUT /api/products/update-review", reviewId, userId: req.user.id, body: { rating, title, imageCount: imageUrls?.length }, status: "updating own review" });

  if (!reviewId) {
    console.log({ route: "PUT /api/products/update-review", reviewId, userId: req.user.id, status: 400, message: "reviewId is required" });
    return res.status(400).json({ success: false, message: "reviewId is required" });
  }
  if (!rating || rating < 1 || rating > 5) {
    console.log({ route: "PUT /api/products/update-review", reviewId, userId: req.user.id, status: 400, message: "invalid rating" });
    return res.status(400).json({ success: false, message: "rating must be between 1 and 5" });
  }
  if (imageUrls !== undefined && (!Array.isArray(imageUrls) || imageUrls.length > 3)) {
    console.log({ route: "PUT /api/products/update-review", reviewId, userId: req.user.id, status: 400, message: "invalid imageUrls" });
    return res.status(400).json({ success: false, message: "imageUrls must be an array of at most 3 URLs" });
  }

  try {
    const owned = await db.query(
      "SELECT id FROM product_reviews WHERE id = $1 AND user_id = $2",
      [reviewId, req.user.id]
    );
    if (owned.rows.length === 0) {
      console.log({ route: "PUT /api/products/update-review", reviewId, userId: req.user.id, status: 404, message: "review not found" });
      return res.status(404).json({ success: false, message: "Review not found" });
    }

    const result = await db.query(
      `UPDATE product_reviews
       SET rating = $1, title = $2, comment = $3, updated_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING *`,
      [rating, title || null, comment || null, reviewId, req.user.id]
    );
    const review = result.rows[0];

    // imageUrls, when provided, is the final desired set — replace whatever
    // existed before: delete the old rows + their Supabase files first,
    // same cleanup approach used on review delete, then insert the new set.
    let finalImages = null;
    if (imageUrls !== undefined) {
      const oldImgRes = await db.query(
        "SELECT image_url FROM product_review_images WHERE review_id = $1",
        [reviewId]
      );
      await db.query("DELETE FROM product_review_images WHERE review_id = $1", [reviewId]);
      if (oldImgRes.rows.length > 0) {
        const oldUrls = oldImgRes.rows.map(r => r.image_url);
        Promise.all(oldUrls.map(url => deleteFromSupabase(url))).catch(err => {
          console.warn(`[Supabase] async delete failed for review ${reviewId}: ${err.message}`);
        });
      }

      finalImages = [];
      for (let idx = 0; idx < imageUrls.length; idx++) {
        const imgResult = await db.query(
          `INSERT INTO product_review_images (review_id, image_url, sort_order)
           VALUES ($1,$2,$3)
           RETURNING *`,
          [reviewId, imageUrls[idx], idx]
        );
        finalImages.push(imgResult.rows[0]);
      }
    } else {
      const currentImgRes = await db.query(
        "SELECT * FROM product_review_images WHERE review_id = $1 ORDER BY sort_order ASC",
        [reviewId]
      );
      finalImages = currentImgRes.rows;
    }

    console.log({ route: "PUT /api/products/update-review", reviewId, userId: req.user.id, status: 200, imageCount: finalImages.length });
    return res.json({ success: true, message: "Review updated", review: formatReview(review, finalImages) });
  } catch (err) {
    console.error({ route: "PUT /api/products/update-review", reviewId, userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// CUSTOMER — DELETE /api/products/delete-my-review   (login required)
// Body: { reviewId }
// Deletes the logged-in user's own review only. Distinct from the
// admin-only deleteReview, which can remove any review for moderation.
// ==================================================================
async function deleteMyReview(req, res) {
  const { reviewId } = req.body;
  console.log({ route: "DELETE /api/products/delete-my-review", reviewId, userId: req.user.id, status: "deleting own review" });

  if (!reviewId) {
    console.log({ route: "DELETE /api/products/delete-my-review", reviewId, userId: req.user.id, status: 400, message: "reviewId is required" });
    return res.status(400).json({ success: false, message: "reviewId is required" });
  }

  try {
    // Grab image URLs before the row (and its cascaded images) disappear
    const imgRes = await db.query(
      "SELECT image_url FROM product_review_images WHERE review_id = $1",
      [reviewId]
    );

    const result = await db.query(
      "DELETE FROM product_reviews WHERE id = $1 AND user_id = $2 RETURNING id",
      [reviewId, req.user.id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/products/delete-my-review", reviewId, userId: req.user.id, status: 404, message: "review not found" });
      return res.status(404).json({ success: false, message: "Review not found" });
    }

    // product_review_images rows are gone via ON DELETE CASCADE — clean up
    // the actual Supabase files asynchronously so nothing gets orphaned.
    if (imgRes.rows.length > 0) {
      const urls = imgRes.rows.map(r => r.image_url);
      Promise.all(urls.map(url => deleteFromSupabase(url))).catch(err => {
        console.warn(`[Supabase] async delete failed for review ${reviewId}: ${err.message}`);
      });
    }

    console.log({ route: "DELETE /api/products/delete-my-review", reviewId, userId: req.user.id, status: 200 });
    return res.json({ success: true, message: "Review deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/products/delete-my-review", reviewId, userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// CUSTOMER — GET /api/products/get-my-review?productId=&orderId=   (login required)
// Returns the logged-in user's existing review for the exact
// product + order combination, or review: null if they haven't
// reviewed that specific order's item yet.
// Both productId and orderId are required.
// ==================================================================
async function getMyReviewForProduct(req, res) {
  const { productId, orderId } = req.query;
  console.log({ route: "GET /api/products/get-my-review", productId, orderId, userId: req.user.id, status: "fetching own review" });

  if (!productId) {
    console.log({ route: "GET /api/products/get-my-review", productId, orderId, userId: req.user.id, status: 400, message: "productId is required" });
    return res.status(400).json({ success: false, message: "productId is required" });
  }
  if (!orderId) {
    console.log({ route: "GET /api/products/get-my-review", productId, orderId, userId: req.user.id, status: 400, message: "orderId is required" });
    return res.status(400).json({ success: false, message: "orderId is required" });
  }

  try {
    const result = await db.query(
      "SELECT * FROM product_reviews WHERE product_id = $1 AND user_id = $2 AND order_id = $3",
      [productId, req.user.id, orderId]
    );
    let images = [];
    if (result.rows.length > 0) {
      const imgRes = await db.query(
        "SELECT * FROM product_review_images WHERE review_id = $1 ORDER BY sort_order ASC",
        [result.rows[0].id]
      );
      images = imgRes.rows;
    }
    console.log({ route: "GET /api/products/get-my-review", productId, orderId, userId: req.user.id, status: 200, found: result.rows.length > 0 });
    return res.json({
      success: true,
      review: result.rows.length > 0 ? formatReview(result.rows[0], images) : null
    });
  } catch (err) {
    console.error({ route: "GET /api/products/get-my-review", productId, orderId, userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/products/admin-reviews   (isAdmin required)
// Optional query param: ?productId=<id>  — when provided, returns only
// that product's reviews; when absent, returns every review (for counts).
// ==================================================================
async function adminGetAllReviews(req, res) {
  const { productId } = req.query;
  console.log({ route: "GET /api/products/admin-reviews", userId: req.user.id, productId: productId || "all", status: "fetching reviews for admin" });
  try {
    const params = productId ? [productId] : [];
    const whereClause = productId ? "WHERE pr.product_id = $1" : "";
    const result = await db.query(
      `SELECT pr.*, u.full_name AS user_name, u.phone AS user_phone, p.name_en AS product_name
       FROM product_reviews pr
       LEFT JOIN users u ON u.id = pr.user_id
       LEFT JOIN products p ON p.id = pr.product_id
       ${whereClause}
       ORDER BY pr.created_at DESC`,
      params
    );

    const reviewIds = result.rows.map(r => r.id);
    let reviewImagesMap = {};
    if (reviewIds.length > 0) {
      const revImgRes = await db.query(
        `SELECT * FROM product_review_images WHERE review_id = ANY($1) ORDER BY sort_order ASC`,
        [reviewIds]
      );
      revImgRes.rows.forEach(img => {
        if (!reviewImagesMap[img.review_id]) reviewImagesMap[img.review_id] = [];
        reviewImagesMap[img.review_id].push({ id: img.id, imageUrl: img.image_url });
      });
    }

    const reviews = result.rows.map(r => ({
      id: r.id,
      productId: r.product_id,
      productName: r.product_name || "Deleted Product",
      userId: r.user_id,
      userName: r.user_name || "Guest",
      userPhone: r.user_phone || null,
      rating: r.rating,
      title: r.title,
      comment: r.comment,
      isApproved: r.is_approved,
      isVerified: r.is_verified,
      createdAt: r.created_at,
      images: reviewImagesMap[r.id] || []
    }));

    return res.json({ success: true, reviews });
  } catch (err) {
    console.error({ route: "GET /api/products/admin-reviews", error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/products/admin-approve-review   (isAdmin required)
// Body: { reviewId, isApproved }
// ==================================================================
async function adminApproveReview(req, res) {
  const { reviewId, isApproved } = req.body;
  console.log({ route: "PUT /api/products/admin-approve-review", reviewId, isApproved });
  if (!reviewId) {
    return res.status(400).json({ success: false, message: "reviewId is required" });
  }
  try {
    const result = await db.query(
      `UPDATE product_reviews
       SET is_approved = $1
       WHERE id = $2
       RETURNING id`,
      [isApproved === true, reviewId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Review not found" });
    }
    return res.json({ success: true, message: `Review approval status updated to ${isApproved}` });
  } catch (err) {
    console.error({ route: "PUT /api/products/admin-approve-review", error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// PUBLIC — GET /api/products/get-reviews?slug=&page=1&limit=10
// Returns paginated approved reviews for a product identified by slug.
// Also returns product metadata (name, image, avgRating, reviewCount).
// ==================================================================
async function getProductReviews(req, res) {
  const { slug } = req.query;
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const offset = (page - 1) * limit;

  if (!slug) {
    return res.status(400).json({ success: false, message: "slug is required" });
  }

  try {
    // Resolve product by slug
    const prodRes = await db.query(
      `SELECT p.id, p.name_en, p.name_ta, p.slug,
              p.avg_rating, p.review_count,
              (SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id AND pi.is_primary = TRUE LIMIT 1) AS primary_image
       FROM products p
       WHERE p.slug = $1 AND p.is_active = TRUE`,
      [slug]
    );
    if (prodRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const prod = prodRes.rows[0];

    // Count total approved reviews
    const countRes = await db.query(
      "SELECT COUNT(*)::int AS total FROM product_reviews WHERE product_id = $1 AND is_approved = TRUE",
      [prod.id]
    );
    const total = countRes.rows[0].total;

    // Paginated approved reviews
    const revRes = await db.query(
      `SELECT pr.*, u.full_name
       FROM product_reviews pr
       LEFT JOIN users u ON u.id = pr.user_id
       WHERE pr.product_id = $1 AND pr.is_approved = TRUE
       ORDER BY pr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [prod.id, limit, offset]
    );

    // Batch-fetch images for this page of reviews
    const reviewIds = revRes.rows.map(r => r.id);
    let reviewImagesMap = {};
    if (reviewIds.length > 0) {
      const revImgRes = await db.query(
        `SELECT * FROM product_review_images WHERE review_id = ANY($1) ORDER BY sort_order ASC`,
        [reviewIds]
      );
      revImgRes.rows.forEach(img => {
        if (!reviewImagesMap[img.review_id]) reviewImagesMap[img.review_id] = [];
        reviewImagesMap[img.review_id].push({ id: img.id, imageUrl: img.image_url });
      });
    }

    const reviews = revRes.rows.map(r => formatReview(r, reviewImagesMap[r.id] || []));

    return res.json({
      success: true,
      product: {
        id: prod.id,
        nameEn: prod.name_en,
        nameTa: prod.name_ta,
        slug: prod.slug,
        avgRating: parseFloat(prod.avg_rating) || 0,
        reviewCount: prod.review_count || 0,
        primaryImage: prod.primary_image || null,
      },
      reviews,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    });
  } catch (err) {
    console.error({ route: "GET /api/products/get-reviews", slug, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/products/admin-review-counts   (isAdmin required)
// Returns one row per product that has at least one review:
// { counts: { [productId]: { total, pending } } }
// Lightweight alternative to fetching all review rows just for counts.
// ==================================================================
async function adminGetReviewCounts(req, res) {
  console.log({ route: "GET /api/products/admin-review-counts", userId: req.user.id, status: "fetching review counts" });
  try {
    const result = await db.query(
      `SELECT product_id,
              COUNT(*)::int                                    AS total,
              COUNT(*) FILTER (WHERE NOT is_approved)::int     AS pending
       FROM product_reviews
       GROUP BY product_id`
    );
    const counts = {};
    result.rows.forEach(r => {
      counts[r.product_id] = { total: r.total, pending: r.pending };
    });
    console.log({ route: "GET /api/products/admin-review-counts", status: 200, products: result.rows.length });
    return res.json({ success: true, counts });
  } catch (err) {
    console.error({ route: "GET /api/products/admin-review-counts", error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  formatReview, fetchReviewsForProduct,
  addReview, deleteReview,
  updateReview, deleteMyReview, getMyReviewForProduct,
  adminGetAllReviews, adminApproveReview, adminGetReviewCounts,
  getProductReviews,
};
