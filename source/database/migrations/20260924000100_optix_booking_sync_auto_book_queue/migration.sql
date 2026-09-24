-- Queued Optix bay bookings, and how many times the sweep has tried them.
--
-- optix_booking_sync used to gain a row only once an attempt had *finished*.
-- The attempt runs after the save's response has gone out, and when it is cut
-- short there is nothing: no row, no error, a lesson with no bay and no way to
-- tell it apart from one that never asked. Since 24 Sep 2026 the ask is
-- written first: a 'pending' row inserted with the lesson, which the
-- background attempt settles within seconds, or the scheduled sweep
-- (optix-auto-book-sweep) settles within minutes.
--
-- attempt_count is the sweep's own counter. A finished attempt always writes
-- 'synced' or 'failed', so a row still pending after several sweeps was cut
-- off every time; the sweep then marks it failed so the coach sees it.
--
-- The table itself is created in code (ensureOptixSyncTable), so it is
-- created here too for an environment where this migration runs first.

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
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

-- "What is waiting to be booked, oldest first?" -- the sweep's one query.
CREATE INDEX IF NOT EXISTS optix_booking_sync_pending_idx
  ON public.optix_booking_sync (created_at)
  WHERE sync_status = 'pending';

COMMENT ON COLUMN public.optix_booking_sync.attempt_count IS
  'Times the scheduled sweep has claimed this row. Only meaningful while sync_status is pending.';

NOTIFY pgrst, 'reload schema';
