const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const os = require("os");

require("dotenv").config();

require("./src/config/db.js"); // runs connection check on startup

// ── Routes
const loginRoute = require("./src/routes/loginRoutes.js");
const userRoute = require("./src/routes/userRoute.js");
const orderRoute = require("./src/routes/orderRoute.js");
const categoryRoute = require("./src/routes/categoryRoute.js");
const productRoute = require("./src/routes/productRoute.js");
const reviewRoute = require("./src/routes/reviewRoute.js");
const cartRoute = require("./src/routes/cartRoute.js");
const wishlistRoute = require("./src/routes/wishlistRoute.js");
const bannerRoute = require("./src/routes/bannerRoute.js");
const btextRoute = require("./src/routes/btextRoute.js");
const couponRoute = require("./src/routes/couponRoute.js");
const offersRoute = require("./src/routes/offersRoute.js");
const combosRoute = require("./src/routes/combosRoute.js");
const inventoryRoute = require("./src/routes/inventoryRoute.js");
const settingsRoute = require("./src/routes/settingsRoute.js");
const dashboardRoute = require("./src/routes/dashboardRoute.js");
const reportRoute = require("./src/routes/reportRoute.js");
const uploadRoute = require("./src/routes/uploadRoute.js");
const notificationRoute = require("./src/routes/notificationRoute.js");
const locationRoute = require("./src/routes/locationRoute.js");
const sitemapRoute = require("./src/routes/sitemapRoute.js");
const whatsappRoute = require("./src/routes/whatsappRoutes.js");
const customerVideoRoute = require("./src/routes/customerVideoRoute.js");
const newsletterRoute = require("./src/routes/newsletterRoute.js");
const { maintenanceGuard } = require("./src/middleware/maintenance.js");

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0"; // bind to all interfaces (required by every PaaS — Render, Railway, etc.)
const IS_PROD = process.env.NODE_ENV === "production";

// Trust the first proxy hop so req.ip / rate-limiter see the real client IP
// behind the platform's load balancer (Render, Railway, nginx, etc.). If you
// sit behind more than one proxy hop, bump this via TRUST_PROXY in env.
app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);

// ── Security headers (helmet) ─────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // allow image embeds from FE origin
  }),
);

// ── CORS ──────────────────────────────────────────────────────────
// Strip trailing slashes so "https://foo.com/" and "https://foo.com" both match.
const normalizeOrigin = (o) => o.trim().replace(/\/+$/, "");

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(normalizeOrigin).filter(Boolean)
  : IS_PROD
    ? [] // production must set ALLOWED_ORIGINS explicitly — fail closed, no silent localhost fallback
    : ["http://localhost:5173", "http://localhost:4173"]; // vite dev + preview

if (IS_PROD && ALLOWED_ORIGINS.length === 0) {
  console.warn("[cors] NODE_ENV=production but ALLOWED_ORIGINS is not set — all browser origins will be blocked.");
}

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server / curl / same-origin requests (no Origin header)
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(normalizeOrigin(origin))) return cb(null, true);
      console.warn(`[cors] blocked origin '${origin}'`);
      cb(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400, // cache CORS preflight for a day — fewer OPTIONS round-trips in prod
  }),
);

// ── Razorpay webhook — raw body BEFORE express.json() ────────────
// Razorpay's HMAC signature is computed over the raw request body.
// Mounting with express.raw() here (before the global JSON parser)
// ensures req.body is a Buffer when the webhook handler runs.
// All other /api/orders routes go through express.json() normally.
const { handleRazorpayWebhook } = require("./src/controllers/orderController.js");
app.post("/api/orders/razorpay/webhook", express.raw({ type: "*/*" }), handleRazorpayWebhook);

// ── Body parsers with size caps ───────────────────────────────────
app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: true, limit: "50kb" }));

// ── Health check ──────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "NammaOorKaruvattuKadai API is live",
    timestamp: new Date(),
  });
});

// ── Sitemap — mounted at root before /api routes, no auth ─────────
app.use("/sitemap.xml", sitemapRoute);

// ── WhatsApp Webhook & API Routes ─────────────────────────────────
// Must be mounted before maintenanceGuard to always be active
app.use("/api/whatsapp", whatsappRoute);

// ── Maintenance mode guard (runs before all API routes, skips auth + settings) ──
app.use("/api", maintenanceGuard);

// ── API routes ────────────────────────────────────────────────────
app.use("/api/auth", loginRoute); // login, OTP, reset-password, refresh, logout
app.use("/api/users", userRoute); // profile + addresses (self) | CRUD (admin)
app.use("/api/orders", orderRoute); // checkout, my-orders (customer) | manage (admin)
app.use("/api/categories", categoryRoute); // public list | CRUD (admin)
app.use("/api/products", productRoute); // public list | CRUD + variants + images (admin)
app.use("/api/products", reviewRoute); // reviews: add/update/delete-my/get-my (customer) | delete (admin)
app.use("/api/cart", cartRoute); // add, update, remove, clear (login required)
app.use("/api/wishlist", wishlistRoute); // add, remove, clear (login required)
app.use("/api/banners", bannerRoute); // public active | CRUD (admin)
app.use("/api/btext", btextRoute); // public active by banner | CRUD (admin)
app.use("/api/coupons", couponRoute); // validate (customer) | CRUD (admin)
app.use("/api/offers", offersRoute); // public live | CRUD (admin)
app.use("/api/combos", combosRoute); // public live | CRUD (admin)
app.use("/api/inventory", inventoryRoute); // stock management (admin only)
app.use("/api/settings", settingsRoute); // public read | write (admin)
app.use("/api/dashboard", dashboardRoute); // KPIs, reports, charts (admin only)
app.use("/api/reports", reportRoute); // exportable reports (admin only)
app.use("/api/upload", uploadRoute); // file upload to ImageKit Storage (admin only)
app.use("/api/notifications", notificationRoute); // notifications (customer) | send/manage (admin)
app.use("/api/location", locationRoute); // public — pincode lookup + reverse geocode
app.use("/api/newsletter", newsletterRoute); // subscribe (public) | list (admin)
app.use("/api/customer-videos", customerVideoRoute);

// ── 404 ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Resource not found" });
});

// ── Global error handler ──────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// ── helper: find this machine's LAN IPv4 (e.g. 192.168.1.5) ────────
// Dev-only convenience — meaningless (and mildly leaky) on a cloud host.
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

// ── Start ─────────────────────────────────────────────────────────
const server = app.listen(PORT, HOST, async () => {
  console.log(`NammaOorKaruvattuKadai server started (${IS_PROD ? "production" : "development"})`);
  if (IS_PROD) {
    console.log(`Listening on port ${PORT}`);
  } else {
    const lanIp = getLanIp();
    console.log(`Local:   http://localhost:${PORT}`);
    console.log(`Network: http://${lanIp}:${PORT}   (same Wi-Fi)`);
  }

  // Warm up database connection
  const db = require("./src/config/db.js");
  const startTime = Date.now();
  try {
    await db.query("SELECT 1");
    console.log(`[DB] Warmed up in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.warn(`[DB] Warm-up warning: ${err.message}`);
  }
});


module.exports = app;

