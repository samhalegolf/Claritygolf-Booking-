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
ALTER TABLE public.player_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.optix_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_booking_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_booking_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.optix_booking_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.captured_surfaces_backup_20260731 ENABLE ROW LEVEL SECURITY;
