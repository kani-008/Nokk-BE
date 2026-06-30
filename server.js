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
const cartRoute = require("./src/routes/cartRoute.js");
const wishlistRoute = require("./src/routes/wishlistRoute.js");
const bannerRoute = require("./src/routes/bannerRoute.js");
const btextRoute = require("./src/routes/btextRoute.js");
const couponRoute = require("./src/routes/couponRoute.js");
const offersRoute = require("./src/routes/offersRoute.js");
const inventoryRoute = require("./src/routes/inventoryRoute.js");
const settingsRoute = require("./src/routes/settingsRoute.js");
const dashboardRoute = require("./src/routes/dashboardRoute.js");
const reportRoute = require("./src/routes/reportRoute.js");
const uploadRoute = require("./src/routes/uploadRoute.js");
const notificationRoute = require("./src/routes/notificationRoute.js");

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0"; // bind to all interfaces so LAN devices can reach it

// Trust the first proxy hop so rate-limiter sees real client IPs behind nginx/LB
app.set("trust proxy", 1);

// ── Security headers (helmet) ─────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // allow image embeds from FE origin
  }),
);

// ── CORS ──────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:5173", "http://localhost:4173"]; // vite dev + preview

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server / curl (no Origin header) and allowed list
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
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

// ── API routes ────────────────────────────────────────────────────
app.use("/api/auth", loginRoute); // login, OTP, reset-password, refresh, logout
app.use("/api/users", userRoute); // profile + addresses (self) | CRUD (admin)
app.use("/api/orders", orderRoute); // checkout, my-orders (customer) | manage (admin)
app.use("/api/categories", categoryRoute); // public list | CRUD (admin)
app.use("/api/products", productRoute); // public list | CRUD + variants + images (admin)
app.use("/api/cart", cartRoute); // add, update, remove, clear (login required)
app.use("/api/wishlist", wishlistRoute); // add, remove, clear (login required)
app.use("/api/banners", bannerRoute); // public active | CRUD (admin)
app.use("/api/btext", btextRoute); // public active by banner | CRUD (admin)
app.use("/api/coupons", couponRoute); // validate (customer) | CRUD (admin)
app.use("/api/offers", offersRoute); // public live | CRUD (admin)
app.use("/api/inventory", inventoryRoute); // stock management (admin only)
app.use("/api/settings", settingsRoute); // public read | write (admin)
app.use("/api/dashboard", dashboardRoute); // KPIs, reports, charts (admin only)
app.use("/api/reports", reportRoute); // exportable reports (admin only)
app.use("/api/upload", uploadRoute); // file upload to Supabase Storage (admin only)
app.use("/api/notifications", notificationRoute); // notifications (customer) | send/manage (admin)

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
app.listen(PORT, HOST, () => {
  const lanIp = getLanIp();
  console.log("NammaOorKaruvattuKadai server started");
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Network: http://${lanIp}:${PORT}   (same Wi-Fi)`);
});
module.exports = app;
