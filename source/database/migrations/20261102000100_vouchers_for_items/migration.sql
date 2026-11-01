-- Gift vouchers for a lesson or a product, not only for an amount.
--
-- A voucher product can now say what it is for: an amount (as before), or one
-- of the business's lesson types or products. A voucher for a lesson is still
-- bought for money and still carries that value, but at the till it covers the
-- lesson at whatever the lesson costs that day: a price rise is the business's
-- to absorb, and a price drop does not leave change. Used for anything else, it
-- spends like money. It keeps that promise only while nothing has been spent
-- from it; part-spent, it is an ordinary balance.
--
--   billing_products_services
--     voucher_item_id        what a voucher sold from this product is for: a
--                            product id, or "lesson:" + a lesson type id.
--                            Null: an amount.
--     voucher_shows_value    whether the gift card prints the value. A lesson
--                            voucher given as a gift often should not.
--     voucher_expiry_months  how long a voucher sold from this product lasts.
--                            Null: it never expires.
--
--   billing_coupons
--     covers_item_id / covers_item_name
--                            the promise above, copied from the product when
--                            the voucher is issued, with the item's name as it
--                            was then, so renaming or retiring the lesson type
--                            later does not change what a printed card says.
--     shows_value            copied from the product, for the card and email.
--
--   billing_pos_transactions
--     coupon_value_used      what a sale took off the voucher, when that is not
--                            the slice of the sale it paid (coupon_amount): a
--                            $100 lesson voucher paying for a $120 lesson pays
--                            $120 of the sale and takes $100 off the voucher.
--                            A refund puts back what was taken. Null: the same
--                            as coupon_amount, which every older sale is.
--
-- ACCOUNT CREDIT
--
-- Money a client has with the business, spendable at the till. It is stored
-- value exactly as a voucher is -- a balance owed, spent through the same
-- guarded functions, with the same ledger -- so it is a billing_coupons row of
-- kind 'credit': one per client, filed under them, topped up rather than
-- issued again. The first thing that fills it is the surplus above.
--
--   billing_coupons.kind           'voucher' (every row so far) or 'credit'.
--   billing_pos_transactions.credit_coupon_id / credit_amount
--                                  the credit a sale gave its client, so a
--                                  refund can take it back.
--
-- Re-runnable.

ALTER TABLE public.billing_products_services
  ADD COLUMN IF NOT EXISTS voucher_item_id TEXT;
ALTER TABLE public.billing_products_services
  ADD COLUMN IF NOT EXISTS voucher_shows_value BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.billing_products_services
  ADD COLUMN IF NOT EXISTS voucher_expiry_months INTEGER;

ALTER TABLE public.billing_coupons
  ADD COLUMN IF NOT EXISTS covers_item_id TEXT;
ALTER TABLE public.billing_coupons
  ADD COLUMN IF NOT EXISTS covers_item_name TEXT;
ALTER TABLE public.billing_coupons
  ADD COLUMN IF NOT EXISTS shows_value BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS coupon_value_used NUMERIC;

ALTER TABLE public.billing_coupons
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'voucher';
ALTER TABLE public.billing_coupons
  DROP CONSTRAINT IF EXISTS billing_coupons_kind_check;
ALTER TABLE public.billing_coupons
  ADD CONSTRAINT billing_coupons_kind_check CHECK (kind IN ('voucher', 'credit'));

-- One credit balance per client.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_coupons_account_credit
  ON public.billing_coupons (account_id, customer_id)
  WHERE kind = 'credit';

ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS credit_coupon_id TEXT;
ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS credit_amount NUMERIC NOT NULL DEFAULT 0;

-- Add to a client's credit, opening it the first time. original_value is
-- everything ever credited, remaining_value what is left. A credit the coach
-- cancelled (void) starts again from this amount rather than reviving what
-- was cancelled. Returns the credit's id and new balance.
CREATE OR REPLACE FUNCTION public.billing_add_account_credit(
  p_account_id TEXT,
  p_customer_id TEXT,
  p_amount NUMERIC,
  p_currency TEXT,
  p_id TEXT,
  p_code TEXT,
  p_name TEXT
) RETURNS TABLE (id TEXT, balance NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR coalesce(p_customer_id, '') = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  INSERT INTO public.billing_coupons AS c (
    id, account_id, code, status, original_value, remaining_value, currency,
    customer_id, issued_to_name, source, kind, note, issued_at, created_at, updated_at
  ) VALUES (
    p_id, p_account_id, p_code, 'active', p_amount, p_amount, p_currency,
    p_customer_id, nullif(p_name, ''), 'pos', 'credit', 'Account credit', now(), now(), now()
  )
  ON CONFLICT (account_id, customer_id) WHERE kind = 'credit'
  DO UPDATE SET
    remaining_value = CASE WHEN c.status = 'void' THEN excluded.remaining_value
                           ELSE c.remaining_value + excluded.remaining_value END,
    original_value = c.original_value + excluded.original_value,
    issued_to_name = coalesce(excluded.issued_to_name, c.issued_to_name),
    status = 'active',
    updated_at = now()
  RETURNING c.id, c.remaining_value;
END;
$$;

-- Take credit back when the sale that gave it is refunded or voided. Only what
-- is left can come back: credit already spent stays spent. Returns what was
-- taken.
CREATE OR REPLACE FUNCTION public.billing_take_back_account_credit(
  p_account_id TEXT,
  p_coupon_id TEXT,
  p_amount NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remaining NUMERIC;
  v_taken NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN 0;
  END IF;
  SELECT remaining_value INTO v_remaining
    FROM public.billing_coupons
   WHERE id = p_coupon_id AND account_id = p_account_id AND kind = 'credit' AND status <> 'void'
   FOR UPDATE;
  IF v_remaining IS NULL THEN
    RETURN 0;
  END IF;
  v_taken := least(v_remaining, p_amount);
  UPDATE public.billing_coupons
     SET remaining_value = remaining_value - v_taken,
         status = CASE WHEN remaining_value - v_taken <= 0 THEN 'redeemed' ELSE status END,
         updated_at = now()
   WHERE id = p_coupon_id AND account_id = p_account_id;
  RETURN v_taken;
END;
$$;
