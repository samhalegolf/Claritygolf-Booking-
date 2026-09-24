-- Two things the till needs before a voucher can be a way to pay.
--
-- 1. A payment method kind for coupons.
--
-- The Coupon method has been in DEFAULT_PAYMENT_METHODS as a plain `custom`
-- row, found again by its name. That never worked: the seed only fires for an
-- account with no methods at all, every real account already had some, so no
-- account ever got the row, and the till's "coupon covers everything" branch
-- looked for a method that did not exist and fell through to asking which card
-- machine to use. Matching on a name a coach can rename is the same trap the
-- Pass method was given its own kind to escape, so Coupon gets one too, and
-- billing-api.mts tops it up per account the way ensurePassPaymentMethod does.
--
-- 2. More than one booking on a sale.
--
-- Searching a client at the till now lists their unpaid lessons, and paying
-- three of them is one sale, not three. booking_id stays as it was (the first
-- lesson, so everything already reading it keeps working); booking_ids holds
-- all of them and is what the "paid" lookup reads as well.
--
-- Everything here is re-runnable, so applying it ahead of a deploy is safe: the
-- deploy runner keeps its own ledger and will execute it again.

ALTER TABLE public.billing_payment_methods
  DROP CONSTRAINT IF EXISTS billing_payment_methods_kind_check;
ALTER TABLE public.billing_payment_methods
  ADD CONSTRAINT billing_payment_methods_kind_check
  CHECK (kind = ANY (ARRAY['clarity_pay'::text, 'custom'::text, 'pass'::text, 'coupon'::text]));

ALTER TABLE public.billing_pos_transactions
  DROP CONSTRAINT IF EXISTS billing_pos_transactions_payment_method_kind_check;
ALTER TABLE public.billing_pos_transactions
  ADD CONSTRAINT billing_pos_transactions_payment_method_kind_check
  CHECK (payment_method_kind = ANY (ARRAY['clarity_pay'::text, 'custom'::text, 'pass'::text, 'coupon'::text]));

-- Any account that was seeded late enough to have the old name-matched row
-- keeps it, now under the kind that says what it is.
UPDATE public.billing_payment_methods
   SET kind = 'coupon', updated_at = now()
 WHERE kind = 'custom' AND lower(name) = 'coupon';

ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS booking_ids TEXT[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS idx_billing_pos_transactions_booking_ids
  ON public.billing_pos_transactions USING GIN (booking_ids);

COMMENT ON COLUMN public.billing_pos_transactions.booking_ids IS
  'Every lesson this sale paid for. booking_id is the first of them, kept for older readers; a lookup for "is this lesson paid" must read both.';
