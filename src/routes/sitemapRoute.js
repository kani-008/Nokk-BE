const express = require("express");
const db = require("../config/db.js");

const router = express.Router();

const BASE_URL = "https://nammaoorkaruvattukadai.com";

const STATIC_URLS = [
  { loc: "/",         changefreq: "daily",   priority: "1.0" },
  { loc: "/products", changefreq: "daily",   priority: "0.9" },
  { loc: "/offers",   changefreq: "weekly",  priority: "0.8" },
  { loc: "/login",    changefreq: "monthly", priority: "0.3" },
  { loc: "/register", changefreq: "monthly", priority: "0.3" },
];

router.get("/", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT slug, updated_at
         FROM v_products_with_price
        WHERE in_stock = true
        ORDER BY updated_at DESC`
    );

    const staticEntries = STATIC_URLS.map(
      ({ loc, changefreq, priority }) => `
  <url>
    <loc>${BASE_URL}${loc}</loc>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`
    ).join("");

    const productEntries = rows.map(({ slug, updated_at }) => {
      const lastmod = updated_at
        ? `\n    <lastmod>${new Date(updated_at).toISOString().split("T")[0]}</lastmod>`
        : "";
      return `
  <url>
    <loc>${BASE_URL}/products/${slug}</loc>${lastmod}
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
    }).join("");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${staticEntries}${productEntries}
</urlset>`;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.send(xml);
  } catch (err) {
    console.error("[sitemap] error:", err.message);
    res.status(500).send("Failed to generate sitemap");
  }
});

module.exports = router;
