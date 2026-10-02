-- Refunding a Clarity Pay card sale from Clarity.
--
-- A card sale (QR or Tap to Pay) refunded from the transactions list now sends
-- the money back through Stripe before the sale says "refunded". The refund's
-- id is kept on the sale so that:
--
--   - the app can tell "the card money went back" from a sale that was only
--     marked refunded;
--   - a sale whose card money has gone back can never be marked paid again
--     (the customer would have both the goods and the money).
--
-- Re-runnable.

ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT;
ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

COMMENT ON COLUMN public.billing_pos_transactions.stripe_refund_id IS
  'The Stripe refund (re_...) that returned this sale''s card payment. Null when no card money has been sent back.';
