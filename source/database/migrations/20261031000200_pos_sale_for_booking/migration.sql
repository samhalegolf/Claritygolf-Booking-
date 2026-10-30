-- A package bought while booking a lesson, to pay for that lesson.
--
-- The booking page's "Buy a 5-lesson package" is an online order like the
-- shop's (source 'online'), for the package. Once Stripe says it is paid, the
-- pass it issues spends its first credit on this booking. for_booking_id is
-- that booking.
--
-- Deliberately not booking_id / booking_ids: those say "this sale paid for
-- these lessons" at the till, and readers treat a lesson on them as paid by
-- the sale's money. Here the money bought a pass; the lesson is paid by the
-- pass's credit, recorded in pass_redemptions like any other.
--
-- Re-runnable.

ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS for_booking_id TEXT;

COMMENT ON COLUMN public.billing_pos_transactions.for_booking_id IS
  'Online package order from the booking page: the lesson its first credit is spent on once paid.';

NOTIFY pgrst, 'reload schema';
