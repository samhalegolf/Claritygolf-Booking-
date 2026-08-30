-- Every Optix bay booking Clarity has ever superseded, kept forever.
--
-- optix_booking_sync holds exactly one row per lesson: the bay it holds
-- *right now*. That is the correct shape for the calendar (one lesson, one
-- ring), but it means a reschedule destroys evidence. rebookResourceAfterReschedule
-- cancels the old Optix booking and then blanks optix_booking_id /
-- optix_booking_session_id on the sync row -- it has to, or the rebook would
-- reuse those IDs and try to resurrect the booking it just cancelled. The IDs
-- are gone the moment that UPDATE lands.
--
-- That is the exact state you are in when something has gone wrong and you
-- need to reconcile Clarity against Optix by hand: a lesson at a new time, a
-- bay held at the old one, and no record of which Optix booking to go and
-- release. This table is that record.
--
-- Append-only. Nothing updates or deletes rows here -- a lesson that moves
-- five times leaves five rows, oldest first. Sized for a coaching calendar,
-- not a stadium: a few rows per reschedule, no retention policy needed.
--
-- Service-role only, like every other table here: RLS on, no client policy.

CREATE TABLE IF NOT EXISTS public.optix_bay_bookings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  calendar_item_id TEXT NOT NULL,

  -- The Optix identifiers as they stood before they were cleared. These are
  -- the whole point of the table: with optix_booking_id you can find the
  -- booking in Optix and confirm it really is gone.
  optix_booking_id TEXT NOT NULL DEFAULT '',
  optix_booking_session_id TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',

  -- The slot the superseded booking held, in Optix's own unit (unix seconds),
  -- copied verbatim from the sync row rather than re-derived. Re-deriving it
  -- from the lesson would be wrong by definition: the lesson has already
  -- moved, which is why this row exists.
  start_timestamp BIGINT NOT NULL DEFAULT 0,
  end_timestamp BIGINT NOT NULL DEFAULT 0,

  -- Why this booking stopped being the lesson's bay.
  --   reschedule        -- the lesson moved; cancel + rebook at the new slot
  --   reschedule_failed -- the cancel was refused, so the bay may STILL be held
  reason TEXT NOT NULL DEFAULT 'reschedule'
    CHECK (reason IN ('reschedule', 'reschedule_failed')),

  -- Whether Optix accepted the cancel. FALSE is the row that matters: it means
  -- a bay is still held at start_timestamp and nothing else will release it.
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What has this lesson's bay been?" -- the support question this table exists
-- to answer, newest first.
CREATE INDEX IF NOT EXISTS optix_bay_bookings_item_idx
  ON public.optix_bay_bookings (calendar_item_id, created_at DESC);

-- "Which bays might still be held in Optix with nothing pointing at them?"
CREATE INDEX IF NOT EXISTS optix_bay_bookings_orphan_idx
  ON public.optix_bay_bookings (created_at DESC)
  WHERE cancelled = FALSE;

ALTER TABLE public.optix_bay_bookings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.optix_bay_bookings IS
  'Append-only history of superseded Optix bay bookings. Written just before optix_booking_sync loses a booking ID to a reschedule, so a bay held at an old slot can still be traced back to its Optix booking. Service-role only; RLS enabled with no client policy by design.';

COMMENT ON COLUMN public.optix_bay_bookings.cancelled IS
  'FALSE means Optix refused the cancel and the bay at start_timestamp may still be held. These are the rows worth sweeping for orphans.';

NOTIFY pgrst, 'reload schema';
