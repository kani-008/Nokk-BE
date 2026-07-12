const ImageKit = require("@imagekit/nodejs");

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
) {
  const finalBuffer = buffer;
  const ext = (originalName || "file").split(".").pop().toLowerCase();


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
