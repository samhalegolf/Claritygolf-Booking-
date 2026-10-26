-- Selling packages and gift vouchers online.
--
-- An online order is a till sale that the customer rings up themselves: a
-- pending billing_pos_transactions row paid through Stripe Checkout, settled
-- by the same code that settles a QR payment at the counter. So it lands in
-- takings, issues its passes and voucher codes, and refunds the way every
-- other sale does. What is new:
--
--   source 'online'   so the sale says where it came from, and the takings
--                     list can tell the shop from the counter. The voucher it
--                     issues says the same.
--   gift fields       who a voucher is for and the message with it. Kept on
--                     the sale because the email that carries the code can be
--                     sent from the Stripe webhook, long after the buyer's
--                     browser (and what they typed) has gone.
--
-- Re-runnable.

ALTER TABLE public.billing_pos_transactions
  DROP CONSTRAINT IF EXISTS billing_pos_transactions_source_check;
ALTER TABLE public.billing_pos_transactions
  ADD CONSTRAINT billing_pos_transactions_source_check
  CHECK (source IN ('lesson', 'client', 'counter', 'online'));

ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS gift_recipient_name TEXT;
ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS gift_message TEXT;

-- A voucher bought in the shop says so, rather than "sold at the till".
ALTER TABLE public.billing_coupons
  DROP CONSTRAINT IF EXISTS billing_coupons_source_check;
ALTER TABLE public.billing_coupons
  ADD CONSTRAINT billing_coupons_source_check
  CHECK (source IN ('stripe', 'pos', 'manual', 'online'));

-- The sweep that voids abandoned online checkouts reads by these.
CREATE INDEX IF NOT EXISTS idx_billing_pos_transactions_online_pending
  ON public.billing_pos_transactions (account_id, created_at)
  WHERE source = 'online' AND status = 'pending';
