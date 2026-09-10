-- The Clarity Pay link emailed with an invoice.
--
-- Kept on the invoice rather than minted per send, for two reasons. A resend
-- must not hand the client a second live way to pay the same invoice, and the
-- link that went out in the first email has to keep working - so once an
-- invoice has one, that is its link for good.
--
-- This is deliberately a Stripe *payment link*, not a Checkout Session: a
-- session expires 24 hours after it is created, which is dead by the time a
-- client opens an invoice with 7-day terms. payment_link_id is stored so the
-- link can be deactivated or reconciled later without hunting for it by URL.
ALTER TABLE public.billing_invoices
  ADD COLUMN IF NOT EXISTS payment_link_url TEXT,
  ADD COLUMN IF NOT EXISTS payment_link_id TEXT;
