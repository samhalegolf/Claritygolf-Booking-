-- Re-apply the external_booking_links person-identity columns.
--
-- 20260827000100_external_booking_person_identity adds these same two columns,
-- and public.schema_migrations records it as applied at 2026-08-27 23:37:58 --
-- the timestamp every migration in that baseline batch shares. The columns are
-- not in the database. The file was ledgered without ever running, so the
-- runner has skipped it ever since and will keep skipping it: outstanding is
-- decided by name alone.
--
-- The cost of the gap was not cosmetic. Every inbound Optix booking creates the
-- lesson and then writes its link row, and that second write has been coming
-- back PGRST204 "Could not find the 'person_link_source' column" since at least
-- 2 September 2026. The lesson lands on the calendar and the bridge from the
-- Optix booking id to it never exists, so the cancellation and the move that
-- follow have nothing to change -- verified on bookings 13471493, 13501548 and
-- 13503878, all cancelled in Optix and all still showing as booked in Clarity.
--
-- A fresh name so the runner actually runs it. Idempotent, as anything that may
-- also be applied out of band through the Supabase MCP has to be.
ALTER TABLE public.external_booking_links
  ADD COLUMN IF NOT EXISTS provider_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS person_link_source TEXT;

CREATE INDEX IF NOT EXISTS external_booking_links_provider_customer_idx
  ON public.external_booking_links (provider, purpose, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL AND provider_customer_id <> '';
