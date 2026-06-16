// Compatibility shim for Netlify/esbuild local function serving.
// The booking app's local @netlify/database adapter is implemented in
// supabase-storage.mjs, but some Netlify dev/function bundles resolve the
// adapter as supabase-storage.mts. Keep this tiny bridge so either resolver
// path works without duplicating the storage implementation.
export { getSupabaseDatabase } from "./supabase-storage.mjs";
