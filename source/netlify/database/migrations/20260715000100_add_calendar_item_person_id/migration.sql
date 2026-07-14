-- Bookings had no stable link to a client (people) row — the link was
-- re-derived on every save by matching name/email/phone (compatiblePersonMatch).
-- Any edit that changed those fields (a typo fix, a corrected phone, a second
-- email address) could fail that match and spin off a disconnected duplicate
-- person, silently breaking the booking's connection to the client's real
-- profile, history, and notes.
--
-- person_id is the explicit, stable foreign key going forward: it is stamped
-- onto the row the first time a booking is linked/created, and every
-- subsequent save (edit, reschedule, status change) carries it forward and
-- uses it to update the SAME person row instead of re-matching by heuristic.
ALTER TABLE public.calendar_items
  ADD COLUMN IF NOT EXISTS person_id TEXT;

CREATE INDEX IF NOT EXISTS idx_calendar_items_person
  ON public.calendar_items (person_id)
  WHERE person_id IS NOT NULL;
