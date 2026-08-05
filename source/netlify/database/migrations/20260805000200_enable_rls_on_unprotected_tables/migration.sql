-- These tables were reachable by the anon and authenticated roles, exposing raw
-- Optix webhook payloads (customer names, emails, phones) and player session
-- rows to anyone holding the project's anon key.
--
-- No policies are added deliberately. Every server path reaches these tables as
-- postgres (the direct pg pool, DATABASE_URL) or service_role (PostgREST), and
-- both carry rolbypassrls, so RLS with no policy denies anon and authenticated
-- outright while leaving the application unaffected. The tables are owned by
-- postgres with relforcerowsecurity = false, so the owner stays exempt too.
--
-- There is no browser-side Supabase client in this app and no Supabase edge
-- functions in the project, so nothing legitimate reaches these tables with the
-- anon key.
--
-- IF EXISTS throughout: this migration runs on every deploy target, and not all
-- of them hold every table. player_sessions is created lazily by
-- ensurePlayerSessionsTable() on first player login rather than by a migration,
-- and captured_surfaces_backup_20260731 is a dated snapshot belonging to the
-- visual-engine domain rather than to this app. Enabling RLS is also a no-op
-- when it is already on, so this is safe to re-run.
ALTER TABLE IF EXISTS public.player_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.optix_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.external_booking_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.external_booking_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.optix_booking_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.captured_surfaces_backup_20260731 ENABLE ROW LEVEL SECURITY;
