-- A credit spent on something that was never a booking.
--
-- Until now a redemption could only be created by paying for a lesson with a
-- pass, and its whole justification was the booking_id it carried. That covers
-- the tidy case and not the real one: a coach ran the lesson, never put it in
-- the calendar, and the pass still says five left when four is the truth. The
-- only way to correct that was to void the pass and grant a smaller one, which
-- rewrites history to fix a count.
--
-- So a redemption may now be written by hand, with no booking behind it. Two
-- things make that safe rather than a hole in the ledger:
--
--   * booking_id was already nullable, and sweepReturnableCredits -- the sweep
--     that hands credits back when a lesson is cancelled or deleted -- already
--     filters on `booking_id IS NOT NULL`. A manual redemption is therefore
--     invisible to it by construction, not by a new exception. Had that filter
--     not been there, every manual redemption would have been reversed by the
--     next read as "Booking deleted".
--
--   * the reason it was written is recorded, which is what this migration adds.
--     A credit that disappeared with no booking and no explanation is the sort
--     of thing that gets argued about at a counter months later, and the ledger
--     is the only place that argument can be settled.
--
-- WHY A COLUMN AND NOT reversal_reason
--
-- Because they are opposite facts. reversal_reason says why a credit came
-- back; this says why one went. A manual redemption that is later reversed has
-- both, and they must not overwrite each other.

ALTER TABLE public.pass_redemptions
  ADD COLUMN IF NOT EXISTS note TEXT;

COMMENT ON COLUMN public.pass_redemptions.note IS
  'Why this credit was spent, when a booking does not say so. Set on a redemption written by hand; null on one created by paying for a lesson, where booking_id is the explanation.';
