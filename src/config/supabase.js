const { createClient } = require("@supabase/supabase-js");

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("[Supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = "Nokk";

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

// Deletes a file from Supabase Storage given its full public or signed URL.
// Silently skips URLs that don't belong to this project's bucket.
async function deleteFromSupabase(url) {
  if (!url) return;
  // Extract path after /object/public/<BUCKET>/ or /object/sign/<BUCKET>/
  const match = url.match(/\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/(.+?)(?:\?|$)/);
  if (!match) return;
  const path = decodeURIComponent(match[1]);
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) console.warn(`[Supabase] delete failed for "${path}": ${error.message}`);
}

module.exports = { supabase, uploadToSupabase, deleteFromSupabase };
