// Documentation-only guardrail: source/package.json intentionally aliases
// @netlify/database to source/netlify/functions/local-db.
// This .mts file is a compatibility bridge only. The implementation remains in
// supabase-storage.mjs, where getSupabaseDatabase() talks to Supabase REST using
// the Netlify Supabase environment variables.
// The local-db folder is not the active production database. booking-core.mts
// reaches Supabase through the @netlify/database compatibility shim, while some
// functions may still use direct Supabase helpers and should be kept in sync
// until a later explicit refactor.
// Compatibility shim for Netlify/esbuild local function serving.
// The booking app's local @netlify/database adapter is implemented in
// supabase-storage.mjs, but some Netlify dev/function bundles resolve the
// adapter as supabase-storage.mts. Keep this tiny bridge so either resolver
// path works without duplicating the storage implementation.
export { getSupabaseDatabase } from "./supabase-storage.mjs";
