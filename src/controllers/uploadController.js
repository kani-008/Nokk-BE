const multer = require("multer");
const { uploadToSupabase } = require("../config/supabase.js");

const log  = (d) => console.log(d);
const lerr = (d) => console.error(d);

const BANNER_TYPES = new Set([
  "video/mp4", "video/webm", "video/ogg",
  "image/jpeg", "image/png", "image/webp", "image/gif",
]);

const IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp",
]);

// 100 MB limit for banners (videos)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    BANNER_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`Unsupported type: ${file.mimetype}`)),
});

// 5 MB limit for product images
const uploadProduct = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    IMAGE_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`Only JPEG, PNG and WebP images are allowed`)),
});

// ==================================================================
// ADMIN — POST /api/upload/banner
// Multipart fields: file (required), kind ("video" | "image")
// Response: { success, url }
// ==================================================================
async function uploadBannerFile(req, res) {
  const { file } = req;
  if (!file) {
    return res.status(400).json({ success: false, message: "No file provided" });
  }

  log({ route: "POST /api/upload/banner", file: file.originalname, size: file.size });

  try {
    const url = await uploadToSupabase(file.buffer, file.mimetype, file.originalname);
    log({ route: "POST /api/upload/banner", status: 200, url });
    return res.status(200).json({ success: true, url });
  } catch (err) {
    lerr({ route: "POST /api/upload/banner", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ==================================================================
// ADMIN — POST /api/upload/product
// Multipart field: file (JPEG/PNG/WebP, max 5 MB)
// Response: { success, url }
// ==================================================================
async function uploadProductImage(req, res) {
  const { file } = req;
  if (!file) {
    return res.status(400).json({ success: false, message: "No file provided" });
  }

  log({ route: "POST /api/upload/product", file: file.originalname, size: file.size });

  try {
    const url = await uploadToSupabase(file.buffer, file.mimetype, file.originalname, "product");
    log({ route: "POST /api/upload/product", status: 200, url });
    return res.status(200).json({ success: true, url });
  } catch (err) {
    lerr({ route: "POST /api/upload/product", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { upload, uploadProduct, uploadBannerFile, uploadProductImage };
