-- Paying for a lesson with a pass.
--
-- A redemption settles the booking through the machinery that already exists:
-- it writes an ordinary billing_pos_transactions row for $0, with listed_amount
-- carrying what the lesson would have cost. posBookingPayments picks it up, the
-- lesson card shows its paid badge, and the invoice pull list treats it as
-- settled -- none of which needs to learn what a pass is.
--
-- That only needs one thing from the schema: both kind columns currently allow
-- 'clarity_pay' and 'custom' only.
--
-- WHY NOT SEED 'Pass' AS kind = 'custom'
--
-- Because reporting would then have to identify it by its name, and the day
-- somebody renames it to "Passes" the takings row silently empties. A payment
-- method that settles a sale without money changing hands is a different kind
-- of thing from cash, and the column should say so.

ALTER TABLE public.billing_payment_methods
  DROP CONSTRAINT IF EXISTS billing_payment_methods_kind_check;

ALTER TABLE public.billing_payment_methods
  ADD CONSTRAINT billing_payment_methods_kind_check
  CHECK (kind IN ('clarity_pay', 'custom', 'pass'));

ALTER TABLE public.billing_pos_transactions
  DROP CONSTRAINT IF EXISTS billing_pos_transactions_payment_method_kind_check;

ALTER TABLE public.billing_pos_transactions
  ADD CONSTRAINT billing_pos_transactions_payment_method_kind_check
  CHECK (payment_method_kind IN ('clarity_pay', 'custom', 'pass'));

COMMENT ON COLUMN public.billing_payment_methods.kind IS
  'clarity_pay = Stripe-backed. custom = a manual method the coach can rename or retire. pass = settled from a pass entitlement, so the sale is recorded at 0 with listed_amount holding what it would have cost.';

NOTIFY pgrst, 'reload schema';
