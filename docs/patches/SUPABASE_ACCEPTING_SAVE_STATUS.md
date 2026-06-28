# Supabase accepting save status

Branch: `codex/supabase-accepting-calendar-save`

## Applied in this branch

- Added an idempotent Netlify database migration for optional calendar item fields.
- Added a Supabase SQL Editor recovery script for production.
- Added a defensive code patch specification for the calendar save paths.

## Not yet applied

The defensive TypeScript/JavaScript code change has not been applied in this branch yet. It requires editing existing large function files:

- `source/netlify/functions/calendar-state.mts`
- `source/netlify/functions/supabase-storage.mts`
- `source/netlify/functions/local-db/supabase-storage.mjs`

The required code changes are documented in `docs/patches/SUPABASE_ACCEPTING_CALENDAR_SAVE_PATCH.md`.

## Immediate production action

Run `source/supabase/production-calendar-items-accepting-save.sql` in Supabase SQL Editor. That should unblock normal lesson saves where the failure is caused by missing `status` or `custom_group` columns / stale PostgREST schema cache.
