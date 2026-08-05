-- ALREADY APPLIED to the live database (clarity-caddie, zcevluithwoumvafhmct) on
-- 5 August 2026. Verified afterwards: public has 62 tables with RLS on and zero
-- off. Nothing needs to be run to make production correct.
--
-- Held here rather than in netlify/database/migrations because as a migration it
-- repeatedly failed the deploy with a Postgres error the build log truncates at
-- 128 characters ("pq: rela"), blocking unrelated code from shipping. It is kept
-- as the record of what was changed and as the script a fresh environment needs.
-- Re-add it to the chain once the runner's failure is understood; it is safe to
-- re-run, since to_regclass skips absent tables and enabling RLS twice is a
-- no-op.
--
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
-- Written as one guarded DO block rather than six ALTER statements because this
-- migration cannot assume its target. player_sessions is created lazily by
-- ensurePlayerSessionsTable() on first player login rather than by a migration,
-- and captured_surfaces_backup_20260731 is a dated snapshot belonging to the
-- visual-engine domain rather than to this app. to_regclass skips whatever is
-- absent, so no relation can abort the run, and enabling RLS where it is
-- already on is a no-op — this is safe to re-run against any database.
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'player_sessions',
    'optix_webhook_events',
    'external_booking_links',
    'external_booking_mappings',
    'optix_booking_sync',
    'captured_surfaces_backup_20260731'
  ] LOOP
    IF to_regclass('public.' || target) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target);
    END IF;
  END LOOP;
END $$;
