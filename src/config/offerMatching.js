// Raw SQL for the LATERAL subquery that finds the single best-matching
// live offer for a product. References outer aliases p.id (product id)
// and p.category_id (product's category id) — callers must expose a row
// source aliased "p" with those two columns. Product-specific offers
// always outrank category-specific ones (never "all" — store-wide offers
// are matched separately via getActiveStoreWideOffer).
//
// Reused verbatim by the v_products_with_price view (migrate-add-offers-combos.js)
// and by resolveOfferAdjustedPrices in orderController.js so the two can
// never silently diverge.
const OFFER_MATCH_LATERAL_SQL = `
  LEFT JOIN LATERAL (
    SELECT o.id, o.offer_type, o.discount_value, o.max_discount
    FROM offers o
    WHERE o.is_active = TRUE
      AND (o.start_date IS NULL OR o.start_date <= NOW())
      AND (o.end_date IS NULL OR o.end_date >= NOW())
      AND (
        (o.applies_to = 'product'  AND o.product_id  = p.id)
        OR (o.applies_to = 'category' AND o.category_id = p.category_id)
      )
    ORDER BY (o.applies_to = 'product') DESC, o.created_at DESC
    LIMIT 1
  ) ao ON TRUE
`;

module.exports = { OFFER_MATCH_LATERAL_SQL };
