const { createClient } = require("@supabase/supabase-js");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

ffmpeg.setFfmpegPath(ffmpegPath);

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "[Supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env",
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = "Nokk";

async function uploadToSupabase(
  buffer,
  mimeType,
  originalName,
  folder = "banner",
) {
  let finalBuffer = buffer;
  let finalMimeType = mimeType;
  let ext = (originalName || "file").split(".").pop().toLowerCase();

  // 1. If it's an image, process it with sharp (convert to WebP, resize to longest edge <= 1600px)
  if (mimeType && mimeType.startsWith("image/")) {
    try {
      const image = sharp(buffer);
      const metadata = await image.metadata();

      let resizeOptions = {};
      if (metadata.width > 1600 || metadata.height > 1600) {
        if (metadata.width > metadata.height) {
          resizeOptions.width = 1600;
        } else {
          resizeOptions.height = 1600;
        }
      }

      let processedImage = image;
      if (resizeOptions.width || resizeOptions.height) {
        processedImage = processedImage.resize(resizeOptions);
      }

      finalBuffer = await processedImage.webp({ quality: 80 }).toBuffer();
      finalMimeType = "image/webp";
      ext = "webp";
    } catch (err) {
      throw new Error(`Image compression failed: ${err.message}`);
    }
  }
  // 2. If it's a video, transcode with ffmpeg (to H.264 MP4, 1080p limit, strip audio, 2.5Mbps)
  else if (mimeType && mimeType.startsWith("video/")) {
    const tempDir = os.tmpdir();
    const uniqueId = crypto.randomBytes(8).toString("hex");
    const inputPath = path.join(tempDir, `input_${uniqueId}.${ext}`);
    const outputPath = path.join(tempDir, `output_${uniqueId}.mp4`);

    try {
      await fs.promises.writeFile(inputPath, buffer);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath, { timeout: 60 })
          .outputOptions([
            "-c:v libx264",
            "-b:v 2.5M",
            "-maxrate 3M",
            "-bufsize 3M",
            "-an", // Strip audio track
            "-vf scale=w='if(gt(iw,ih),min(1920,iw),-2)':h='if(gt(iw,ih),-2,min(1080,ih))'",
            "-movflags +faststart"
          ])
          .on("end", resolve)
          .on("error", (err) => {
            reject(new Error(`Transcoding failed: ${err.message}`));
          })
          .save(outputPath);
      });

      finalBuffer = await fs.promises.readFile(outputPath);
      finalMimeType = "video/mp4";
      ext = "mp4";
    } catch (err) {
      throw new Error(`Video compression failed: ${err.message}`);
    } finally {
      // Clean up temp files
      await fs.promises.unlink(inputPath).catch(() => {});
      await fs.promises.unlink(outputPath).catch(() => {});
    }
  }

  const pathStr = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  // Use long-lived, immutable cache-control for static assets (1 year = 31536000 seconds)
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(pathStr, finalBuffer, {
      contentType: finalMimeType,
      cacheControl: "31536000, public, immutable",
      upsert: false,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(pathStr);
  return data.publicUrl;
}

// Deletes a file from Supabase Storage given its full public or signed URL.
// Silently skips URLs that don't belong to this project's bucket.
async function deleteFromSupabase(url) {
  if (!url) return;
  // Extract path after /object/public/<BUCKET>/ or /object/sign/<BUCKET>/
  const match = url.match(
    /\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/(.+?)(?:\?|$)/,
  );
  if (!match) return;
  const path = decodeURIComponent(match[1]);
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error)
    console.warn(`[Supabase] delete failed for "${path}": ${error.message}`);
}

module.exports = { supabase, uploadToSupabase, deleteFromSupabase };
