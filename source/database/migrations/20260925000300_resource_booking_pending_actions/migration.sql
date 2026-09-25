-- Moves and releases owed to an external resource booking.
--
-- A new hold is written down before the response goes out (sync_status
-- 'pending') so the sweep can finish it when the after-response attempt dies.
-- Moving a bay after a reschedule, and releasing one after a cancellation,
-- ran after the response too but left no trace: cut short, the bay stayed at
-- the old time, or stayed held for a lesson nobody was coming to.
--
-- pending_action is 'move' or 'release', set in the save and cleared when an
-- attempt finishes. A release outranks a move. The sweep picks up rows whose
-- attempt never finished (see resource-handler.mts).

ALTER TABLE public.optix_booking_sync
  ADD COLUMN IF NOT EXISTS pending_action TEXT,
  ADD COLUMN IF NOT EXISTS pending_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS optix_booking_sync_pending_action_idx
  ON public.optix_booking_sync (pending_since)
  WHERE pending_action IS NOT NULL;

NOTIFY pgrst, 'reload schema';
