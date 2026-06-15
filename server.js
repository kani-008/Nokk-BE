const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
require("dotenv").config();

const db = require("./config/db.js");

// Routes
const loginRoute    = require("./routes/LoginRoutes.js");
const reportsRoute  = require("./routes/reportsRoute.js");
// Add more as you build them:
// const productsRoute  = require("./routes/products.js");
// const ordersRoute    = require("./routes/orders.js");
// const categoriesRoute= require("./routes/categories.js");
// const offersRoute    = require("./routes/offers.js");
// const bannersRoute   = require("./routes/banners.js");
// const settingsRoute  = require("./routes/settings.js");

const app = express();
const PORT = process.env.PORT || 5000;

// ---- Global middleware ----
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Health check ----
app.get("/", (req, res) => {
  res.json({ success: true, message: "NammaOorKaruvattuKadai API is live", timestamp: new Date() });
});

// ---- Mount routes ----
app.use("/api/auth",         loginRoute);
app.use("/api/admin/reports",reportsRoute);
// app.use("/api/products",  productsRoute);
// app.use("/api/orders",    ordersRoute);
// app.use("/api/categories",categoriesRoute);
// app.use("/api/offers",    offersRoute);
// app.use("/api/banners",   bannersRoute);
// app.use("/api/settings",  settingsRoute);

// ---- 404 ----
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Resource not found" });
});

// ---- Global error handler ----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// ---- Start ----
app.listen(PORT, () => {
  console.log("=======================================================");
  console.log(` NammaOorKaruvattuKadai backend on port ${PORT}`);
  console.log(` Environment: ${process.env.NODE_ENV || "development"}`);
  console.log("=======================================================");
});

module.exports = app;