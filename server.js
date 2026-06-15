const express = require("express");
const cors    = require("cors");
const morgan  = require("morgan");
require("dotenv").config();

require("./src/config/db.js"); // runs connection check on startup

// ── Routes ────────────────────────────────────────────────────────
const loginRoute     = require("./src/routes/loginRoutes.js");
const userRoute      = require("./src/routes/userRoute.js");
const orderRoute     = require("./src/routes/orderRoute.js");
const categoryRoute  = require("./src/routes/categoryRoute.js");
const productRoute   = require("./src/routes/productRoute.js");
const cartRoute      = require("./src/routes/cartRoute.js");
const wishlistRoute  = require("./src/routes/wishlistRoute.js");
const bannerRoute    = require("./src/routes/bannerRoute.js");
const couponRoute    = require("./src/routes/couponRoute.js");
const offersRoute    = require("./src/routes/offersRoute.js");
const inventoryRoute = require("./src/routes/inventoryRoute.js");
const settingsRoute  = require("./src/routes/settingsRoute.js");
const dashboardRoute = require("./src/routes/dashboardRoute.js");

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Global middleware ─────────────────────────────────────────────
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check ──────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ success: true, message: "NammaOorKaruvattuKadai API is live", timestamp: new Date() });
});

// ── API routes ────────────────────────────────────────────────────
app.use("/api/auth",       loginRoute);      // login, OTP, reset-password, refresh, logout
app.use("/api/users",      userRoute);       // profile + addresses (self) | CRUD (admin)
app.use("/api/orders",     orderRoute);      // checkout, my-orders (customer) | manage (admin)
app.use("/api/categories", categoryRoute);   // public list | CRUD (admin)
app.use("/api/products",   productRoute);    // public list | CRUD + variants + images (admin)
app.use("/api/cart",       cartRoute);       // add, update, remove, clear (login required)
app.use("/api/wishlist",   wishlistRoute);   // add, remove, clear (login required)
app.use("/api/banners",    bannerRoute);     // public active | CRUD (admin)
app.use("/api/coupons",    couponRoute);     // validate (customer) | CRUD (admin)
app.use("/api/offers",     offersRoute);     // public live | CRUD (admin)
app.use("/api/inventory",  inventoryRoute);  // stock management (admin only)
app.use("/api/settings",   settingsRoute);   // public read | write (admin)
app.use("/api/dashboard",  dashboardRoute);  // KPIs, reports, charts (admin only)

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

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("=======================================================");
  console.log(` NammaOorKaruvattuKadai backend on port ${PORT}`);
  console.log(` Env: ${process.env.NODE_ENV || "development"}`);
  console.log("=======================================================");
});

module.exports = app;