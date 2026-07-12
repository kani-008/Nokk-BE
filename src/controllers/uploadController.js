const multer = require("multer");
const {
  uploadToImageKit,
  deleteFromImageKit,
} = require("../config/imagekit.js");

const BANNER_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// 100 MB limit for banners (videos can be large before ffmpeg compresses them)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    BANNER_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`Unsupported type: ${file.mimetype}. Allowed: mp4, webm, jpeg, png, webp`)),
});

// Wrap a multer handler in a Promise so its errors can be caught in async functions
function runMulter(multerHandler, req, res) {
  return new Promise((resolve, reject) => {
    multerHandler(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// 5 MB limit for product images
const uploadProduct = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    IMAGE_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`Only JPEG, PNG and WebP images are allowed`)),
});

// 3 MB per-file limit, max 3 files per request, for customer-submitted
// review photos (unpredictable volume, so kept intentionally smaller than
// the admin product-image cap — do not raise either without checking
// storage consumption first).
const uploadReview = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 3 },
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
  // Run multer internally so we can catch its errors (file too large, wrong type)
  // and return a clean 400/413 JSON instead of a raw 500.
  try {
    await runMulter(upload.single("file"), req, res);
  } catch (multerErr) {
    const isTooBig = multerErr.code === "LIMIT_FILE_SIZE";
    console.error({
      route: "POST /api/upload/banner",
      status: isTooBig ? 413 : 400,
      error: multerErr.message,
    });
    return res
      .status(isTooBig ? 413 : 400)
      .json({
        success: false,
        message: isTooBig
          ? "File too large — max 100 MB allowed"
          : multerErr.message,
      });
  }

  const { file } = req;
  if (!file) {
    return res.status(400).json({ success: false, message: "No file provided" });
  }

  console.log({
    route: "POST /api/upload/banner",
    file: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  });

  try {
    const url = await uploadToImageKit(
      file.buffer,
      file.mimetype,
      file.originalname,
    );
    console.log({ route: "POST /api/upload/banner", status: 200, url });
    return res.status(200).json({ success: true, url });
  } catch (err) {
    const isImageKitError = err.message && err.message.includes("ImageKit upload failed");
    const statusCode = isImageKitError ? 502 : 500;
    const msg = isImageKitError ? err.message : `Upload processing failed: ${err.message}`;
    console.error({
      route: "POST /api/upload/banner",
      status: statusCode,
      error: err.message,
    });
    return res.status(statusCode).json({ success: false, message: msg });
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
    return res
      .status(400)
      .json({ success: false, message: "No file provided" });
  }
  if (!slug) {
    return res
      .status(400)
      .json({
        success: false,
        message: "slug is required to know which product folder to upload into",
      });
  }

  console.log({
    route: "POST /api/upload/product",
    slug,
    file: file.originalname,
    size: file.size,
  });

  try {
    const url = await uploadToImageKit(
      file.buffer,
      file.mimetype,
      file.originalname,
      `product/${slug}`,
    );
    console.log({ route: "POST /api/upload/product", status: 200, url });
    return res.status(200).json({ success: true, url });
  } catch (err) {
    const isImageKitError =
      err.message && err.message.includes("ImageKit upload failed");
    const statusCode = isImageKitError ? 502 : 500;
    const msg = isImageKitError ? err.message : "Internal server error";
    console.error({
      route: "POST /api/upload/product",
      status: statusCode,
      error: err.message,
    });
    return res.status(statusCode).json({ success: false, message: msg });
  }
}

// ==================================================================
// CUSTOMER — POST /api/upload/review-image   (login required, not admin)
// Multipart fields: file (JPEG/PNG/WebP, max 3 MB), slug (required)
// Files are stored under review/{slug}/... — every customer's review
// photos for a product land in that same shared folder (no per-user
// subfolders), same flat convention as review/{slug} in the spec.
// Response: { success, url }
// ==================================================================
async function uploadReviewImage(req, res) {
  const { file } = req;
  const slug = (req.body.slug || "").trim();

  if (!file) {
    return res
      .status(400)
      .json({ success: false, message: "No file provided" });
  }
  if (!slug) {
    return res
      .status(400)
      .json({
        success: false,
        message: "slug is required to know which product folder to upload into",
      });
  }

  console.log({
    route: "POST /api/upload/review-image",
    slug,
    userId: req.user?.id,
    file: file.originalname,
    size: file.size,
  });

  try {
    const url = await uploadToImageKit(
      file.buffer,
      file.mimetype,
      file.originalname,
      `review/${slug}`,
    );
    console.log({ route: "POST /api/upload/review-image", status: 200, url });
    return res.status(200).json({ success: true, url });
  } catch (err) {
    const isImageKitError =
      err.message && err.message.includes("ImageKit upload failed");
    const statusCode = isImageKitError ? 502 : 500;
    const msg = isImageKitError ? err.message : "Internal server error";
    console.error({
      route: "POST /api/upload/review-image",
      status: statusCode,
      error: err.message,
    });
    return res.status(statusCode).json({ success: false, message: msg });
  }
}

// ==================================================================
// ADMIN — POST /api/upload/customer-video
// Multipart fields: file (required)
// Response: { success, url }
// ==================================================================
async function uploadCustomerVideoFile(req, res) {
  try {
    await runMulter(upload.single("file"), req, res);
  } catch (multerErr) {
    const isTooBig = multerErr.code === "LIMIT_FILE_SIZE";
    console.error({
      route: "POST /api/upload/customer-video",
      status: isTooBig ? 413 : 400,
      error: multerErr.message,
    });
    return res
      .status(isTooBig ? 413 : 400)
      .json({
        success: false,
        message: isTooBig
          ? "File too large — max 100 MB allowed"
          : multerErr.message,
      });
  }

  const { file } = req;
  if (!file) {
    return res
      .status(400)
      .json({ success: false, message: "No file provided" });
  }

  console.log({
    route: "POST /api/upload/customer-video",
    file: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  });

  try {
    const url = await uploadToImageKit(
      file.buffer,
      file.mimetype,
      file.originalname,
      "customer-videos"
    );
    console.log({ route: "POST /api/upload/customer-video", status: 200, url });
    return res.status(200).json({ success: true, url });
  } catch (err) {
    const isImageKitError =
      err.message && err.message.includes("ImageKit upload failed");
    const statusCode = isImageKitError ? 502 : 500;
    const msg = isImageKitError ? err.message : `Upload processing failed: ${err.message}`;
    console.error({
      route: "POST /api/upload/customer-video",
      status: statusCode,
      error: err.message,
    });
    return res.status(statusCode).json({ success: false, message: msg });
  }
}

// ==================================================================
// ADMIN — DELETE /api/upload/delete-file
// Body: { url }
// Delete file from Supabase storage directly.
// ==================================================================
async function deleteUploadedFile(req, res) {
  const { url } = req.body;
  console.log({ route: "DELETE /api/upload/delete-file", url });

  if (!url) {
    return res.status(400).json({ success: false, message: "url is required" });
  }

  try {
    await deleteFromImageKit(url);
    console.log({ route: "DELETE /api/upload/delete-file", status: 200, url });
    return res
      .status(200)
      .json({ success: true, message: "File deleted successfully" });
  } catch (err) {
    console.error({
      route: "DELETE /api/upload/delete-file",
      status: 500,
      error: err.message,
    });
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete file" });
  }
}

module.exports = {
  upload,
  uploadProduct,
  uploadReview,
  uploadBannerFile,
  uploadProductImage,
  uploadReviewImage,
  uploadCustomerVideoFile,
  deleteUploadedFile,
};
