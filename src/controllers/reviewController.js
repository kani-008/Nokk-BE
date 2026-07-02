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
// Submit a review. One review per product per user.
// Body: { productId, rating, title?, comment?, orderId?, imageUrls? }
// ==================================================================
async function addReview(req, res) {
  const { productId: id, rating, title, comment, orderId, imageUrls } = req.body;
  console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, body: { rating, title, orderId, imageCount: imageUrls?.length }, status: "submitting review" });

  if (!rating || rating < 1 || rating > 5) {
    console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 400, message: "invalid rating" });
    return res.status(400).json({ success: false, message: "rating must be between 1 and 5" });
  }
  if (imageUrls !== undefined && (!Array.isArray(imageUrls) || imageUrls.length > 3)) {
    console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 400, message: "invalid imageUrls" });
    return res.status(400).json({ success: false, message: "imageUrls must be an array of at most 3 URLs" });
  }
  try {
    // Duplicate check
    const dup = await db.query(
      "SELECT id FROM product_reviews WHERE product_id = $1 AND user_id = $2",
      [id, req.user.id]
    );
    if (dup.rows.length > 0) {
      console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 409, message: "already reviewed" });
      return res.status(409).json({ success: false, message: "You have already reviewed this product" });
    }

    // Optional order linkage — if provided, validate it actually justifies this review
    let validatedOrderId = null;
    if (orderId) {
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
      validatedOrderId = orderId;
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
         (product_id, user_id, rating, title, comment, is_approved, is_verified, order_id)
       VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7)
       RETURNING *`,
      [id, req.user.id, rating, title || null, comment || null, isVerified, validatedOrderId]
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

    console.log({ route: "POST /api/products/add-review", productId: id, userId: req.user.id, status: 201, reviewId: review.id, imageCount: insertedImages.length });
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
// CUSTOMER — GET /api/products/get-my-review?productId=   (login required)
// Returns the logged-in user's existing review for a product, or
// review: null if they haven't reviewed it yet — lets the frontend
// decide between showing a create form or an edit form.
// ==================================================================
async function getMyReviewForProduct(req, res) {
  const { productId } = req.query;
  console.log({ route: "GET /api/products/get-my-review", productId, userId: req.user.id, status: "fetching own review" });

  if (!productId) {
    console.log({ route: "GET /api/products/get-my-review", productId, userId: req.user.id, status: 400, message: "productId is required" });
    return res.status(400).json({ success: false, message: "productId is required" });
  }

  try {
    const result = await db.query(
      "SELECT * FROM product_reviews WHERE product_id = $1 AND user_id = $2",
      [productId, req.user.id]
    );
    let images = [];
    if (result.rows.length > 0) {
      const imgRes = await db.query(
        "SELECT * FROM product_review_images WHERE review_id = $1 ORDER BY sort_order ASC",
        [result.rows[0].id]
      );
      images = imgRes.rows;
    }
    console.log({ route: "GET /api/products/get-my-review", productId, userId: req.user.id, status: 200, found: result.rows.length > 0 });
    return res.json({
      success: true,
      review: result.rows.length > 0 ? formatReview(result.rows[0], images) : null
    });
  } catch (err) {
    console.error({ route: "GET /api/products/get-my-review", productId, userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  formatReview, fetchReviewsForProduct,
  addReview, deleteReview,
  updateReview, deleteMyReview, getMyReviewForProduct
};
