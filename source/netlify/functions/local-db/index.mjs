// Documentation-only guardrail: source/package.json intentionally aliases
// @netlify/database to this local package (source/netlify/functions/local-db).
// This folder name is historical compatibility wording; it is not the active
// production database. getDatabase() is exported as a compatibility shim and
// forwards booking-core.mts to the Supabase REST adapter, using the Supabase
// environment variables configured for Netlify.
export { getSupabaseDatabase as getDatabase } from "./supabase-storage.mjs";
