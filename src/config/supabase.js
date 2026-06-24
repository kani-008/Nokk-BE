const { createClient } = require("@supabase/supabase-js");

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("[Supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = "Nokk";

/**
 * Upload a Buffer to Supabase Storage and return the public URL.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} originalName
 * @param {"banner"|"product"} folder
 * @returns {Promise<string>}
 */
async function uploadToSupabase(buffer, mimeType, originalName, folder = "banner") {
  const ext  = (originalName || "file").split(".").pop().toLowerCase();
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mimeType, cacheControl: "3600", upsert: false });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { supabase, uploadToSupabase };
