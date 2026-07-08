const ImageKit = require("@imagekit/nodejs");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

ffmpeg.setFfmpegPath(ffmpegPath);

const IMAGEKIT_PUBLIC_KEY = process.env.IMAGEKIT_PUBLIC_KEY ? process.env.IMAGEKIT_PUBLIC_KEY.trim() : "";
const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY ? process.env.IMAGEKIT_PRIVATE_KEY.trim() : "";
const IMAGEKIT_URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT ? process.env.IMAGEKIT_URL_ENDPOINT.trim() : "";

if (!IMAGEKIT_PUBLIC_KEY || !IMAGEKIT_PRIVATE_KEY || !IMAGEKIT_URL_ENDPOINT) {
  console.error(
    "[ImageKit] Missing IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, or IMAGEKIT_URL_ENDPOINT in .env",
  );
}

const imagekit = new ImageKit({
  publicKey: IMAGEKIT_PUBLIC_KEY,
  privateKey: IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: IMAGEKIT_URL_ENDPOINT,
});

async function uploadToImageKit(
  buffer,
  mimeType,
  originalName,
  folder = "banner",
  stripAudio = true,
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
  // 2. If it's a video, transcode with ffmpeg (to H.264 MP4, 1080p limit, optionally strip audio, 2.5Mbps)
  else if (mimeType && mimeType.startsWith("video/")) {
    const tempDir = os.tmpdir();
    const uniqueId = crypto.randomBytes(8).toString("hex");
    const inputPath = path.join(tempDir, `input_${uniqueId}.${ext}`);
    const outputPath = path.join(tempDir, `output_${uniqueId}.mp4`);

    try {
      await fs.promises.writeFile(inputPath, buffer);

      const outputOpts = [
        "-c:v libx264",
        "-b:v 2.5M",
        "-maxrate 3M",
        "-bufsize 3M",
        "-vf scale=w='if(gt(iw,ih),min(1920,iw),-2)':h='if(gt(iw,ih),-2,min(1080,ih))'",
        "-movflags +faststart"
      ];

      if (stripAudio) {
        outputOpts.push("-an");
      } else {
        outputOpts.push("-c:a aac");
        outputOpts.push("-b:a 128k");
      }

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath, { timeout: 60 })
          .outputOptions(outputOpts)
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

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  try {
    const response = await imagekit.files.upload({
      file: finalBuffer.toString("base64"),
      fileName: fileName,
      folder: folder,
    });

    if (!response || !response.url) {
      throw new Error("Missing url in ImageKit response");
    }
    return response.url;
  } catch (error) {
    throw new Error(`ImageKit upload failed: ${error.message}`);
  }
}

async function deleteFromImageKit(url) {
  if (!url) return;
  try {
    const endpoint = IMAGEKIT_URL_ENDPOINT.replace(/\/$/, "");
    if (!url.startsWith(endpoint)) {
      console.warn(`[ImageKit] delete skipped: URL "${url}" does not match endpoint "${endpoint}"`);
      return;
    }

    let relativePath = url.replace(endpoint, "");
    if (relativePath.startsWith("/")) {
      relativePath = relativePath.slice(1);
    }
    relativePath = decodeURIComponent(relativePath);

    const parts = relativePath.split("/");
    const filename = parts.pop();
    const folder = "/" + parts.join("/");

    const listResult = await imagekit.assets.list({
      path: folder,
    });

    const match = listResult.find(
      (item) => item.name === filename || item.filePath === "/" + relativePath
    );

    if (!match || !match.fileId) {
      console.warn(`[ImageKit] delete skipped: file not found for "${relativePath}"`);
      return;
    }

    await imagekit.files.delete(match.fileId);
  } catch (err) {
    console.warn(`[ImageKit] delete failed for URL "${url}": ${err.message}`);
  }
}

module.exports = { imagekit, uploadToImageKit, deleteFromImageKit };
