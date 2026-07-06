const db = require("../config/db.js");
const { uploadToSupabase, deleteFromSupabase } = require("../config/supabase.js");

async function updateSettingValue(key, value) {
  await db.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)]
  );
}

function buildBannerText(offer, productName = null, categoryName = null) {
  const discVal = parseFloat(offer.discount_value);
  const discountText = offer.offer_type === "percentage"
    ? `${discVal}% OFF`
    : `₹${discVal} OFF`;

  let scope = "Everything";
  if (offer.applies_to === "product" && productName) scope = productName;
  else if (offer.applies_to === "category" && categoryName) scope = categoryName;

  const heading = `${discountText} — ${scope}`;

  const hasEndDate = offer.end_date && offer.end_date !== "";
  const endDateText = hasEndDate
    ? `Ends ${new Date(offer.end_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`
    : null;

  // Subtext priority: description + end date > description only > end date only > fallback
  let subtext;
  if (offer.description && offer.description.trim()) {
    subtext = endDateText
      ? `${offer.description.trim()} · ${endDateText}`
      : offer.description.trim();
  } else {
    subtext = endDateText || "Limited time offer";
  }

  const endText = hasEndDate ? ` · ${endDateText}` : "";
  const announcement = `🔥 ${discountText} on ${scope}${endText}`;

  return { heading, subtext, announcement };
}

const num = (v) => parseFloat(v) || 0;

function formatOffer(o) {
  const now = new Date();
  const started = !o.start_date || new Date(o.start_date) <= now;
  const notEnded = !o.end_date || new Date(o.end_date) >= now;
  return {
    id: o.id,
    name: o.name,
    description: o.description,
    discountValue: num(o.discount_value),
    productId: o.product_id,
    productName: o.product_name || null,
    categoryId: o.category_id,
    categoryName: o.category_name || null,
    minOrderValue: num(o.min_order_value),
    maxDiscount: o.max_discount ? num(o.max_discount) : null,
    startDate: o.start_date,
    endDate: o.end_date,
    isActive: o.is_active,
    isLive: o.is_active && started && notEnded,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    offerType: o.offer_type,
    appliesTo: o.applies_to,
    imageUrl: o.image_url || null,
    showAsBanner: o.show_as_banner ?? false,
    showInAnnouncement: o.show_in_announcement ?? false,
    bannerId: o.banner_id || null
  };
}

