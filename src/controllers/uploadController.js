const multer = require("multer");
const { uploadToSupabase } = require("../config/supabase.js");

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

  console.log({ route: "POST /api/upload/banner", file: file.originalname, size: file.size });

  try {
    const url = await uploadToSupabase(file.buffer, file.mimetype, file.originalname);
    console.log({ route: "POST /api/upload/banner", status: 200, url });
    return res.status(200).json({ success: true, url });
  } catch (err) {
    console.error({ route: "POST /api/upload/banner", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ==================================================================
// ADMIN — POST /api/upload/product
// Multipart fields: file (JPEG/PNG/WebP, max 5 MB), slug (required)
// Files are stored under product/{slug}/... so each product gets its
// own folder in Supabase Storage.
// Response: { success, url }
// ==================================================================
async function uploadProductImage(req, res) {
  const { file } = req;
  const slug = (req.body.slug || "").trim();

  if (!file) {
    return res.status(400).json({ success: false, message: "No file provided" });
  }
  if (!slug) {
    return res.status(400).json({ success: false, message: "slug is required to know which product folder to upload into" });
  }

  console.log({ route: "POST /api/upload/product", slug, file: file.originalname, size: file.size });

  try {
    const url = await uploadToSupabase(file.buffer, file.mimetype, file.originalname, `product/${slug}`);
    console.log({ route: "POST /api/upload/product", status: 200, url });
    return res.status(200).json({ success: true, url });
  } catch (err) {
    console.error({ route: "POST /api/upload/product", status: 500, error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { upload, uploadProduct, uploadBannerFile, uploadProductImage };