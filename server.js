const express = require("express");
const cors    = require("cors");
const morgan  = require("morgan");
const os      = require("os");

function formatConsoleValue(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return JSON.stringify(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      null,
      2
    );
  }

  if (typeof value === "object" && value !== null) {
    const seen = new WeakSet();
    try {
      return JSON.stringify(
        value,
        (key, currentValue) => {
          if (typeof currentValue === "bigint") {
            return currentValue.toString();
          }
          if (typeof currentValue === "object" && currentValue !== null) {
            if (seen.has(currentValue)) {
              return "[Circular]";
            }
            seen.add(currentValue);
          }
          if (currentValue instanceof Error) {
            return {
              name: currentValue.name,
              message: currentValue.message,
              stack: currentValue.stack,
            };
          }
          return currentValue;
        },
        2
      );
    } catch (err) {
      return String(value);
    }
  }

  return String(value);
}

function formatConsoleArgs(args) {
  return args.map(formatConsoleValue).join(" ");
}

const nativeConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
};

console.log = (...args) => nativeConsole.log(formatConsoleArgs(args));
console.error = (...args) => nativeConsole.error(formatConsoleArgs(args));
console.warn = (...args) => nativeConsole.warn(formatConsoleArgs(args));
console.info = (...args) => nativeConsole.info(formatConsoleArgs(args));

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
const btextRoute     = require("./src/routes/btextRoute.js");
const couponRoute    = require("./src/routes/couponRoute.js");
const offersRoute    = require("./src/routes/offersRoute.js");
const inventoryRoute = require("./src/routes/inventoryRoute.js");
const settingsRoute  = require("./src/routes/settingsRoute.js");
const dashboardRoute = require("./src/routes/dashboardRoute.js");

const app  = express();
const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0"; // bind to all interfaces so phones on the same Wi-Fi can reach it

// ── Global middleware ─────────────────────────────────────────────
app.use(cors()); // dev: allow all origins (phone LAN origin included)
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
app.use("/api/btext",      btextRoute);      // public active by banner | CRUD (admin)
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
  console.log("=======================================================");
  console.log(` NammaOorKaruvattuKadai backend running`);
  console.log(` Env:     ${process.env.NODE_ENV || "development"}`);
  console.log(` Desktop: http://localhost:${PORT}`);
  console.log(` Mobile:  http://${lanIp}:${PORT}   (same Wi-Fi)`);
  console.log("=======================================================");
});

module.exports = app;