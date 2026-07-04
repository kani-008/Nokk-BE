const crypto = require("crypto");
const db = require("../config/db.js");
const { createNotification } = require("./notificationController.js");
const { getRazorpayClient, RAZORPAY_KEY_ID } = require("../config/razorpay.js");
const { OFFER_MATCH_LATERAL_SQL } = require("../config/offerMatching.js");

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const num = (v) => parseFloat(v) || 0;

// ------------------------------------------------------------------
// resolveOfferAdjustedPrices — batched lookup of the single best-matching
// live product/category offer for each product id, using the exact same
// LATERAL-join predicate as v_products_with_price (OFFER_MATCH_LATERAL_SQL)
// so the two can never silently diverge. Store-wide ("all") offers are
// matched separately elsewhere — never returned here.
//
// productCategoryPairs: [{ productId, categoryId }]  (categoryId may be null)
// Returns: Map<productId, { offerId, offerType, discountValue, maxDiscount } | null>
// ------------------------------------------------------------------
async function resolveOfferAdjustedPrices(client, productCategoryPairs) {
  const map = new Map();
  if (!productCategoryPairs.length) return map;

  const productIds = productCategoryPairs.map((x) => x.productId);
  const categoryIds = productCategoryPairs.map((x) => x.categoryId);

  const result = await client.query(
    `SELECT p.id AS product_id, ao.id AS offer_id, ao.offer_type, ao.discount_value, ao.max_discount
     FROM UNNEST($1::uuid[], $2::uuid[]) AS p(id, category_id)
     ${OFFER_MATCH_LATERAL_SQL}`,
    [productIds, categoryIds]
  );

  result.rows.forEach((r) => {
    map.set(r.product_id, r.offer_id ? {
      offerId: r.offer_id,
      offerType: r.offer_type,
      discountValue: num(r.discount_value),
      maxDiscount: r.max_discount != null ? num(r.max_discount) : null,
    } : null);
  });
  return map;
}

// ------------------------------------------------------------------
// applyOfferToPrice — same percentage/flat/max-discount math used by the
// view's effective_min_price computation, applied to a resolved variant price.
// ------------------------------------------------------------------
function applyOfferToPrice(price, offer) {
  if (!offer) return price;
  if (offer.offerType === "percentage") {
    const rawDiscount = (price * offer.discountValue) / 100;
    const discount = offer.maxDiscount != null ? Math.min(rawDiscount, offer.maxDiscount) : rawDiscount;
    return Math.max(price - discount, 0);
  }
  if (offer.offerType === "flat") {
    return Math.max(price - offer.discountValue, 0);
  }
  return price;
}

function formatOrder(ord, items = [], timeline = []) {
  return {
    id: ord.id,
    createdAt: ord.created_at,
    updatedAt: ord.updated_at,
    customerName: ord.customer_name,
    customerEmail: ord.customer_email,
    customerPhone: ord.customer_phone,
    subtotal: num(ord.subtotal),
    deliveryCharge: num(ord.delivery_charge),
    discount: num(ord.discount),
    couponApplied: ord.coupon_applied,
    total: num(ord.total),
    status: ord.status,
    paymentStatus: ord.payment_status,
    paymentMethod: ord.payment_method,
    upiReference: ord.upi_reference || null,
    razorpayOrderId: ord.razorpay_order_id || null,
    razorpayPaymentId: ord.razorpay_payment_id || null,
    courierName: ord.courier_name || null,
    trackingNumber: ord.tracking_number || null,
    trackingUrl: ord.tracking_url || null,
    address: {
      addressLine1: ord.shipping_address_line1,
      addressLine2: ord.shipping_address_line2,
      taluk: ord.shipping_taluk,
      city: ord.shipping_city,
      state: ord.shipping_state,
      pincode: ord.shipping_pincode
    },
    items,
    timeline
  };
}

function formatItem(i) {
  return {
    id: i.id,
    productId: i.product_id,
    variantId: i.variant_id,
    name: i.name_ta ? `${i.name_en} (${i.name_ta})` : i.name_en,
    weight: i.weight,
    price: num(i.price),
    quantity: parseInt(i.quantity),
    total: num(i.price) * parseInt(i.quantity),
    imageUrl: i.primary_image || null,
    slug: i.slug || null,
    isReviewed: i.is_reviewed === true,
  };
}

