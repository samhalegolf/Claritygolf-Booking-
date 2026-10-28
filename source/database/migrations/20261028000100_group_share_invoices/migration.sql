-- One invoice per invited player for their share of a custom group lesson.
--
-- The group invite email carries a Pay button for that player's share, and
-- the share is its own invoice so Billing shows who has paid. Its one line is
-- source 'group_share', with source_id "<booking id>:<attendee id>", rather
-- than a 'booking' line: a booking line claims the whole lesson through
-- billing_booking_invoice_links (one invoice per lesson), and the booker's own
-- invoice still has to be able to claim it. The share lines are what the
-- booker's amount is reduced by instead.
--
-- Re-runnable.

ALTER TABLE public.billing_invoice_items
  DROP CONSTRAINT IF EXISTS billing_invoice_items_source_type_check;
ALTER TABLE public.billing_invoice_items
  ADD CONSTRAINT billing_invoice_items_source_type_check
  CHECK (source_type IN ('booking', 'product', 'manual', 'stripe', 'group_share'));

-- Finding a player's share invoice (to reuse it, void it, or total a lesson's
-- shares) reads by this.
CREATE INDEX IF NOT EXISTS idx_billing_invoice_items_group_share
  ON public.billing_invoice_items (account_id, source_id)
  WHERE source_type = 'group_share';