// ==================================================================
// PUBLIC — GET /api/offers
// All currently live offers with product/category names joined.
// Used by: Public Offers page, product detail discount badge.
// ==================================================================
async function getActiveOffers(req, res) {
  console.log({ route: "GET /api/offers", status: "fetching active offers" });
  try {
    const result = await db.query(
      `SELECT
         o.*,
         p.name_en  AS product_name,
         c.name_en  AS category_name,
         b.id       AS banner_id
       FROM offers o
       LEFT JOIN products   p ON p.id = o.product_id
       LEFT JOIN categories c ON c.id = o.category_id
       LEFT JOIN banners    b ON b.linked_offer_id = o.id
       WHERE o.is_active = TRUE
         AND (o.start_date IS NULL OR o.start_date <= NOW())
         AND (o.end_date   IS NULL OR o.end_date   >= NOW())
       ORDER BY o.created_at DESC`
    );
    console.log({ route: "GET /api/offers", status: 200, count: result.rows.length });
    return res.json({ success: true, offers: result.rows.map(formatOffer) });
  } catch (err) {
    console.error({ route: "GET /api/offers", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// PUBLIC — GET /api/offers/active-storewide
// The single currently-live applies_to='all' offer, or null.
// Used by the storefront to show an automatic "spend ₹X, get Y% off"
// banner with no code required. Newest live store-wide offer wins if
// more than one somehow exists (createOffer guards against creating
// a second one while one is already live — see below).
// ==================================================================
async function getActiveStoreWideOffer(req, res) {
  console.log({ route: "GET /api/offers/active-storewide", status: "fetching active store-wide offer" });
  try {
    const result = await db.query(
      `SELECT * FROM offers
       WHERE applies_to = 'all'
         AND is_active = TRUE
         AND (start_date IS NULL OR start_date <= NOW())
         AND (end_date   IS NULL OR end_date   >= NOW())
       ORDER BY created_at DESC
       LIMIT 1`
    );
    if (result.rows.length === 0) {
      console.log({ route: "GET /api/offers/active-storewide", status: 200, found: false });
      return res.json({ success: true, offer: null });
    }
    const o = result.rows[0];
    console.log({ route: "GET /api/offers/active-storewide", status: 200, found: true, offerId: o.id });
    return res.json({
      success: true,
      offer: {
        discountValue: num(o.discount_value),
        offerType: o.offer_type,
        maxDiscount: o.max_discount ? num(o.max_discount) : null,
        minOrderValue: num(o.min_order_value),
      }
    });
  } catch (err) {
    console.error({ route: "GET /api/offers/active-storewide", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/offers/all
// All offers including inactive and expired — for admin manage screen.
// ==================================================================
async function getAllOffers(req, res) {
  console.log({ route: "GET /api/offers/all", status: "fetching all offers" });
  try {
    const result = await db.query(
      `SELECT
         o.*,
         p.name_en  AS product_name,
         c.name_en  AS category_name,
         b.id       AS banner_id
       FROM offers o
       LEFT JOIN products   p ON p.id = o.product_id
       LEFT JOIN categories c ON c.id = o.category_id
       LEFT JOIN banners    b ON b.linked_offer_id = o.id
       ORDER BY o.created_at DESC`
    );
    console.log({ route: "GET /api/offers/all", status: 200, count: result.rows.length });
    return res.json({ success: true, offers: result.rows.map(formatOffer) });
  } catch (err) {
    console.error({ route: "GET /api/offers/all", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/offers/:id
// Single offer detail.
// ==================================================================
async function getOfferById(req, res) {
  const { id } = req.query;
  console.log({ route: "GET /api/offers/get-by-id", offerId: id, status: "fetching offer by id" });
  if (!id) {
    console.log({ route: "GET /api/offers/get-by-id", status: 400, message: "id is required" });
    return res.status(400).json({ success: false, message: "id is required" });
  }
  try {
    const result = await db.query(
      `SELECT o.*, p.name_en AS product_name, c.name_en AS category_name, b.id AS banner_id
       FROM offers o
       LEFT JOIN products   p ON p.id = o.product_id
       LEFT JOIN categories c ON c.id = o.category_id
       LEFT JOIN banners    b ON b.linked_offer_id = o.id
       WHERE o.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "GET /api/offers/get-by-id", offerId: id, status: 404, message: "Offer not found" });
      return res.status(404).json({ success: false, message: "Offer not found" });
    }
    console.log({ route: "GET /api/offers/get-by-id", offerId: id, status: 200 });
    return res.json({ success: true, offer: formatOffer(result.rows[0]) });
  } catch (err) {
    console.error({ route: "GET /api/offers/get-by-id", offerId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — POST /api/offers
// Create a new offer campaign.
// Body: { name, description?, discountValue, productId?, categoryId?,
//         minOrderValue?, maxDiscount?, startDate?, endDate?, isActive?,
//         offerType?, appliesTo? }
// minOrderValue is only meaningful for appliesTo === "all" — a per-product
// or per-category price reduction must never depend on total cart value.
// ==================================================================
async function createOffer(req, res) {
  let {
    name, description, discountValue,
    productId, categoryId,
    minOrderValue, maxDiscount,
    startDate, endDate, isActive,
    offerType, appliesTo,
    showAsBanner, showInAnnouncement,
    bannerId
  } = req.body;
  let imageUrl = null;
  console.log({ route: "POST /api/offers", body: { name, discountValue, productId, categoryId, minOrderValue, maxDiscount, startDate, endDate, isActive, offerType, appliesTo, showAsBanner, showInAnnouncement, bannerId }, status: "creating offer" });

  if (!name || discountValue == null) {
    console.log({ route: "POST /api/offers", status: 400, message: "name and discountValue are required" });
    return res.status(400).json({ success: false, message: "name and discountValue are required" });
  }

  const type = offerType || "percentage";
  const val = parseFloat(discountValue) || 0;
  if (type === "percentage") {
    if (val <= 0 || val > 100) {
      console.log({ route: "POST /api/offers", status: 400, message: "discountValue must be between 1 and 100" });
      return res.status(400).json({ success: false, message: "discountValue must be between 1 and 100 (percent)" });
    }
  } else if (type === "flat") {
    if (val <= 0 || val > 10000) {
      console.log({ route: "POST /api/offers", status: 400, message: "discountValue must be greater than 0 and less than or equal to ₹10,000" });
      return res.status(400).json({ success: false, message: "discountValue must be greater than 0 and less than or equal to ₹10,000" });
    }
  } else {
    return res.status(400).json({ success: false, message: "Invalid offerType" });
  }

  const applies = appliesTo || "all";
  if (applies === "product") {
    if (!productId) {
      return res.status(400).json({ success: false, message: "Select a product" });
    }
    if (categoryId) {
      return res.status(400).json({ success: false, message: "Category must not be set for product-specific offers" });
    }
  } else if (applies === "category") {
    if (!categoryId) {
      return res.status(400).json({ success: false, message: "Select a category" });
    }
    if (productId) {
      return res.status(400).json({ success: false, message: "Product must not be set for category-specific offers" });
    }
  } else if (applies === "all") {
    if (productId || categoryId) {
      return res.status(400).json({ success: false, message: "Product and category must not be set for store-wide offers" });
    }
  } else {
    return res.status(400).json({ success: false, message: "Invalid appliesTo" });
  }

  // Only store-wide offers may carry a minimum order value — a product/category
  // price reduction must never depend on total cart value.
  if (applies !== "all" && Number(minOrderValue) > 0) {
    console.log({ route: "POST /api/offers", status: 400, message: "minOrderValue not allowed for product/category offers" });
    return res.status(400).json({ success: false, message: "Minimum order value can only be set on store-wide offers" });
  }
  const finalMinOrderValue = applies === "all" ? (minOrderValue || 0) : 0;

  if (applies === "all") {
    const liveAllOffer = await db.query(
      `SELECT id FROM offers
       WHERE applies_to = 'all'
         AND is_active = TRUE
         AND (start_date IS NULL OR start_date <= NOW())
         AND (end_date   IS NULL OR end_date   >= NOW())`
    );
    if (liveAllOffer.rows.length > 0) {
      console.log({ route: "POST /api/offers", status: 409, message: "a store-wide offer is already live" });
      return res.status(409).json({ success: false, message: "A store-wide offer is already live. Deactivate or end it before creating another." });
    }
  }

  const asBool = (v) => v === true || v === "true";
  const finalShowAsBanner = asBool(showAsBanner);
  const finalShowInAnnouncement = asBool(showInAnnouncement);
  const finalBannerId = bannerId && bannerId !== "" ? parseInt(bannerId, 10) : null;

  if (finalShowAsBanner && finalBannerId) {
    const conflictRes = await db.query(
      `SELECT o.name FROM offers o
       JOIN banners b ON b.linked_offer_id = o.id
       WHERE b.id = $1
         AND o.is_active = TRUE
         AND (o.start_date IS NULL OR o.start_date <= NOW())
         AND (o.end_date   IS NULL OR o.end_date   >= NOW())`,
      [finalBannerId]
    );
    if (conflictRes.rows.length > 0) {
      console.log({ route: "POST /api/offers", status: 409, message: "Selected banner is already linked to a different live offer" });
      return res.status(409).json({
        success: false,
        message: `Selected banner is already linked to a different live offer: "${conflictRes.rows[0].name}"`
      });
    }
  }

  try {
    const result = await db.query(
      `INSERT INTO offers
         (name, description, discount_value, product_id, category_id,
          min_order_value, max_discount, start_date, end_date, is_active,
          offer_type, applies_to, image_url, show_as_banner, show_in_announcement,
          banner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        name.trim(),
        description || null,
        discountValue,
        applies === "product" ? productId : null,
        applies === "category" ? categoryId : null,
        finalMinOrderValue,
        maxDiscount || null,
        startDate || null,
        endDate || null,
        isActive ?? true,
        type,
        applies,
        imageUrl,
        finalShowAsBanner,
        finalShowInAnnouncement,
        finalBannerId
      ]
    );

    const newOffer = result.rows[0];

    // Post-create side effects
    try {
      let productName = null;
      if (newOffer.applies_to === "product" && newOffer.product_id) {
        const prodRes = await db.query("SELECT name_en FROM products WHERE id = $1", [newOffer.product_id]);
        productName = prodRes.rows[0]?.name_en || null;
      }
      let categoryName = null;
      if (newOffer.applies_to === "category" && newOffer.category_id) {
        const catRes = await db.query("SELECT name_en FROM categories WHERE id = $1", [newOffer.category_id]);
        categoryName = catRes.rows[0]?.name_en || null;
      }

      const textInfo = buildBannerText(newOffer, productName, categoryName);

      // 1. Link to existing Banner + Slide text overlay
      if (finalShowAsBanner && finalBannerId) {
        await db.query(
          `INSERT INTO btext (banner_id, heading, subtext, is_active, linked_offer_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [finalBannerId, textInfo.heading, textInfo.subtext, newOffer.is_active, newOffer.id]
        );
        await db.query(
          `UPDATE banners SET linked_offer_id = $1, updated_at = NOW() WHERE id = $2`,
          [newOffer.id, finalBannerId]
        );
        console.log(`Attached btext overlay and linked banner ${finalBannerId} to offer ${newOffer.id}`);
      }

      // 2. Auto-drive site Announcement
      if (finalShowInAnnouncement) {
        await updateSettingValue("announcementText", textInfo.announcement);
        await updateSettingValue("announcementEnabled", "true");
        await updateSettingValue("announcement_offer_owner", newOffer.id);
        console.log(`Auto-driven site announcement for offer ${newOffer.id}`);
      }
    } catch (sideError) {
      console.error("Warning: post-create offer side effects failed:", sideError.message);
    }

    console.log({
      route: "POST /api/offers",
      status: 201,
      offerId: newOffer.id,
      showAsBanner: finalShowAsBanner,
      showInAnnouncement: finalShowInAnnouncement
    });
    return res.status(201).json({ success: true, message: "Offer created", offer: formatOffer(newOffer) });
  } catch (err) {
    console.error({ route: "POST /api/offers", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/offers/:id
// Update an existing offer. Only send fields you want to change.
// ==================================================================
async function updateOffer(req, res) {
  let {
    id, name, description, discountValue,
    productId, categoryId,
    minOrderValue, maxDiscount,
    startDate, endDate, isActive,
    offerType, appliesTo,
    showAsBanner, showInAnnouncement,
    bannerId
  } = req.body;
  console.log({ route: "PUT /api/offers/update-offer", offerId: id, body: { name, description, discountValue, productId, categoryId, minOrderValue, maxDiscount, startDate, endDate, isActive, offerType, appliesTo, showAsBanner, showInAnnouncement, bannerId }, status: "updating offer" });

  if (!id) {
    console.log({ route: "PUT /api/offers/update-offer", status: 400, message: "id is required" });
    return res.status(400).json({ success: false, message: "id is required" });
  }

  const asBool = (v) => v === true || v === "true";

  try {
    const existingRes = await db.query("SELECT * FROM offers WHERE id = $1", [id]);
    if (existingRes.rows.length === 0) {
      console.log({ route: "PUT /api/offers/update-offer", offerId: id, status: 404, message: "Offer not found" });
      return res.status(404).json({ success: false, message: "Offer not found" });
    }
    const existing = existingRes.rows[0];

    const currentType = offerType !== undefined ? offerType : existing.offer_type;
    const currentVal = discountValue !== undefined ? parseFloat(discountValue) : parseFloat(existing.discount_value);

    if (currentType === "percentage") {
      if (currentVal <= 0 || currentVal > 100) {
        return res.status(400).json({ success: false, message: "discountValue must be between 1 and 100 (percent)" });
      }
    } else if (currentType === "flat") {
      if (currentVal <= 0 || currentVal > 10000) {
        return res.status(400).json({ success: false, message: "discountValue must be greater than 0 and less than or equal to ₹10,000" });
      }
    } else {
      return res.status(400).json({ success: false, message: "Invalid offerType" });
    }

    const currentApplies = appliesTo !== undefined ? appliesTo : existing.applies_to;
    let finalProdId = productId !== undefined ? (productId || null) : existing.product_id;
    let finalCatId = categoryId !== undefined ? (categoryId || null) : existing.category_id;

    if (currentApplies === "all") {
      finalProdId = null;
      finalCatId = null;
    } else if (currentApplies === "product") {
      finalCatId = null;
      if (!finalProdId) {
        return res.status(400).json({ success: false, message: "Select a product" });
      }
    } else if (currentApplies === "category") {
      finalProdId = null;
      if (!finalCatId) {
        return res.status(400).json({ success: false, message: "Select a category" });
      }
    } else {
      return res.status(400).json({ success: false, message: "Invalid appliesTo" });
    }

    // Only store-wide offers may carry a minimum order value.
    if (currentApplies !== "all" && minOrderValue !== undefined && Number(minOrderValue) > 0) {
      return res.status(400).json({ success: false, message: "Minimum order value can only be set on store-wide offers" });
    }

    if (currentApplies === "all") {
      const liveAllOffer = await db.query(
        `SELECT id FROM offers
         WHERE applies_to = 'all'
           AND is_active = TRUE
           AND (start_date IS NULL OR start_date <= NOW())
           AND (end_date   IS NULL OR end_date   >= NOW())
           AND id != $1`
      , [id]);
      const willBeLive = (isActive !== undefined ? isActive : existing.is_active) === true;
      if (willBeLive && liveAllOffer.rows.length > 0) {
        return res.status(409).json({ success: false, message: "A store-wide offer is already live. Deactivate or end it before activating another." });
      }
    }

    const finalName = name !== undefined ? name.trim() : existing.name;
    const finalDesc = description !== undefined ? (description || null) : existing.description;
    const finalMinOrder = currentApplies === "all"
      ? (minOrderValue !== undefined ? minOrderValue : existing.min_order_value)
      : 0;
    const finalMaxDiscount = maxDiscount !== undefined ? (maxDiscount || null) : existing.max_discount;
    const finalStartDate = startDate !== undefined ? (startDate || null) : existing.start_date;
    const finalEndDate = endDate !== undefined ? (endDate || null) : existing.end_date;
    const finalIsActive = isActive !== undefined ? isActive : existing.is_active;
    const finalImageUrl = existing.image_url;

    const finalShowAsBanner = showAsBanner !== undefined ? asBool(showAsBanner) : existing.show_as_banner;
    const finalShowInAnnouncement = showInAnnouncement !== undefined ? asBool(showInAnnouncement) : existing.show_in_announcement;
    const finalBannerId = bannerId && bannerId !== "" ? parseInt(bannerId, 10) : null;

    if (finalShowAsBanner && finalBannerId) {
      const conflictRes = await db.query(
        `SELECT o.name FROM offers o
         JOIN banners b ON b.linked_offer_id = o.id
         WHERE b.id = $1
           AND o.id != $2
           AND o.is_active = TRUE
           AND (o.start_date IS NULL OR o.start_date <= NOW())
           AND (o.end_date   IS NULL OR o.end_date   >= NOW())`,
        [finalBannerId, id]
      );
      if (conflictRes.rows.length > 0) {
        console.log({ route: "PUT /api/offers/update-offer", status: 409, message: "Selected banner is already linked to a different live offer" });
        return res.status(409).json({
          success: false,
          message: `Selected banner is already linked to a different live offer: "${conflictRes.rows[0].name}"`
        });
      }
    }

    const result = await db.query(
      `UPDATE offers SET
         name            = $1,
         description     = $2,
         discount_value  = $3,
         product_id      = $4,
         category_id     = $5,
         min_order_value = $6,
         max_discount    = $7,
         start_date      = $8,
         end_date        = $9,
         is_active       = $10,
         offer_type      = $11,
         applies_to      = $12,
         image_url       = $13,
         show_as_banner  = $14,
         show_in_announcement = $15,
         banner_id       = $16,
         updated_at      = NOW()
       WHERE id = $17
       RETURNING *`,
      [
        finalName,
        finalDesc,
        currentVal,
        finalProdId,
        finalCatId,
        finalMinOrder,
        finalMaxDiscount,
        finalStartDate,
        finalEndDate,
        finalIsActive,
        currentType,
        currentApplies,
        finalImageUrl,
        finalShowAsBanner,
        finalShowInAnnouncement,
        finalBannerId,
        id
      ]
    );

    const updatedOffer = result.rows[0];

    // Post-update side effects
    try {
      let productName = null;
      if (updatedOffer.applies_to === "product" && updatedOffer.product_id) {
        const prodRes = await db.query("SELECT name_en FROM products WHERE id = $1", [updatedOffer.product_id]);
        productName = prodRes.rows[0]?.name_en || null;
      }
      let categoryName = null;
      if (updatedOffer.applies_to === "category" && updatedOffer.category_id) {
        const catRes = await db.query("SELECT name_en FROM categories WHERE id = $1", [updatedOffer.category_id]);
        categoryName = catRes.rows[0]?.name_en || null;
      }

      const textInfo = buildBannerText(updatedOffer, productName, categoryName);

      // --- BANNER OVERLAY SYNC ---
      const oldBannerRes = await db.query("SELECT id FROM banners WHERE linked_offer_id = $1", [updatedOffer.id]);
      const oldBannerId = oldBannerRes.rows[0]?.id;

      if (finalShowAsBanner && finalBannerId) {
        if (oldBannerId === finalBannerId) {
          // Sync overlay text in place
          const autoBtextRes = await db.query(
            `SELECT bt_id FROM btext WHERE banner_id = $1 AND linked_offer_id = $2 LIMIT 1`,
            [finalBannerId, updatedOffer.id]
          );
          const autoBtextId = autoBtextRes.rows[0]?.bt_id;
          if (autoBtextId) {
            await db.query(
              `UPDATE btext SET heading = $1, subtext = $2, is_active = $3, updated_at = NOW() WHERE bt_id = $4`,
              [textInfo.heading, textInfo.subtext, updatedOffer.is_active, autoBtextId]
            );
          } else {
            await db.query(
              `INSERT INTO btext (banner_id, heading, subtext, is_active, linked_offer_id)
               VALUES ($1, $2, $3, $4, $5)`,
              [finalBannerId, textInfo.heading, textInfo.subtext, updatedOffer.is_active, updatedOffer.id]
            );
          }
          // Also sync active state and content metadata of the banner itself
          await db.query(
            `UPDATE banners SET title = $1, subtitle = $2, is_active = $3, updated_at = NOW() WHERE id = $4`,
            [updatedOffer.name, updatedOffer.description, updatedOffer.is_active, finalBannerId]
          );
        } else {
          // Banner selection changed: detach from old banner
          if (oldBannerId) {
            await db.query(
              `DELETE FROM btext WHERE banner_id = $1 AND linked_offer_id = $2`,
              [oldBannerId, updatedOffer.id]
            );
            await db.query(
              `UPDATE banners SET linked_offer_id = NULL, updated_at = NOW() WHERE id = $1`,
              [oldBannerId]
            );
          }
          // Attach to new banner
          await db.query(
            `INSERT INTO btext (banner_id, heading, subtext, is_active, linked_offer_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [finalBannerId, textInfo.heading, textInfo.subtext, updatedOffer.is_active, updatedOffer.id]
          );
          await db.query(
            `UPDATE banners SET linked_offer_id = $1, title = $2, subtitle = $3, is_active = $4, updated_at = NOW() WHERE id = $5`,
            [updatedOffer.id, updatedOffer.name, updatedOffer.description, updatedOffer.is_active, finalBannerId]
          );
        }
      } else {
        // Toggled off or deselected: clean up link
        if (oldBannerId) {
          await db.query(
            `DELETE FROM btext WHERE banner_id = $1 AND linked_offer_id = $2`,
            [oldBannerId, updatedOffer.id]
          );
          await db.query(
            `UPDATE banners SET linked_offer_id = NULL, updated_at = NOW() WHERE id = $1`,
            [oldBannerId]
          );
        }
      }

      // --- ANNOUNCEMENT SYNC ---
      const ownerRes = await db.query("SELECT value FROM settings WHERE key = 'announcement_offer_owner'");
      const currentOwner = ownerRes.rows[0]?.value || "";

      const now = new Date();
      const started = !updatedOffer.start_date || new Date(updatedOffer.start_date) <= now;
      const notEnded = !updatedOffer.end_date || new Date(updatedOffer.end_date) >= now;
      const isOfferLive = updatedOffer.is_active && started && notEnded;

      if (!isOfferLive && String(currentOwner) === String(updatedOffer.id)) {
        await updateSettingValue("announcementEnabled", "false");
        await updateSettingValue("announcement_offer_owner", "");
        console.log(`Disabled announcement because owner offer ${updatedOffer.id} is inactive or expired`);
      } else if (finalShowInAnnouncement && isOfferLive) {
        await updateSettingValue("announcementText", textInfo.announcement);
        await updateSettingValue("announcementEnabled", "true");
        await updateSettingValue("announcement_offer_owner", updatedOffer.id);
        console.log(`Updated announcement for offer ${updatedOffer.id} to: ${textInfo.announcement}`);
      } else if (!finalShowInAnnouncement && String(currentOwner) === String(updatedOffer.id)) {
        await updateSettingValue("announcementEnabled", "false");
        await updateSettingValue("announcement_offer_owner", "");
        console.log(`Disabled announcement since flag showInAnnouncement was toggled false for owner offer ${updatedOffer.id}`);
      }
    } catch (sideError) {
      console.error("Warning: post-update offer side effects failed:", sideError.message);
    }

    console.log({
      route: "PUT /api/offers/update-offer",
      offerId: id,
      status: 200,
      showAsBanner: finalShowAsBanner,
      showInAnnouncement: finalShowInAnnouncement
    });
    return res.json({ success: true, message: "Offer updated", offer: formatOffer(updatedOffer) });
  } catch (err) {
    console.error({ route: "PUT /api/offers/update-offer", offerId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — DELETE /api/offers/:id
// ==================================================================
async function deleteOffer(req, res) {
  const { id } = req.body;
  console.log({ route: "DELETE /api/offers/delete-offer", offerId: id, status: "deleting offer" });
  if (!id) {
    return res.status(400).json({ success: false, message: "id is required" });
  }
  try {
    const ownerRes = await db.query("SELECT value FROM settings WHERE key = 'announcement_offer_owner'");
    const currentOwner = ownerRes.rows[0]?.value || "";
    if (String(currentOwner) === String(id)) {
      await updateSettingValue("announcementEnabled", "false");
      await updateSettingValue("announcement_offer_owner", "");
      console.log(`Deactivating announcement since owning offer ${id} is being deleted`);
    }

    const result = await db.query(
      "DELETE FROM offers WHERE id = $1 RETURNING id, image_url", [id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "DELETE /api/offers/delete-offer", offerId: id, status: 404, message: "Offer not found" });
      return res.status(404).json({ success: false, message: "Offer not found" });
    }

    const deletedOffer = result.rows[0];
    if (deletedOffer.image_url) {
      await deleteFromSupabase(deletedOffer.image_url);
    }

    console.log({ route: "DELETE /api/offers/delete-offer", offerId: id, status: 200 });
    return res.json({ success: true, message: "Offer deleted" });
  } catch (err) {
    console.error({ route: "DELETE /api/offers/delete-offer", offerId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  getActiveOffers, getActiveStoreWideOffer,
  getAllOffers, getOfferById,
  createOffer, updateOffer, deleteOffer
};