// ------------------------------------------------------------------
// Single order — used by detail endpoints and checkout response.
//
// reviewerUserId is OPTIONAL and must only be passed by customer-facing
// "my orders" callers (e.g. getMyOrderById) — it left-joins product_reviews
// scoped to that user so formatItem can flag isReviewed per item. Admin
// order-detail callers must omit it so admin listings never get this join.
// ------------------------------------------------------------------
async function fetchItemsAndTimeline(orderId, reviewerUserId = null) {
  const [itemsRes, timelineRes] = await Promise.all([
    db.query(
      `SELECT oi.id, oi.product_id, oi.variant_id, oi.name_en, oi.name_ta, oi.weight, oi.price, oi.quantity,
              pi.image_url AS primary_image, p.slug,
              (pr.id IS NOT NULL) AS is_reviewed
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN product_images pi ON pi.product_id = oi.product_id AND pi.is_primary = TRUE
       LEFT JOIN product_reviews pr ON pr.product_id = oi.product_id AND pr.user_id = $2
       WHERE oi.order_id = $1`,
      [orderId, reviewerUserId]
    ),
    db.query(
      `SELECT status, notes, created_at AS date
       FROM order_timelines WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId]
    )
  ]);
  return {
    items: itemsRes.rows.map(formatItem),
    timeline: timelineRes.rows
  };
}

// ------------------------------------------------------------------
// Batch fetch — used by listing endpoints to eliminate N+1.
// Fetches items + timelines for ALL orders in exactly 2 queries
// regardless of how many orders are in the list.
//
// reviewerUserId is OPTIONAL and must only be passed by customer-facing
// "my orders" callers (e.g. getMyOrders) — see fetchItemsAndTimeline above
// for why admin listing callers must omit it.
// ------------------------------------------------------------------
async function fetchItemsAndTimelinesForOrders(orderIds, reviewerUserId = null) {
  if (!orderIds.length) return { itemsMap: {}, timelinesMap: {} };

  const [itemsRes, timelineRes] = await Promise.all([
    db.query(
      `SELECT oi.id, oi.order_id, oi.product_id, oi.variant_id, oi.name_en, oi.name_ta, oi.weight, oi.price, oi.quantity,
              pi.image_url AS primary_image, p.slug,
              (pr.id IS NOT NULL) AS is_reviewed
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN product_images pi ON pi.product_id = oi.product_id AND pi.is_primary = TRUE
       LEFT JOIN product_reviews pr ON pr.product_id = oi.product_id AND pr.user_id = $2
       WHERE oi.order_id = ANY($1)`,
      [orderIds, reviewerUserId]
    ),
    db.query(
      `SELECT order_id, status, notes, created_at AS date
       FROM order_timelines WHERE order_id = ANY($1) ORDER BY created_at ASC`,
      [orderIds]
    )
  ]);

  const itemsMap = {};
  itemsRes.rows.forEach(i => {
    if (!itemsMap[i.order_id]) itemsMap[i.order_id] = [];
    itemsMap[i.order_id].push(formatItem(i));
  });

  const timelinesMap = {};
  timelineRes.rows.forEach(t => {
    if (!timelinesMap[t.order_id]) timelinesMap[t.order_id] = [];
    timelinesMap[t.order_id].push(t);
  });

  return { itemsMap, timelinesMap };
}

// ------------------------------------------------------------------
// Generate unique ORD-XXXX id (queryFn lets callers pass a client)
// ------------------------------------------------------------------
async function generateOrderId(queryFn) {
  let orderId, isUnique = false;
  while (!isUnique) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    orderId = `ORD-${rand}`;
    const check = await queryFn("SELECT id FROM orders WHERE id = $1", [orderId]);
    if (check.rows.length === 0) isUnique = true;
  }
  return orderId;
}

// ------------------------------------------------------------------
// _createOrderCore — shared internal order-creation logic.
//
// MUST be called inside an already-open transaction (BEGIN issued by caller).
// Handles: combo expansion, variant locking, stock check, offer/combo/coupon/
// store-wide-offer/total recomputation, INSERT orders + order_items +
// order_timelines, coupon usage increment, cart clear. Does NOT commit —
// caller commits after this returns.
//
// Parameters:
//   client              — pg transaction client
//   userId              — authenticated user's UUID
//   userEmail           — user's email (may be null)
//   items               — array of EITHER
//                           { productId, weight, nameEn, nameTa?, quantity }   (ordinary line)
//                           { comboId, comboQty, nameEn? }                     (combo line — expanded
//                             server-side from combo_items; the client's own claim about what's
//                             inside a combo, or its price, is never trusted)
//   address             — { fullName, phone, addressLine1, addressLine2?, city, state?, pincode }
//   couponApplied       — coupon code string or null
//   paymentMethod       — "cod" | "upi" | "razorpay_upi" | "razorpay_card" | ...
//   paymentStatus       — "pending" | "paid"
//   expectedTotal       — if provided, validates server-computed total against this value
//   razorpayOrderId     — Razorpay order ID (null for cod/upi)
//   razorpayPaymentId   — Razorpay payment ID (null for cod/upi)
//   razorpaySignature   — HMAC signature (null for cod/upi)
//
// Returns: { orderId, serverTotal, serverSubtotal, serverDeliveryCharge,
//            serverDiscount, comboDiscountTotal, storeWideOfferDiscount }
// ------------------------------------------------------------------
async function _createOrderCore(client, {
  userId, userEmail, items, address, couponApplied,
  paymentMethod, paymentStatus, expectedTotal = null,
  razorpayOrderId = null, razorpayPaymentId = null, razorpaySignature = null,
}) {
  const tag = `[_createOrderCore userId=${userId} method=${paymentMethod}]`;
  console.log(`${tag} START — items: ${items.length}, coupon: ${couponApplied || "none"}, paymentStatus: ${paymentStatus}`);

  // ------------------------------------------------------------------
  // STEP 1 — expand combo lines and resolve ordinary-item variant ids.
  // Incoming `items` entries are either:
  //   { productId, weight, nameEn, nameTa?, quantity }   — ordinary line
  //   { comboId, comboQty, nameEn? }                      — combo line
  // Combo lines are expanded server-side from combo_items — the client's
  // own claim about what's inside a combo is never trusted; only comboId
  // + comboQty are read from it. resolvedLines is the flat, order_items-
  // shaped result (1 row per member for combo lines).
  // ------------------------------------------------------------------
  console.log(`${tag} STEP 1 — expanding combo lines / resolving variant ids`);
  const resolvedLines = [];
  const comboGroups = new Map(); // comboId -> { name, totalPrice }

  for (const item of items) {
    if (item.comboId) {
      const comboQty = parseInt(item.comboQty) || 0;
      if (comboQty < 1) {
        const e = new Error("Invalid combo quantity");
        console.log(`${tag} STEP 1 FAIL — invalid comboQty for combo ${item.comboId}`);
        e.status = 400; throw e;
      }

      const comboRes = await client.query(
        `SELECT id, name, combo_price,
                (is_active AND (start_date IS NULL OR start_date <= NOW()) AND (end_date IS NULL OR end_date >= NOW())) AS is_live
         FROM combos WHERE id = $1`,
        [item.comboId]
      );
      if (comboRes.rows.length === 0 || !comboRes.rows[0].is_live) {
        const e = new Error(`This combo is no longer available. Please refresh your cart.`);
        console.log(`${tag} STEP 1 FAIL — combo ${item.comboId} not found or not live`);
        e.status = 400; throw e;
      }
      const combo = comboRes.rows[0];

      const memberRes = await client.query(
        `SELECT ci.product_id, ci.variant_id, ci.quantity, pv.weight_label, p.name_en, p.name_ta
         FROM combo_items ci
         JOIN product_variants pv ON pv.id = ci.variant_id
         JOIN products p ON p.id = ci.product_id
         WHERE ci.combo_id = $1`,
        [item.comboId]
      );
      if (memberRes.rows.length === 0) {
        const e = new Error(`"${combo.name}" has no items configured`);
        console.log(`${tag} STEP 1 FAIL — combo ${item.comboId} has no combo_items`);
        e.status = 400; throw e;
      }

      comboGroups.set(combo.id, { name: combo.name, totalPrice: parseFloat(combo.combo_price) * comboQty });
      for (const m of memberRes.rows) {
        resolvedLines.push({
          productId: m.product_id,
          variantId: m.variant_id,
          weight: m.weight_label,
          nameEn: m.name_en,
          nameTa: m.name_ta,
          quantity: m.quantity * comboQty,
          comboId: combo.id,
        });
      }
      console.log(`${tag} STEP 1 — combo "${combo.name}" x${comboQty} expanded to ${memberRes.rows.length} member row(s)`);
    } else {
      const varRes = await client.query(
        `SELECT pv.id, p.category_id
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
         WHERE pv.product_id = $1 AND pv.weight_label = $2 AND pv.is_active = TRUE`,
        [item.productId, item.weight]
      );
      if (varRes.rows.length === 0) {
        const e = new Error(`Variant not found: ${item.nameEn} (${item.weight})`);
        console.log(`${tag} STEP 1 FAIL — variant not found: ${item.nameEn} (${item.weight})`);
        e.status = 400; throw e;
      }
      resolvedLines.push({
        productId: item.productId,
        variantId: varRes.rows[0].id,
        categoryId: varRes.rows[0].category_id,
        weight: item.weight,
        nameEn: item.nameEn,
        nameTa: item.nameTa || null,
        quantity: item.quantity,
        comboId: null,
      });
    }
  }

  // Sort by variant_id before locking — closes a lock-ordering deadlock
  // window that's more likely to actually trigger now that combos make
  // concurrent purchases of the same popular bundle common.
  resolvedLines.sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));

  console.log(`${tag} STEP 1b — locking variants (sorted) and checking stock`);
  for (const line of resolvedLines) {
    const lockRes = await client.query(
      "SELECT id, stock_qty, price FROM product_variants WHERE id = $1 FOR UPDATE",
      [line.variantId]
    );
    if (lockRes.rows.length === 0 || lockRes.rows[0].stock_qty <= 0) {
      const msg = line.comboId
        ? `"${line.nameEn}" in your combo is currently unavailable`
        : `Product variant ${line.nameEn} (${line.weight}) is out of stock`;
      const e = new Error(msg);
      console.log(`${tag} STEP 1b FAIL — out of stock: ${line.nameEn} (${line.weight}) combo=${line.comboId || "none"}`);
      e.status = 400; throw e;
    }
    line.rawPrice = parseFloat(lockRes.rows[0].price);
    console.log(`${tag} STEP 1b — variant OK: ${line.nameEn} (${line.weight}) qty=${line.quantity} dbPrice=₹${line.rawPrice}`);
  }

  // ------------------------------------------------------------------
  // STEP 2 — apply product/category offers to non-combo lines (using the
  // exact same offer-matching predicate as v_products_with_price, via
  // OFFER_MATCH_LATERAL_SQL, so the two can never silently diverge).
  // Combo member lines ignore their own product/category offers entirely —
  // combo_price is an admin-authored all-in bundle price that always wins.
  // ------------------------------------------------------------------
  console.log(`${tag} STEP 2 — applying product/category offers to non-combo items`);
  const nonComboLines = resolvedLines.filter((l) => !l.comboId);
  const offerMap = await resolveOfferAdjustedPrices(
    client,
    nonComboLines.map((l) => ({ productId: l.productId, categoryId: l.categoryId }))
  );
  for (const line of nonComboLines) {
    const offer = offerMap.get(line.productId);
    line.finalPrice = parseFloat(applyOfferToPrice(line.rawPrice, offer).toFixed(2));
    if (offer) {
      console.log(`${tag} STEP 2 — offer applied to ${line.nameEn}: ₹${line.rawPrice} -> ₹${line.finalPrice} (offer ${offer.offerId})`);
    }
  }

  // ------------------------------------------------------------------
  // STEP 2b — distribute each combo's fixed combo_price across its member
  // rows (proportional to each member's individual price, remainder
  // absorbed by the last row so the group's rows sum exactly to
  // combo_price). Each row still records a real, derivable individual
  // price for reporting; the gap between individual-priced total and
  // combo_price accumulates into comboDiscountTotal (reporting only —
  // NOT subtracted again from the total, since it's already baked into
  // these distributed row prices).
  // ------------------------------------------------------------------
  console.log(`${tag} STEP 2b — distributing combo prices across member rows`);
  let comboDiscountTotal = 0;
  for (const [comboId, group] of comboGroups) {
    const memberLines = resolvedLines.filter((l) => l.comboId === comboId);
    const individualTotal = memberLines.reduce((s, l) => s + l.rawPrice * l.quantity, 0);
    comboDiscountTotal += Math.max(individualTotal - group.totalPrice, 0);

    let allocatedTotal = 0;
    memberLines.forEach((l, idx) => {
      const rowTotal = l.rawPrice * l.quantity;
      if (idx < memberLines.length - 1) {
        const shareTotal = parseFloat((rowTotal * (group.totalPrice / individualTotal)).toFixed(2));
        allocatedTotal += shareTotal;
        l.finalPrice = parseFloat((shareTotal / l.quantity).toFixed(2));
      } else {
        const remainderTotal = parseFloat((group.totalPrice - allocatedTotal).toFixed(2));
        l.finalPrice = parseFloat((remainderTotal / l.quantity).toFixed(2));
      }
    });
    console.log(`${tag} STEP 2b — combo "${group.name}": individualTotal=₹${individualTotal.toFixed(2)} comboPrice=₹${group.totalPrice} savings=₹${Math.max(individualTotal - group.totalPrice, 0).toFixed(2)}`);
  }
  comboDiscountTotal = parseFloat(comboDiscountTotal.toFixed(2));

  // Recompute subtotal from the fully resolved (offer/combo-adjusted) line
  // prices — client-sent prices are never trusted.
  let serverSubtotal = resolvedLines.reduce((s, l) => s + l.finalPrice * l.quantity, 0);
  serverSubtotal = parseFloat(serverSubtotal.toFixed(2));
  console.log(`${tag} STEP 2c — subtotal recomputed: ₹${serverSubtotal} (comboDiscountTotal=₹${comboDiscountTotal})`);

  // Fetch delivery settings
  const settingsRes = await client.query("SELECT key, value FROM settings");
  const settings = {};
  settingsRes.rows.forEach(r => {
    let val = r.value;
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (val !== "" && !isNaN(val)) val = Number(val);
    settings[r.key] = val;
  });
  const freeShippingThreshold = settings.freeShippingThreshold !== undefined ? Number(settings.freeShippingThreshold) : 499;
  // shippingCharge is the canonical key saved by the Settings page; flatDeliveryCharge is legacy
  const flatDeliveryCharge    = Number(settings.shippingCharge ?? settings.flatDeliveryCharge ?? 60);
  const minOrderValue         = settings.minOrderValue         !== undefined ? Number(settings.minOrderValue)         : 0;
  console.log(`${tag} STEP 3 — delivery settings: freeShippingThreshold=₹${freeShippingThreshold}, flatDeliveryCharge=₹${flatDeliveryCharge}, minOrderValue=₹${minOrderValue}`);

  // Enforce minimum order value (0 = no minimum)
  if (minOrderValue > 0 && serverSubtotal < minOrderValue) {
    console.log(`${tag} STEP 3 FAIL — subtotal ₹${serverSubtotal} below minOrderValue ₹${minOrderValue}`);
    const e = new Error(`Minimum order value of ₹${minOrderValue} required`);
    e.status = 400; throw e;
  }

  // Enforce payment method enabled
  const methodKey = {
    cod: "codEnabled",
    upi: "upiEnabled",
    razorpay_upi: "upiEnabled",
    razorpay: "cardEnabled",
    razorpay_card: "cardEnabled",
    razorpay_netbanking: "cardEnabled",
  }[paymentMethod];
  if (methodKey && settings[methodKey] === false) {
    console.log(`${tag} STEP 3 FAIL — payment method "${paymentMethod}" is disabled`);
    const e = new Error(`Payment method "${paymentMethod}" is currently unavailable`);
    e.status = 400; throw e;
  }

  // Validate coupon & recompute discount
  let serverDiscount = 0;
  let freeShippingCoupon = false;
  let appliedCouponId = null;

  if (couponApplied) {
    console.log(`${tag} STEP 4 — validating coupon: ${couponApplied}`);
    const couponCode = String(couponApplied).trim().toUpperCase();
    const couponRes = await client.query(
      "SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE FOR UPDATE",
      [couponCode]
    );
    if (couponRes.rows.length === 0) {
      console.log(`${tag} STEP 4 FAIL — invalid coupon: ${couponCode}`);
      const e = new Error("Invalid coupon code"); e.status = 400; throw e;
    }
    const c = couponRes.rows[0];
    appliedCouponId = c.id;
    if (c.expiry_date && new Date(c.expiry_date) < new Date()) {
      console.log(`${tag} STEP 4 FAIL — coupon expired: ${couponCode}, expiry: ${c.expiry_date}`);
      const e = new Error("Coupon has expired"); e.status = 400; throw e;
    }
    if (c.max_uses !== null && parseInt(c.usage_count) >= c.max_uses) {
      console.log(`${tag} STEP 4 FAIL — coupon usage limit reached: ${couponCode} (${c.usage_count}/${c.max_uses})`);
      const e = new Error("Coupon usage limit reached"); e.status = 400; throw e;
    }
    if (c.max_uses_per_user !== null) {
      const userUsageRes = await client.query(
        "SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_id = $1 AND user_id = $2",
        [c.id, userId]
      );
      const userUsageCount = parseInt(userUsageRes.rows[0].count) || 0;
      if (userUsageCount >= c.max_uses_per_user) {
        console.log(`${tag} STEP 4 FAIL — per-user coupon limit reached: ${couponCode}`);
        const e = new Error("You have reached your personal usage limit for this coupon");
        e.status = 400; throw e;
      }
    }
    if (serverSubtotal < parseFloat(c.min_order)) {
      console.log(`${tag} STEP 4 FAIL — subtotal ₹${serverSubtotal} below coupon min ₹${c.min_order}`);
      const e = new Error(`Minimum order of ₹${c.min_order} required for this coupon`); e.status = 400; throw e;
    }
    let computedDiscount = 0;
    if (c.discount_percent > 0) {
      computedDiscount = (serverSubtotal * c.discount_percent) / 100;
    } else if (parseFloat(c.discount_flat) > 0) {
      computedDiscount = parseFloat(c.discount_flat);
    }
    serverDiscount = Math.min(computedDiscount, serverSubtotal);
    serverDiscount = parseFloat(serverDiscount.toFixed(2));
    if (c.free_shipping === true || c.free_shipping === "true" || c.free_shipping === 1) {
      freeShippingCoupon = true;
    }
    console.log(`${tag} STEP 4 — coupon valid: discount=₹${serverDiscount}, freeShipping=${freeShippingCoupon}`);
  } else {
    console.log(`${tag} STEP 4 — no coupon applied`);
  }

  // Store-wide automatic offer — checked against the post-offer/combo,
  // pre-coupon subtotal (serverSubtotal), stacking on top of any coupon
  // discount exactly as coupons and this automatic discount are both
  // meant to apply independently.
  console.log(`${tag} STEP 4b — checking for a live store-wide offer`);
  let storeWideOfferDiscount = 0;
  const storeWideRes = await client.query(
    `SELECT * FROM offers
     WHERE applies_to = 'all' AND is_active = TRUE
       AND (start_date IS NULL OR start_date <= NOW())
       AND (end_date   IS NULL OR end_date   >= NOW())
     ORDER BY created_at DESC LIMIT 1`
  );
  if (storeWideRes.rows.length > 0) {
    const sw = storeWideRes.rows[0];
    const swMinOrder = parseFloat(sw.min_order_value) || 0;
    if (serverSubtotal >= swMinOrder) {
      let computed = 0;
      if (sw.offer_type === "percentage") {
        const raw = (serverSubtotal * parseFloat(sw.discount_value)) / 100;
        computed = sw.max_discount != null ? Math.min(raw, parseFloat(sw.max_discount)) : raw;
      } else if (sw.offer_type === "flat") {
        computed = parseFloat(sw.discount_value);
      }
      storeWideOfferDiscount = parseFloat(Math.min(computed, serverSubtotal).toFixed(2));
      console.log(`${tag} STEP 4b — store-wide offer "${sw.name}" applied: ₹${storeWideOfferDiscount}`);
    } else {
      console.log(`${tag} STEP 4b — store-wide offer "${sw.name}" live but subtotal ₹${serverSubtotal} below min ₹${swMinOrder}`);
    }
  } else {
    console.log(`${tag} STEP 4b — no live store-wide offer`);
  }

  // Recompute delivery charge
  let serverDeliveryCharge = serverSubtotal >= freeShippingThreshold ? 0 : flatDeliveryCharge;
  if (freeShippingCoupon) serverDeliveryCharge = 0;
  serverDeliveryCharge = parseFloat(serverDeliveryCharge.toFixed(2));

  // Recompute total — comboDiscountTotal is NOT subtracted here, it's
  // already baked into serverSubtotal via the distributed combo row prices
  // (STEP 2b); it's written to orders.combo_discount purely for reporting.
  const serverTotal = parseFloat((serverSubtotal - serverDiscount - storeWideOfferDiscount + serverDeliveryCharge).toFixed(2));
  console.log(`${tag} STEP 5 — totals: subtotal=₹${serverSubtotal} discount=₹${serverDiscount} storeWideDiscount=₹${storeWideOfferDiscount} comboDiscount(reporting)=₹${comboDiscountTotal} delivery=₹${serverDeliveryCharge} total=₹${serverTotal}`);

  // Validate against expected total if provided (used by checkout to catch UI drift)
  if (expectedTotal !== null) {
    const roundedExpected = parseFloat(parseFloat(expectedTotal).toFixed(2));
    if (Math.abs(roundedExpected - serverTotal) > 0.01) {
      console.log(`${tag} STEP 5 FAIL — total mismatch: client=₹${roundedExpected} server=₹${serverTotal}`);
      const e = new Error(`Order total mismatch. Client: ₹${roundedExpected}, Server: ₹${serverTotal}`);
      e.status = 400; throw e;
    }
    console.log(`${tag} STEP 5 — total validated against client value ₹${roundedExpected} ✓`);
  }

  const orderId = await generateOrderId((sql, params) => client.query(sql, params));
  console.log(`${tag} STEP 6 — generated orderId: ${orderId}`);
  const addrLine1 = address.addressLine1 || `${address.doorNo || ""} ${address.street || ""}`.trim();

  // Insert order using ONLY server-computed values
  await client.query(
    `INSERT INTO orders (
       id, user_id, customer_name, customer_email, customer_phone,
       subtotal, delivery_charge, discount, coupon_applied, total,
       status, payment_method, payment_status,
       shipping_address_line1, shipping_address_line2, shipping_taluk,
       shipping_city, shipping_state, shipping_pincode,
       razorpay_order_id, razorpay_payment_id, razorpay_signature,
       combo_discount, store_wide_discount
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      orderId, userId,
      address.fullName, userEmail || null, address.phone,
      serverSubtotal, serverDeliveryCharge, serverDiscount,
      couponApplied ? String(couponApplied).trim().toUpperCase() : null, serverTotal,
      paymentMethod, paymentStatus,
      addrLine1, address.addressLine2 || null, address.taluk || null,
      address.city, address.state || "Tamil Nadu", address.pincode,
      razorpayOrderId, razorpayPaymentId, razorpaySignature,
      comboDiscountTotal, storeWideOfferDiscount,
    ]
  );
  console.log(`${tag} STEP 7 — order row inserted: ${orderId}`);

  // Insert order items using the fully resolved (offer/combo-adjusted) lines
  for (const line of resolvedLines) {
    await client.query(
      `INSERT INTO order_items
         (order_id, product_id, variant_id, name_en, name_ta, weight, price, quantity, combo_id, combo_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [orderId, line.productId, line.variantId, line.nameEn, line.nameTa || null,
        line.weight, line.finalPrice, line.quantity,
        line.comboId, line.comboId ? comboGroups.get(line.comboId).name : null]
    );
    console.log(`${tag} STEP 7 — order_item inserted: ${line.nameEn} (${line.weight}) x${line.quantity} @ ₹${line.finalPrice}${line.comboId ? ` [combo: ${comboGroups.get(line.comboId).name}]` : ""}`);
  }

  // Track coupon usage so max_uses limits actually work
  if (couponApplied && appliedCouponId) {
    await client.query(
      "INSERT INTO coupon_usages (coupon_id, user_id, order_id) VALUES ($1, $2, $3)",
      [appliedCouponId, userId, orderId]
    );
    await client.query(
      "UPDATE coupons SET usage_count = usage_count + 1 WHERE id = $1",
      [appliedCouponId]
    );
    console.log(`${tag} STEP 8 — coupon usage tracked in coupon_usages and usage_count incremented: ${couponApplied}`);
  }

  // Initial timeline entry
  await client.query(
    "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'pending','Order placed by customer.')",
    [orderId]
  );
  console.log(`${tag} STEP 9 — timeline entry created`);

  // Clear user's cart
  const cartRes = await client.query("SELECT id FROM carts WHERE user_id = $1", [userId]);
  if (cartRes.rows.length > 0) {
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartRes.rows[0].id]);
    console.log(`${tag} STEP 10 — cart cleared for user`);
  } else {
    console.log(`${tag} STEP 10 — no cart found to clear`);
  }

  console.log(`${tag} DONE — orderId=${orderId} total=₹${serverTotal}`);
  return { orderId, serverTotal, serverSubtotal, serverDeliveryCharge, serverDiscount, comboDiscountTotal, storeWideOfferDiscount };
}

// ==================================================================
// POST /api/orders/checkout   (customer — login required)
// Body: { items, address, paymentMethod, couponApplied?,
//         subtotal, deliveryCharge, discount, total }
// ==================================================================
async function checkout(req, res) {
  const {
    items, address, paymentMethod,
    total,
    couponApplied
  } = req.body;
  console.log("=".repeat(60));
  console.log(`[CHECKOUT] START userId=${req.user.id}`);
  console.log(`[CHECKOUT] paymentMethod=${paymentMethod} clientTotal=₹${total} coupon=${couponApplied || "none"} items=${items?.length}`);
  console.log(`[CHECKOUT] address: ${address?.fullName}, ${address?.city}, ${address?.pincode}`);

  if (!items || !items.length || !address || !paymentMethod) {
    console.log(`[CHECKOUT] 400 — missing required fields`);
    return res.status(400).json({ success: false, message: "items, address and paymentMethod are required" });
  }
  if (!Array.isArray(items) || items.length > 50) {
    console.log(`[CHECKOUT] 400 — invalid items array (length=${items?.length})`);
    return res.status(400).json({ success: false, message: "Invalid items" });
  }
  if (!["cod", "upi"].includes(paymentMethod)) {
    console.log(`[CHECKOUT] 400 — invalid paymentMethod: ${paymentMethod}`);
    return res.status(400).json({ success: false, message: "Invalid payment method" });
  }
  if (!address.fullName || !address.phone || !address.addressLine1 || !address.city || !address.pincode) {
    console.log(`[CHECKOUT] 400 — incomplete address`);
    return res.status(400).json({ success: false, message: "Incomplete address — fullName, phone, addressLine1, city, pincode required" });
  }

  console.log(`[CHECKOUT] validation passed — opening DB transaction`);
  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const { orderId, serverTotal } = await _createOrderCore(client, {
      userId:        req.user.id,
      userEmail:     req.user.email || null,
      items, address, couponApplied,
      paymentMethod,
      paymentStatus: paymentMethod.toLowerCase().includes("cod") ? "pending" : "paid",
      expectedTotal: total,
    });

    await client.query("COMMIT");
    console.log(`[CHECKOUT] transaction committed — orderId=${orderId} total=₹${serverTotal}`);

    const notifyCfgRes = await db.query("SELECT value FROM settings WHERE key = 'notifyOrderConfirmed'");
    const notifyOrderConfirmed = notifyCfgRes.rows.length === 0 || notifyCfgRes.rows[0].value !== "false";
    if (notifyOrderConfirmed) {
      createNotification({
        eventType: "new_order",
        priority: "high",
        title: "New Order Received",
        message: `${address.fullName} placed order ${orderId} for ₹${serverTotal}`,
        entityType: "orders",
        entityId: orderId,
        link: `/admin/orders/${orderId}`,
      });
    }

    const { items: fmtItems, timeline } = await fetchItemsAndTimeline(orderId);
    const orderRow = await db.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    console.log(`[CHECKOUT] 201 SUCCESS — orderId=${orderId} total=₹${serverTotal} userId=${req.user.id}`);
    console.log("=".repeat(60));
    return res.status(201).json({
      success: true,
      message: "Order placed successfully!",
      order: formatOrder(orderRow.rows[0], fmtItems, timeline)
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log(`[CHECKOUT] ${err.status} ERROR — ${err.message} userId=${req.user.id}`);
      console.log("=".repeat(60));
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error(`[CHECKOUT] 500 ERROR — ${err.message} userId=${req.user.id}`);
    console.log("=".repeat(60));
    return res.status(500).json({ success: false, message: err.message || "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// POST /api/orders/submit-upi-reference   (customer — own order only)
// Body: { id, upiRefId }
// Records the customer-entered UPI transaction reference for verification.
// Does not change order status — admin verifies payment separately and
// moves status forward via adminUpdateStatus once confirmed.
// ==================================================================
async function submitUpiReference(req, res) {
  const { id, upiRefId } = req.body;
  console.log({ route: "POST /api/orders/submit-upi-reference", userId: req.user.id, orderId: id, status: "submitting UPI reference" });

  if (!id || !upiRefId || !upiRefId.trim()) {
    console.log({ route: "POST /api/orders/submit-upi-reference", userId: req.user.id, orderId: id, status: 400, message: "id and upiRefId are required" });
    return res.status(400).json({ success: false, message: "id and upiRefId are required" });
  }
  if (String(upiRefId).trim().length > 50) {
    return res.status(400).json({ success: false, message: "Invalid UPI reference ID" });
  }

  try {
    const ordRes = await db.query(
      "SELECT id, payment_method FROM orders WHERE id = $1 AND user_id = $2",
      [id, req.user.id]
    );
    if (ordRes.rows.length === 0) {
      console.log({ route: "POST /api/orders/submit-upi-reference", userId: req.user.id, orderId: id, status: 404, message: "Order not found" });
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (!ordRes.rows[0].payment_method?.toLowerCase().includes("upi")) {
      console.log({ route: "POST /api/orders/submit-upi-reference", userId: req.user.id, orderId: id, status: 400, message: "Not a UPI order" });
      return res.status(400).json({ success: false, message: "UPI reference can only be submitted for UPI orders" });
    }

    await db.query(
      "UPDATE orders SET upi_reference = $1, updated_at = NOW() WHERE id = $2",
      [upiRefId.trim(), id]
    );
    await db.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1, (SELECT status FROM orders WHERE id = $1), $2)",
      [id, `Customer submitted UPI reference: ${upiRefId.trim()}`]
    );

    createNotification({
      eventType: "upi_reference_submitted",
      priority: "normal",
      title: "UPI Reference Submitted",
      message: `Order ${id} — customer submitted UPI ref ${upiRefId.trim()} for verification.`,
      entityType: "orders",
      entityId: id,
      link: `/admin/orders/${id}`,
    });

    console.log({ route: "POST /api/orders/submit-upi-reference", userId: req.user.id, orderId: id, status: 200 });
    return res.json({ success: true, message: "UPI reference submitted successfully" });
  } catch (err) {
    console.error({ route: "POST /api/orders/submit-upi-reference", userId: req.user.id, orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/orders/my   (customer — own orders only)
// Query: ?status=  ?page=1  ?limit=10
// OPTIMIZED: 4 queries total regardless of result size (no N+1)
// ==================================================================
async function getMyOrders(req, res) {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = (page - 1) * limit;
  const status = req.query.status || null;
  console.log({ route: "GET /api/orders/my", userId: req.user.id, query: { page, limit, status }, status: "fetching own orders" });

  try {
    const result = await db.query(
      `SELECT * FROM orders
       WHERE user_id = $1 AND ($2::text IS NULL OR status::text = $2)
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.id, status, limit, offset]
    );

    const countRes = await db.query(
      "SELECT COUNT(*) AS total FROM orders WHERE user_id = $1 AND ($2::text IS NULL OR status::text = $2)",
      [req.user.id, status]
    );

    const orderIds = result.rows.map(o => o.id);
    const { itemsMap, timelinesMap } = await fetchItemsAndTimelinesForOrders(orderIds, req.user.id);
    const orders = result.rows.map(ord =>
      formatOrder(ord, itemsMap[ord.id] || [], timelinesMap[ord.id] || [])
    );

    console.log({ route: "GET /api/orders/my", userId: req.user.id, status: 200, count: result.rows.length });
    return res.json({
      success: true,
      pagination: {
        page, limit,
        total: parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      orders
    });
  } catch (err) {
    console.error({ route: "GET /api/orders/my", userId: req.user.id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// GET /api/orders/my/:id   (customer — own order detail)
// ==================================================================
async function getMyOrderById(req, res) {
  const { id } = req.query;
  console.log({ route: "GET /api/orders/get-my-order", userId: req.user.id, orderId: id, status: "fetching own order detail" });
  try {
    const result = await db.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2",
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "GET /api/orders/get-my-order", userId: req.user.id, orderId: id, status: 404, message: "Order not found" });
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const { items, timeline } = await fetchItemsAndTimeline(id, req.user.id);
    console.log({ route: "GET /api/orders/get-my-order", userId: req.user.id, orderId: id, status: 200 });
    return res.json({ success: true, order: formatOrder(result.rows[0], items, timeline) });
  } catch (err) {
    console.error({ route: "GET /api/orders/get-my-order", userId: req.user.id, orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// POST /api/orders/my/:id/cancel   (customer — cancel own order)
// Only allowed when status is pending or confirmed.
// ==================================================================
async function cancelMyOrder(req, res) {
  const { id } = req.body;
  console.log({ route: "POST /api/orders/cancel-my-order", userId: req.user.id, orderId: id, status: "cancelling own order" });
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const ordRes = await client.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [id, req.user.id]
    );
    if (ordRes.rows.length === 0) {
      const e = new Error("Order not found"); e.status = 404; throw e;
    }
    const ord = ordRes.rows[0];
    if (!["pending", "confirmed"].includes(ord.status)) {
      const e = new Error(`Cannot cancel an order with status: ${ord.status}`); e.status = 400; throw e;
    }

    await client.query(
      "UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [id]
    );

    await client.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'cancelled','Order cancelled by customer.')",
      [id]
    );

    await client.query("COMMIT");
    console.log({ route: "POST /api/orders/cancel-my-order", userId: req.user.id, orderId: id, status: 200 });
    return res.json({ success: true, message: "Order cancelled successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "POST /api/orders/cancel-my-order", userId: req.user.id, orderId: id, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "POST /api/orders/cancel-my-order", userId: req.user.id, orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// POST /api/orders/my/:id/replacement   (customer — request replacement)
// Only allowed when status is delivered.
// Body: { reason, details? }
// ==================================================================
async function requestReplacement(req, res) {
  const { id, reason, details } = req.body;
  console.log({ route: "POST /api/orders/request-replacement", userId: req.user.id, orderId: id, body: { reason, details }, status: "requesting order replacement" });

  if (!reason) {
    console.log({ route: "POST /api/orders/request-replacement", userId: req.user.id, orderId: id, status: 400, message: "reason is required" });
    return res.status(400).json({ success: false, message: "reason is required" });
  }
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const ordRes = await client.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [id, req.user.id]
    );
    if (ordRes.rows.length === 0) {
      const e = new Error("Order not found"); e.status = 404; throw e;
    }
    if (ordRes.rows[0].status !== "delivered") {
      const e = new Error("Only delivered orders can be replaced"); e.status = 400; throw e;
    }

    const existing = await client.query(
      "SELECT id FROM replacement_requests WHERE order_id = $1 AND user_id = $2",
      [id, req.user.id]
    );
    if (existing.rows.length > 0) {
      const e = new Error("Replacement request already submitted for this order"); e.status = 409; throw e;
    }

    await client.query(
      "UPDATE orders SET status = 'replacement_requested', updated_at = NOW() WHERE id = $1",
      [id]
    );
    await client.query(
      "INSERT INTO replacement_requests (order_id, user_id, reason, details, status) VALUES ($1,$2,$3,$4,'requested')",
      [id, req.user.id, reason, details || null]
    );
    await client.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'replacement_requested',$2)",
      [id, `Replacement requested. Reason: ${reason}`]
    );

    await client.query("COMMIT");

    const notifyReturnRes = await db.query("SELECT value FROM settings WHERE key = 'notifyReturnRequest'");
    const notifyReturnRequest = notifyReturnRes.rows.length === 0 || notifyReturnRes.rows[0].value !== "false";
    if (notifyReturnRequest) {
      createNotification({
        eventType: "replacement_requested",
        priority: "high",
        title: "Replacement Requested",
        message: `Customer requested replacement for order ${id}. Reason: ${reason}`,
        entityType: "orders",
        entityId: id,
        link: `/admin/orders/${id}`,
      });
    }

    console.log({ route: "POST /api/orders/request-replacement", userId: req.user.id, orderId: id, status: 200 });
    return res.json({ success: true, message: "Replacement request submitted successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "POST /api/orders/request-replacement", userId: req.user.id, orderId: id, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "POST /api/orders/request-replacement", userId: req.user.id, orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// ADMIN — GET /api/orders/admin/list
// All orders — filterable + paginated.
// Query: ?status=  ?paymentStatus=  ?search=  ?page=1  ?limit=20
// OPTIMIZED: 4 queries total regardless of result size (no N+1)
// ==================================================================
async function adminGetAllOrders(req, res) {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;
  const status = req.query.status || null;
  const paymentStatus = req.query.paymentStatus || null;
  const search = req.query.search ? `%${req.query.search}%` : null;
  console.log({ route: "GET /api/orders/admin/list", query: { page, limit, status, paymentStatus, search }, status: "admin fetching all orders" });

  try {
    const result = await db.query(
      `SELECT * FROM orders
       WHERE ($1::text IS NULL OR status::text         = $1)
         AND ($2::text IS NULL OR payment_status::text = $2)
         AND ($3::text IS NULL OR
               customer_name  ILIKE $3 OR
               customer_phone ILIKE $3 OR
               customer_email ILIKE $3 OR
               id             ILIKE $3)
       ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [status, paymentStatus, search, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM orders
       WHERE ($1::text IS NULL OR status::text         = $1)
         AND ($2::text IS NULL OR payment_status::text = $2)
         AND ($3::text IS NULL OR customer_name ILIKE $3 OR customer_phone ILIKE $3 OR id ILIKE $3)`,
      [status, paymentStatus, search]
    );

    const orderIds = result.rows.map(o => o.id);
    const { itemsMap, timelinesMap } = await fetchItemsAndTimelinesForOrders(orderIds);
    const orders = result.rows.map(ord =>
      formatOrder(ord, itemsMap[ord.id] || [], timelinesMap[ord.id] || [])
    );

    console.log({ route: "GET /api/orders/admin/list", status: 200, count: result.rows.length });
    return res.json({
      success: true,
      pagination: {
        page, limit,
        total: parseInt(countRes.rows[0].total),
        totalPages: Math.ceil(parseInt(countRes.rows[0].total) / limit)
      },
      orders
    });
  } catch (err) {
    console.error({ route: "GET /api/orders/admin/list", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — GET /api/orders/admin/:id
// Full single order detail.
// ==================================================================
async function adminGetOrderById(req, res) {
  const { id } = req.query;
  console.log({ route: "GET /api/orders/admin/get-order", orderId: id, status: "admin fetching order detail" });
  try {
    const result = await db.query(
      "SELECT * FROM orders WHERE id = $1",
      [id]
    );
    if (result.rows.length === 0) {
      console.log({ route: "GET /api/orders/admin/get-order", orderId: id, status: 404, message: "Order not found" });
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const { items, timeline } = await fetchItemsAndTimeline(id);
    console.log({ route: "GET /api/orders/admin/get-order", orderId: id, status: 200 });
    return res.json({ success: true, order: formatOrder(result.rows[0], items, timeline) });
  } catch (err) {
    console.error({ route: "GET /api/orders/admin/get-order", orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/orders/admin/:id/status
// Update order status + parcel tracking info.
// Body: { status, notes?, courierName?, trackingNumber?, trackingUrl? }
// ==================================================================
async function adminUpdateStatus(req, res) {
  const { id, status, notes, courierName, trackingNumber, trackingUrl } = req.body;
  console.log({ route: "PUT /api/orders/admin/update-status", orderId: id, body: { status, notes, courierName, trackingNumber, trackingUrl }, status: "admin updating order status" });

  if (!status) {
    console.log({ route: "PUT /api/orders/admin/update-status", orderId: id, status: 400, message: "status is required" });
    return res.status(400).json({ success: false, message: "status is required" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const ordRes = await client.query(
      "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (ordRes.rows.length === 0) {
      const e = new Error("Order not found"); e.status = 404; throw e;
    }

    const currentStatus = ordRes.rows[0].status;

    await client.query(
      `UPDATE orders SET
         status          = $1,
         courier_name    = COALESCE($2, courier_name),
         tracking_number = COALESCE($3, tracking_number),
         tracking_url    = COALESCE($4, tracking_url),
         updated_at      = NOW()
       WHERE id = $5`,
      [status, courierName || null, trackingNumber || null, trackingUrl || null, id]
    );

    await client.query(
      "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,$2,$3)",
      [id, status, notes || `Order status updated to: ${status}`]
    );

    await client.query("COMMIT");

    // notifyOrderShipped gates notifications specifically for the "shipped" transition.
    // All other status changes always fire so the admin log stays complete.
    const shouldNotify = status !== "shipped" || await (async () => {
      const r = await db.query("SELECT value FROM settings WHERE key = 'notifyOrderShipped'");
      return r.rows.length === 0 || r.rows[0].value !== "false";
    })();
    if (shouldNotify) {
      createNotification({
        eventType: "order_status_changed",
        priority: "normal",
        title: "Order Status Updated",
        message: `Order ${id} moved from ${currentStatus} → ${status}`,
        entityType: "orders",
        entityId: id,
        link: `/admin/orders/${id}`,
      });
    }

    console.log({ route: "PUT /api/orders/admin/update-status", orderId: id, status: 200 });
    return res.json({ success: true, message: "Order updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "PUT /api/orders/admin/update-status", orderId: id, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "PUT /api/orders/admin/update-status", orderId: id, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// ADMIN — GET /api/orders/admin/replacements
// All replacement requests.
// Query: ?status=requested|approved|rejected|completed
// ==================================================================
async function adminGetReplacements(req, res) {
  const status = req.query.status || null;
  console.log({ route: "GET /api/orders/admin/replacements", status, statusMsg: "admin fetching replacement requests" });
  try {
    const result = await db.query(
      `SELECT rr.*, u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
       FROM replacement_requests rr
       JOIN users u ON u.id = rr.user_id
       WHERE ($1::text IS NULL OR rr.status::text = $1)
       ORDER BY rr.created_at DESC`,
      [status]
    );
    console.log({ route: "GET /api/orders/admin/replacements", status, status: 200, count: result.rows.length });
    return res.json({ success: true, replacements: result.rows });
  } catch (err) {
    console.error({ route: "GET /api/orders/admin/replacements", status, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ==================================================================
// ADMIN — PUT /api/orders/admin/update-replacement
// Approve / reject / complete a replacement request.
// Body: { requestId, status, adminNotes? }
// completed → creates a NEW zero-cost order with the same items,
//             marks original order replacement_completed, links new_order_id.
// ==================================================================
async function adminUpdateReplacement(req, res) {
  const { requestId, status, adminNotes } = req.body;
  console.log({ route: "PUT /api/orders/admin/update-replacement", requestId, body: { status, adminNotes }, status: "admin updating replacement request" });
  const validStatuses = ["approved", "rejected", "completed"];
  if (!status || !validStatuses.includes(status)) {
    console.log({ route: "PUT /api/orders/admin/update-replacement", requestId, status: 400, message: "invalid status" });
    return res.status(400).json({ success: false, message: "status must be approved, rejected or completed" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const reqRes = await client.query(
      "SELECT * FROM replacement_requests WHERE id = $1 FOR UPDATE",
      [requestId]
    );
    if (reqRes.rows.length === 0) {
      const e = new Error("Replacement request not found"); e.status = 404; throw e;
    }

    const rr = reqRes.rows[0];
    let newOrderId = null;

    await client.query(
      "UPDATE replacement_requests SET status = $1, admin_notes = COALESCE($2, admin_notes), updated_at = NOW() WHERE id = $3",
      [status, adminNotes || null, rr.id]
    );

    if (status === "completed") {
      // ── Pull the original order + its items to clone ──────────────
      const origOrderRes = await client.query(
        "SELECT * FROM orders WHERE id = $1 FOR UPDATE",
        [rr.order_id]
      );
      if (origOrderRes.rows.length === 0) {
        const e = new Error("Original order not found"); e.status = 404; throw e;
      }
      const orig = origOrderRes.rows[0];

      const origItemsRes = await client.query(
        "SELECT product_id, variant_id, name_en, name_ta, weight, price, quantity FROM order_items WHERE order_id = $1",
        [rr.order_id]
      );

      // ── Create the new zero-cost replacement order ─────────────────
      newOrderId = await generateOrderId((sql, params) => client.query(sql, params));

      await client.query(
        `INSERT INTO orders (
           id, user_id, customer_name, customer_email, customer_phone,
           subtotal, delivery_charge, discount, coupon_applied, total,
           status, payment_method, payment_status,
           shipping_address_line1, shipping_address_line2, shipping_taluk,
           shipping_city, shipping_state, shipping_pincode
         ) VALUES ($1,$2,$3,$4,$5,0,0,0,NULL,0,'pending','replacement','paid',$6,$7,$8,$9,$10,$11)`,
        [
          newOrderId, orig.user_id, orig.customer_name, orig.customer_email, orig.customer_phone,
          orig.shipping_address_line1, orig.shipping_address_line2, orig.shipping_taluk,
          orig.shipping_city, orig.shipping_state, orig.shipping_pincode
        ]
      );

      for (const item of origItemsRes.rows) {
        await client.query(
          `INSERT INTO order_items
             (order_id, product_id, variant_id, name_en, name_ta, weight, price, quantity)
           VALUES ($1,$2,$3,$4,$5,$6,0,$7)`,
          [newOrderId, item.product_id, item.variant_id, item.name_en, item.name_ta, item.weight, item.quantity]
        );
      }

      await client.query(
        "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'pending',$2)",
        [newOrderId, `Replacement order created from ${rr.order_id}. No charge — items replaced free of cost.`]
      );

      await client.query(
        "UPDATE replacement_requests SET new_order_id = $1 WHERE id = $2",
        [newOrderId, rr.id]
      );

      await client.query(
        "UPDATE orders SET status = 'replacement_completed', updated_at = NOW() WHERE id = $1",
        [rr.order_id]
      );
      await client.query(
        "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,'replacement_completed',$2)",
        [rr.order_id, `Replacement completed. New order ${newOrderId} created. Notes: ${adminNotes || "None"}`]
      );
    } else {
      const orderStatusMap = { approved: "replacement_approved", rejected: "delivered" };
      const newOrderStatus = orderStatusMap[status];
      const tlNote = {
        approved: `Replacement approved. Notes: ${adminNotes || "None"}`,
        rejected: `Replacement rejected. Notes: ${adminNotes || "None"}`,
      }[status];

      await client.query(
        "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2",
        [newOrderStatus, rr.order_id]
      );
      await client.query(
        "INSERT INTO order_timelines (order_id, status, notes) VALUES ($1,$2,$3)",
        [rr.order_id, newOrderStatus, tlNote]
      );
    }

    await client.query("COMMIT");

    if (status === "completed") {
      createNotification({
        eventType: "replacement_completed",
        priority: "high",
        title: "Replacement Order Created",
        message: `Replacement for order ${rr.order_id} completed. New order ${newOrderId} created at no charge.`,
        entityType: "orders",
        entityId: newOrderId,
        link: `/admin/orders/${newOrderId}`,
      });
    }

    console.log({ route: "PUT /api/orders/admin/update-replacement", requestId, status: 200, newOrderId });
    return res.json({ success: true, message: "Replacement request updated successfully", newOrderId });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) {
      console.log({ route: "PUT /api/orders/admin/update-replacement", requestId, status: err.status, message: err.message });
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error({ route: "PUT /api/orders/admin/update-replacement", requestId, status: 500, error: err.message });
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// POST /api/orders/razorpay/create-order   (customer — login required)
// Body: { items, address, couponApplied? }
//
// Validates stock + computes server-side total, calls Razorpay Orders API,
// stores validated order data in pending_razorpay_orders, returns the
// Razorpay order id so the frontend can open the Checkout widget.
// Does NOT insert into the orders table — that happens only after
// payment signature is verified in verify-payment.
// ==================================================================
async function createRazorpayOrder(req, res) {
  const { items, address, couponApplied } = req.body;
  const userId = req.user.id;
  console.log("=".repeat(60));
  console.log(`[RAZORPAY CREATE-ORDER] START userId=${userId}`);
  console.log(`[RAZORPAY CREATE-ORDER] Incoming payload details:`, JSON.stringify({
    userId,
    itemsCount: items?.length,
    couponApplied,
    address,
  }, null, 2));

  if (!items || !items.length || !address) {
    console.log(`[RAZORPAY CREATE-ORDER] 400 — missing items or address`);
    return res.status(400).json({ success: false, message: "items and address are required" });
  }
  if (!Array.isArray(items) || items.length > 50) {
    console.log(`[RAZORPAY CREATE-ORDER] 400 — invalid items array`);
    return res.status(400).json({ success: false, message: "Invalid items" });
  }
  if (!address.fullName || !address.phone || !address.addressLine1 || !address.city || !address.pincode) {
    console.log(`[RAZORPAY CREATE-ORDER] 400 — incomplete address`);
    return res.status(400).json({ success: false, message: "Incomplete address — fullName, phone, addressLine1, city, pincode required" });
  }

  try {
    // Resolve items (combo expansion + offer-adjusted pricing) — read-only,
    // mirrors _createOrderCore's STEP 1/1b/2/2b exactly (same helper
    // functions) but without row locks, since this is only the pre-payment
    // amount estimate; verifyRazorpayPayment → _createOrderCore re-validates
    // everything for real (with locks) once payment is confirmed.
    console.log(`[RAZORPAY CREATE-ORDER] STEP 1 — expanding combo lines / resolving variant ids`);
    const resolvedLines = [];
    const comboGroups = new Map();

    for (const item of items) {
      if (item.comboId) {
        const comboQty = parseInt(item.comboQty) || 0;
        if (comboQty < 1) {
          return res.status(400).json({ success: false, message: "Invalid combo quantity" });
        }
        const comboRes = await db.query(
          `SELECT id, name, combo_price,
                  (is_active AND (start_date IS NULL OR start_date <= NOW()) AND (end_date IS NULL OR end_date >= NOW())) AS is_live
           FROM combos WHERE id = $1`,
          [item.comboId]
        );
        if (comboRes.rows.length === 0 || !comboRes.rows[0].is_live) {
          return res.status(400).json({ success: false, message: "This combo is no longer available. Please refresh your cart." });
        }
        const combo = comboRes.rows[0];
        const memberRes = await db.query(
          `SELECT ci.product_id, ci.variant_id, ci.quantity, pv.weight_label, pv.stock_qty, pv.price, p.name_en, p.name_ta
           FROM combo_items ci
           JOIN product_variants pv ON pv.id = ci.variant_id
           JOIN products p ON p.id = ci.product_id
           WHERE ci.combo_id = $1`,
          [item.comboId]
        );
        if (memberRes.rows.length === 0) {
          return res.status(400).json({ success: false, message: `"${combo.name}" has no items configured` });
        }
        for (const m of memberRes.rows) {
          if (m.stock_qty <= 0) {
            return res.status(400).json({ success: false, message: `"${m.name_en}" in your combo is currently unavailable` });
          }
        }
        comboGroups.set(combo.id, { name: combo.name, totalPrice: parseFloat(combo.combo_price) * comboQty });
        for (const m of memberRes.rows) {
          resolvedLines.push({
            productId: m.product_id, variantId: m.variant_id, weight: m.weight_label,
            nameEn: m.name_en, nameTa: m.name_ta, quantity: m.quantity * comboQty,
            comboId: combo.id, rawPrice: parseFloat(m.price),
          });
        }
      } else {
        const varRes = await db.query(
          `SELECT pv.id, pv.stock_qty, pv.price, p.category_id
           FROM product_variants pv JOIN products p ON p.id = pv.product_id
           WHERE pv.product_id = $1 AND pv.weight_label = $2 AND pv.is_active = TRUE`,
          [item.productId, item.weight]
        );
        if (varRes.rows.length === 0) {
          return res.status(400).json({ success: false, message: `Variant not found: ${item.nameEn} (${item.weight})` });
        }
        if (varRes.rows[0].stock_qty <= 0) {
          return res.status(400).json({ success: false, message: `${item.nameEn} (${item.weight}) is out of stock` });
        }
        resolvedLines.push({
          productId: item.productId, variantId: varRes.rows[0].id, categoryId: varRes.rows[0].category_id,
          weight: item.weight, nameEn: item.nameEn, nameTa: item.nameTa || null,
          quantity: item.quantity, comboId: null, rawPrice: parseFloat(varRes.rows[0].price),
        });
      }
    }

    console.log(`[RAZORPAY CREATE-ORDER] STEP 2 — applying product/category offers to non-combo items`);
    const nonComboLines = resolvedLines.filter((l) => !l.comboId);
    const offerMap = await resolveOfferAdjustedPrices(
      db, nonComboLines.map((l) => ({ productId: l.productId, categoryId: l.categoryId }))
    );
    for (const line of nonComboLines) {
      const offer = offerMap.get(line.productId);
      line.finalPrice = parseFloat(applyOfferToPrice(line.rawPrice, offer).toFixed(2));
    }

    console.log(`[RAZORPAY CREATE-ORDER] STEP 2b — distributing combo prices across member rows`);
    let comboDiscountTotal = 0;
    for (const [comboId, group] of comboGroups) {
      const memberLines = resolvedLines.filter((l) => l.comboId === comboId);
      const individualTotal = memberLines.reduce((s, l) => s + l.rawPrice * l.quantity, 0);
      comboDiscountTotal += Math.max(individualTotal - group.totalPrice, 0);
      let allocatedTotal = 0;
      memberLines.forEach((l, idx) => {
        const rowTotal = l.rawPrice * l.quantity;
        if (idx < memberLines.length - 1) {
          const shareTotal = parseFloat((rowTotal * (group.totalPrice / individualTotal)).toFixed(2));
          allocatedTotal += shareTotal;
          l.finalPrice = parseFloat((shareTotal / l.quantity).toFixed(2));
        } else {
          const remainderTotal = parseFloat((group.totalPrice - allocatedTotal).toFixed(2));
          l.finalPrice = parseFloat((remainderTotal / l.quantity).toFixed(2));
        }
      });
    }
    comboDiscountTotal = parseFloat(comboDiscountTotal.toFixed(2));

    // Compute subtotal
    let serverSubtotal = resolvedLines.reduce((s, l) => s + l.finalPrice * l.quantity, 0);
    serverSubtotal = parseFloat(serverSubtotal.toFixed(2));
    console.log(`[RAZORPAY CREATE-ORDER] STEP 2c — subtotal recomputed: ₹${serverSubtotal} (comboDiscountTotal=₹${comboDiscountTotal})`);

    // Fetch delivery settings
    const settingsRes = await db.query("SELECT key, value FROM settings");
    const settings = {};
    settingsRes.rows.forEach(r => {
      let val = r.value;
      if (val === "true") val = true;
      else if (val === "false") val = false;
      else if (val !== "" && !isNaN(val)) val = Number(val);
      settings[r.key] = val;
    });
    const freeShippingThreshold = settings.freeShippingThreshold !== undefined ? Number(settings.freeShippingThreshold) : 499;
    const flatDeliveryCharge    = settings.flatDeliveryCharge    !== undefined ? Number(settings.flatDeliveryCharge)    : 60;

    // Validate coupon
    let serverDiscount = 0;
    let freeShippingCoupon = false;
    if (couponApplied) {
      const couponCode = String(couponApplied).trim().toUpperCase();
      const couponRes = await db.query(
        "SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE", [couponCode]
      );
      if (couponRes.rows.length === 0) {
        return res.status(400).json({ success: false, message: "Invalid coupon code" });
      }
      const c = couponRes.rows[0];
      if (c.expiry_date && new Date(c.expiry_date) < new Date()) {
        return res.status(400).json({ success: false, message: "Coupon has expired" });
      }
      if (c.max_uses !== null && parseInt(c.usage_count) >= c.max_uses) {
        return res.status(400).json({ success: false, message: "Coupon usage limit reached" });
      }
      if (c.max_uses_per_user !== null) {
        const userUsageRes = await db.query(
          "SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_id = $1 AND user_id = $2",
          [c.id, userId]
        );
        const userUsageCount = parseInt(userUsageRes.rows[0].count) || 0;
        if (userUsageCount >= c.max_uses_per_user) {
          return res.status(400).json({ success: false, message: "You have reached your personal usage limit for this coupon" });
        }
      }
      if (serverSubtotal < parseFloat(c.min_order)) {
        return res.status(400).json({ success: false, message: `Minimum order of ₹${c.min_order} required for this coupon` });
      }
      let computedDiscount = 0;
      if (c.discount_percent > 0) {
        computedDiscount = (serverSubtotal * c.discount_percent) / 100;
      } else if (parseFloat(c.discount_flat) > 0) {
        computedDiscount = parseFloat(c.discount_flat);
      }
      serverDiscount = Math.min(computedDiscount, serverSubtotal);
      serverDiscount = parseFloat(serverDiscount.toFixed(2));
      if (c.free_shipping === true || c.free_shipping === "true" || c.free_shipping === 1) {
        freeShippingCoupon = true;
      }
    }

    // Store-wide automatic offer — same rule as _createOrderCore's STEP 4b
    let storeWideOfferDiscount = 0;
    const storeWideRes = await db.query(
      `SELECT * FROM offers
       WHERE applies_to = 'all' AND is_active = TRUE
         AND (start_date IS NULL OR start_date <= NOW())
         AND (end_date   IS NULL OR end_date   >= NOW())
       ORDER BY created_at DESC LIMIT 1`
    );
    if (storeWideRes.rows.length > 0) {
      const sw = storeWideRes.rows[0];
      const swMinOrder = parseFloat(sw.min_order_value) || 0;
      if (serverSubtotal >= swMinOrder) {
        let computed = 0;
        if (sw.offer_type === "percentage") {
          const raw = (serverSubtotal * parseFloat(sw.discount_value)) / 100;
          computed = sw.max_discount != null ? Math.min(raw, parseFloat(sw.max_discount)) : raw;
        } else if (sw.offer_type === "flat") {
          computed = parseFloat(sw.discount_value);
        }
        storeWideOfferDiscount = parseFloat(Math.min(computed, serverSubtotal).toFixed(2));
      }
    }

    let serverDeliveryCharge = serverSubtotal >= freeShippingThreshold ? 0 : flatDeliveryCharge;
    if (freeShippingCoupon) serverDeliveryCharge = 0;
    serverDeliveryCharge = parseFloat(serverDeliveryCharge.toFixed(2));
    const serverTotal = parseFloat((serverSubtotal - serverDiscount - storeWideOfferDiscount + serverDeliveryCharge).toFixed(2));
    console.log(`[RAZORPAY CREATE-ORDER] STEP 5 — totals: subtotal=₹${serverSubtotal} discount=₹${serverDiscount} storeWideDiscount=₹${storeWideOfferDiscount} comboDiscount(reporting)=₹${comboDiscountTotal} delivery=₹${serverDeliveryCharge} total=₹${serverTotal}`);

    // Create Razorpay order (amount in paise)
    console.log(`[RAZORPAY CREATE-ORDER] STEP 6 — calling Razorpay orders.create amount=${Math.round(serverTotal * 100)} paise`);
    const rpOrder = await getRazorpayClient().orders.create({
      amount:   Math.round(serverTotal * 100),
      currency: "INR",
      receipt:  `nokk_${userId.slice(0, 8)}_${Date.now()}`,
    });

    console.log(`[RAZORPAY CREATE-ORDER] STEP 6 — Razorpay order created: ${rpOrder.id}`);

    // Store validated order data for use at verify-payment time
    await db.query(
      `INSERT INTO pending_razorpay_orders
         (razorpay_order_id, user_id, items, address, coupon_applied, server_total)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
       ON CONFLICT (razorpay_order_id) DO NOTHING`,
      [
        rpOrder.id, userId,
        JSON.stringify(items), JSON.stringify(address),
        couponApplied ? String(couponApplied).trim().toUpperCase() : null,
        serverTotal,
      ]
    );
    console.log(`[RAZORPAY CREATE-ORDER] STEP 7 — pending order stored in DB`);

    // Clean up stale pending orders (older than 30 minutes) opportunistically
    db.query("DELETE FROM pending_razorpay_orders WHERE created_at < NOW() - INTERVAL '30 minutes'")
      .catch(() => {});

    console.log(`[RAZORPAY CREATE-ORDER] 200 SUCCESS — razorpayOrderId=${rpOrder.id} amount=₹${serverTotal} userId=${userId}`);
    console.log("=".repeat(60));
    return res.json({
      success: true,
      razorpayOrderId: rpOrder.id,
      amount:   serverTotal,
      currency: "INR",
      keyId:    RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error(`[RAZORPAY CREATE-ORDER] 500 ERROR — ${err.message} userId=${userId}`);
    console.log("=".repeat(60));
    return res.status(500).json({ success: false, message: "Failed to create payment order" });
  }
}

// ==================================================================
// POST /api/orders/razorpay/verify-payment   (customer — login required)
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature,
//         items, address, couponApplied }
//
// 1. Idempotency check — return existing order if payment already processed.
// 2. Verify HMAC-SHA256 signature server-side (key secret never leaves backend).
// 3. Fetch payment method from Razorpay API (upi/card/netbanking/wallet).
// 4. Re-run full price/stock/coupon validation via _createOrderCore.
// 5. Insert order into DB only after signature passes.
// 6. On failure: log IP + userId, return 400, create NO order.
// ==================================================================
async function verifyRazorpayPayment(req, res) {
  const {
    razorpay_order_id, razorpay_payment_id, razorpay_signature,
    items, address, couponApplied,
  } = req.body;
  const userId   = req.user.id;
  const clientIp = req.ip;

  console.log("=".repeat(60));
  console.log(`[RAZORPAY VERIFY] START userId=${userId} ip=${clientIp}`);
  console.log(`[RAZORPAY VERIFY] Incoming request body:`, JSON.stringify({
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    itemsCount: items?.length,
    couponApplied,
    address,
  }, null, 2));

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    console.log(`[RAZORPAY VERIFY] 400 — missing required Razorpay fields`);
    return res.status(400).json({ success: false, message: "razorpay_order_id, razorpay_payment_id, razorpay_signature are required" });
  }
  if (!items || !address) {
    console.log(`[RAZORPAY VERIFY] 400 — missing items or address`);
    return res.status(400).json({ success: false, message: "items and address are required" });
  }

  // Idempotency: if an order already exists for this payment_id, return it
  console.log(`[RAZORPAY VERIFY] STEP 1 — idempotency check for payment_id=${razorpay_payment_id}`);
  const existingRes = await db.query(
    "SELECT id FROM orders WHERE razorpay_payment_id = $1",
    [razorpay_payment_id]
  );
  if (existingRes.rows.length > 0) {
    const existingId = existingRes.rows[0].id;
    console.log(`[RAZORPAY VERIFY] STEP 1 — order already exists: ${existingId} (idempotent return)`);
    const [orderRow, { items: fmtItems, timeline }] = await Promise.all([
      db.query("SELECT * FROM orders WHERE id = $1", [existingId]),
      fetchItemsAndTimeline(existingId),
    ]);
    console.log("=".repeat(60));
    return res.json({
      success: true,
      message: "Order already created for this payment",
      order: formatOrder(orderRow.rows[0], fmtItems, timeline),
    });
  }
  console.log(`[RAZORPAY VERIFY] STEP 1 — no duplicate found, proceeding`);

  // Verify HMAC-SHA256 signature — this is the ONLY valid proof of payment
  console.log(`[RAZORPAY VERIFY] STEP 2 — verifying HMAC-SHA256 signature`);
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const hmacBody  = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedHex = crypto.createHmac("sha256", keySecret)
    .update(hmacBody)
    .digest("hex");

  console.log(`[RAZORPAY VERIFY] STEP 2 — signature details:`, {
    expectedHex,
    receivedSignature: razorpay_signature,
    match: expectedHex === razorpay_signature
  });

  let signatureValid = false;
  try {
    const sigBuf = Buffer.from(razorpay_signature, "hex");
    const expBuf = Buffer.from(expectedHex, "hex");
    // timingSafeEqual requires equal lengths; length mismatch itself signals invalid
    signatureValid = sigBuf.length === expBuf.length &&
      crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (_) {
    signatureValid = false;
  }

  if (!signatureValid) {
    console.error(`[RAZORPAY VERIFY] STEP 2 FAIL — signature INVALID userId=${userId} ip=${clientIp} razorpay_order_id=${razorpay_order_id}`);
    console.log("=".repeat(60));
    return res.status(400).json({ success: false, message: "Payment verification failed. Invalid signature." });
  }
  console.log(`[RAZORPAY VERIFY] STEP 2 — signature VALID ✓`);

  // Fetch payment method from Razorpay API to avoid trusting frontend-supplied method
  console.log(`[RAZORPAY VERIFY] STEP 3 — fetching payment method from Razorpay API`);
  let paymentMethod = "razorpay_upi"; // safe fallback
  try {
    const payment = await getRazorpayClient().payments.fetch(razorpay_payment_id);
    const rpMethod = payment.method; // "upi" | "card" | "netbanking" | "wallet" | ...
    paymentMethod = rpMethod ? `razorpay_${rpMethod}` : "razorpay_upi";
    console.log(`[RAZORPAY VERIFY] STEP 3 — payment method resolved: ${paymentMethod}`);
  } catch (fetchErr) {
    // Non-fatal: method is cosmetic, not security-critical; signature already verified above
    console.error(`[RAZORPAY VERIFY] STEP 3 WARN — payments.fetch failed (defaulting to razorpay_upi): ${fetchErr.message}`);
  }

  // Load stored pending order (use server-trusted data where available)
  console.log(`[RAZORPAY VERIFY] STEP 4 — loading pending order data for ${razorpay_order_id}`);
  const pendingRes = await db.query(
    "SELECT * FROM pending_razorpay_orders WHERE razorpay_order_id = $1",
    [razorpay_order_id]
  );
  const pending = pendingRes.rows[0] || null;

  if (pending) {
    console.log(`[RAZORPAY VERIFY] STEP 4 — pending order found (serverTotal=₹${pending.server_total} coupon=${pending.coupon_applied || "none"})`);
  } else {
    console.log(`[RAZORPAY VERIFY] STEP 4 — no pending order found, falling back to request body`);
  }

  const orderItems   = pending ? pending.items   : items;
  const orderAddress = pending ? pending.address : address;
  const orderCoupon  = pending ? pending.coupon_applied : couponApplied;

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const { orderId, serverTotal } = await _createOrderCore(client, {
      userId,
      userEmail:         req.user.email || null,
      items:             orderItems,
      address:           orderAddress,
      couponApplied:     orderCoupon,
      paymentMethod,
      paymentStatus:     "paid",
      razorpayOrderId:   razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
    });

    await client.query("COMMIT");
    console.log(`[RAZORPAY VERIFY] STEP 5 — transaction committed orderId=${orderId} total=₹${serverTotal}`);

    // Clean up pending record (fire-and-forget)
    db.query("DELETE FROM pending_razorpay_orders WHERE razorpay_order_id = $1", [razorpay_order_id])
      .catch(() => {});

    const notifyRpRes = await db.query("SELECT value FROM settings WHERE key = 'notifyOrderConfirmed'");
    const notifyOrderConfirmedRp = notifyRpRes.rows.length === 0 || notifyRpRes.rows[0].value !== "false";
    if (notifyOrderConfirmedRp) {
      createNotification({
        eventType: "new_order",
        priority:  "high",
        title:     "New Order Received (Razorpay)",
        message:   `Order ${orderId} placed via Razorpay for ₹${serverTotal}`,
        entityType: "orders",
        entityId:   orderId,
        link:       `/admin/orders/${orderId}`,
      });
    }

    const [orderRow, { items: fmtItems, timeline }] = await Promise.all([
      db.query("SELECT * FROM orders WHERE id = $1", [orderId]),
      fetchItemsAndTimeline(orderId),
    ]);
    console.log(`[RAZORPAY VERIFY] 201 SUCCESS — orderId=${orderId} method=${paymentMethod} userId=${userId}`);
    console.log("=".repeat(60));
    return res.status(201).json({
      success: true,
      message: "Payment verified and order placed successfully!",
      order:   formatOrder(orderRow.rows[0], fmtItems, timeline),
    });
  } catch (err) {
    await client.query("ROLLBACK");

    // Attempt automatic refund since payment succeeded but order creation failed
    try {
      console.log(`[RAZORPAY VERIFY] Attempting automatic refund for paymentId=${razorpay_payment_id} due to verification error: ${err.message}`);
      await getRazorpayClient().payments.refund(razorpay_payment_id);
      console.log(`[RAZORPAY VERIFY] Refund successful for paymentId=${razorpay_payment_id}`);
    } catch (refundErr) {
      console.error(`[RAZORPAY VERIFY] Refund failed for paymentId=${razorpay_payment_id}:`, refundErr.message);
    }

    // Clean up pending record so webhook fallback doesn't trigger
    await db.query("DELETE FROM pending_razorpay_orders WHERE razorpay_order_id = $1", [razorpay_order_id]).catch(() => {});

    if (err.status) {
      console.log(`[RAZORPAY VERIFY] ${err.status} ERROR — ${err.message} userId=${userId}`);
      console.log("=".repeat(60));
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error(`[RAZORPAY VERIFY] 500 ERROR — ${err.message} userId=${userId}`);
    console.log("=".repeat(60));
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    client.release();
  }
}

// ==================================================================
// POST /api/orders/razorpay/webhook   (NO auth — Razorpay calls directly)
//
// Safety net for cases where verify-payment never fires (browser closed,
// network drop after payment succeeded). Verifies X-Razorpay-Signature
// using the WEBHOOK secret (separate from the API key secret). On a valid
// "payment.captured" event, creates the order if it doesn't already exist.
//
// IMPORTANT: This handler must receive the raw request body — it is mounted
// in server.js BEFORE express.json() with express.raw() so the body is a
// Buffer. The webhook secret (RAZORPAY_WEBHOOK_SECRET) must be registered
// in the Razorpay dashboard when configuring the webhook URL.
// ==================================================================
async function handleRazorpayWebhook(req, res) {
  const rawBody   = req.body;  // Buffer from express.raw()
  const signature = req.headers["x-razorpay-signature"];
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  console.log("=".repeat(60));
  console.log("[Razorpay Webhook] Webhook request received. X-Razorpay-Signature:", signature);

  if (!webhookSecret) {
    console.error("[Razorpay Webhook] RAZORPAY_WEBHOOK_SECRET not configured");
    return res.status(500).json({ success: false });
  }
  if (!signature) {
    return res.status(400).json({ success: false, message: "Missing X-Razorpay-Signature" });
  }
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    return res.status(400).json({ success: false, message: "Empty body" });
  }

  // Verify webhook signature using the webhook secret (NOT the API key secret)
  const expectedSig = crypto.createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  console.log("[Razorpay Webhook] Signature verification. Expected:", expectedSig, "Received:", signature);

  let isValid = false;
  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expectedSig, "hex");
    isValid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (_) {
    isValid = false;
  }

  if (!isValid) {
    console.error("[Razorpay Webhook] Invalid signature — request rejected");
    return res.status(400).json({ success: false, message: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
    console.log("[Razorpay Webhook] Parsed event details:", JSON.stringify(event, null, 2));
  } catch (_) {
    console.error("[Razorpay Webhook] Failed to parse webhook raw JSON body");
    return res.status(400).json({ success: false, message: "Invalid JSON body" });
  }

  // Only act on payment.captured; acknowledge all other events with 200
  if (event.event !== "payment.captured") {
    return res.status(200).json({ success: true, message: "Event acknowledged" });
  }

  const rpOrderId   = event.payload?.payment?.entity?.order_id;
  const rpPaymentId = event.payload?.payment?.entity?.id;
  const rpMethod    = event.payload?.payment?.entity?.method;

  if (!rpOrderId || !rpPaymentId) {
    console.error("[Razorpay Webhook] payment.captured event missing order_id or payment_id");
    return res.status(400).json({ success: false });
  }

  // Idempotency: order already created by verify-payment (happy path)
  const existingRes = await db.query(
    "SELECT id FROM orders WHERE razorpay_order_id = $1 OR razorpay_payment_id = $2",
    [rpOrderId, rpPaymentId]
  );
  if (existingRes.rows.length > 0) {
    console.log({ route: "Razorpay Webhook", event: "payment.captured", status: "order_already_exists", rpOrderId });
    return res.status(200).json({ success: true, message: "Order already exists" });
  }

  // Fallback path: verify-payment never fired, create order from pending data
  const pendingRes = await db.query(
    "SELECT * FROM pending_razorpay_orders WHERE razorpay_order_id = $1",
    [rpOrderId]
  );
  if (pendingRes.rows.length === 0) {
    console.error({ route: "Razorpay Webhook", event: "payment.captured", error: "No pending order data found", rpOrderId });
    // Return 200 to prevent Razorpay retries — requires manual intervention
    return res.status(200).json({ success: true, message: "No pending order data; manual review required" });
  }

  const pending = pendingRes.rows[0];
  const paymentMethod = rpMethod ? `razorpay_${rpMethod}` : "razorpay_upi";

  const userRes = await db.query("SELECT email FROM users WHERE id = $1", [pending.user_id]);
  const userEmail = userRes.rows[0]?.email || null;

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const { orderId, serverTotal } = await _createOrderCore(client, {
      userId:            pending.user_id,
      userEmail,
      items:             pending.items,
      address:           pending.address,
      couponApplied:     pending.coupon_applied,
      paymentMethod,
      paymentStatus:     "paid",
      razorpayOrderId:   rpOrderId,
      razorpayPaymentId: rpPaymentId,
      razorpaySignature: null, // webhook fallback — no client signature available
    });

    await client.query("COMMIT");

    db.query("DELETE FROM pending_razorpay_orders WHERE razorpay_order_id = $1", [rpOrderId])
      .catch(() => {});

    console.log({ route: "Razorpay Webhook", event: "payment.captured", orderId, rpOrderId, status: "order_created_via_webhook_fallback" });

    const notifyWhRes = await db.query("SELECT value FROM settings WHERE key = 'notifyOrderConfirmed'");
    const notifyOrderConfirmedWh = notifyWhRes.rows.length === 0 || notifyWhRes.rows[0].value !== "false";
    if (notifyOrderConfirmedWh) {
      createNotification({
        eventType:  "new_order",
        priority:   "high",
        title:      "New Order (Webhook Fallback)",
        message:    `Order ${orderId} created via Razorpay webhook fallback for ₹${serverTotal}`,
        entityType: "orders",
        entityId:   orderId,
        link:       `/admin/orders/${orderId}`,
      });
    }

    return res.status(200).json({ success: true, message: "Order created via webhook" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error({ route: "Razorpay Webhook", event: "payment.captured", error: err.message, rpOrderId });

    if (err.status === 400) {
      // Permanent validation failure — initiate refund and return 200 (done/no retry needed)
      try {
        console.log(`[Razorpay Webhook] Permanent validation failure (status=400): ${err.message}. Initiating refund for paymentId=${rpPaymentId}`);
        await getRazorpayClient().payments.refund(rpPaymentId);
        console.log(`[Razorpay Webhook] Refund successful for paymentId=${rpPaymentId}`);
        // Delete pending record so it doesn't process again
        await db.query("DELETE FROM pending_razorpay_orders WHERE razorpay_order_id = $1", [rpOrderId]).catch(() => {});
        return res.status(200).json({ success: true, message: `Validation failed: ${err.message}. Payment refunded.` });
      } catch (refundErr) {
        console.error(`[Razorpay Webhook] Refund failed for paymentId=${rpPaymentId}:`, refundErr.message);
        // Return 500 so Razorpay retries, giving us another chance to refund or alert admin
        return res.status(500).json({ success: false, message: `Validation failed but refund failed: ${refundErr.message}` });
      }
    }

    // Return 500 so Razorpay retries on transient errors
    return res.status(500).json({ success: false });
  } finally {
    client.release();
  }
}

module.exports = {
  checkout,
  submitUpiReference,
  getMyOrders,
  getMyOrderById,
  cancelMyOrder,
  requestReplacement,
  adminGetAllOrders,
  adminGetOrderById,
  adminUpdateStatus,
  adminGetReplacements,
  adminUpdateReplacement,
  // Razorpay
  createRazorpayOrder,
  verifyRazorpayPayment,
  handleRazorpayWebhook,
};
