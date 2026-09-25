-- Which business owns each external resource booking, and which system holds it.
--
-- optix_booking_sync is now the ledger of every resource Clarity asks another
-- system to hold for a lesson (see _shared/resource-handler.mts). Two gaps:
--
-- * No account_id. Every read went by calendar_item_id alone, so the tenant
--   boundary rested on lesson ids never colliding across businesses. It now
--   carries the owning business, backfilled from the lesson.
-- * No provider. Every row was Optix's because Optix was the only system.
--   The column says so explicitly, so a second provider's rows can sit beside
--   them without being mistaken for Optix bookings.
--
-- The table keeps its name for now. Every reader already goes through the
-- handler or a join that names it; a rename is a separate, mechanical change.

CREATE TABLE IF NOT EXISTS public.optix_booking_sync (
  calendar_item_id TEXT PRIMARY KEY,
  optix_booking_id TEXT,
  optix_booking_session_id TEXT,
  resource_id TEXT,
  start_timestamp BIGINT,
  end_timestamp BIGINT,
  fingerprint TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  error_message TEXT,
  last_attempted_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.optix_booking_sync
  ADD COLUMN IF NOT EXISTS account_id TEXT;

ALTER TABLE public.optix_booking_sync
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'optix';

UPDATE public.optix_booking_sync s
SET account_id = ci.account_id
FROM public.calendar_items ci
WHERE ci.id = s.calendar_item_id
  AND s.account_id IS NULL;

CREATE INDEX IF NOT EXISTS optix_booking_sync_account_idx
  ON public.optix_booking_sync (account_id);

NOTIFY pgrst, 'reload schema';
