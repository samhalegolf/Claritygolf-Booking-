-- Clarity Pay at the counter by Tap to Pay (Stripe Terminal).
--
-- Terminal is a new way of settling an existing POS sale, not a second till.
-- Nothing here creates a sale; everything hangs off billing_pos_transactions.
--
-- 1. How the money was collected, apart from what it was.
--
-- billing_payment_tenders already records each component of a purchase
-- (credit, card, gift value). A card can now arrive three ways -- the QR
-- Checkout page, Tap to Pay on an iPhone, and one day a physical reader -- and
-- none of those is a different payment method to the business. They are all
-- Clarity Pay. So the collection channel is its own column rather than a new
-- tender kind or a new payment-method row.
--
-- 2. The Terminal attempts on a sale.
--
-- One row per PaymentIntent. The partial unique index is what makes "a sale has
-- at most one live Terminal charge" a database fact rather than a hope: two
-- taps on "Tap card" race for the same slot and one of them loses.
--
-- 3. Which Stripe Terminal location a Clarity location is.
--
-- Stripe needs a Terminal location before a phone can take a payment. Kept as a
-- mapping table so the Clarity location model carries nothing of Stripe's.
--
-- Everything here is re-runnable.

ALTER TABLE public.billing_payment_tenders
  ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE public.billing_payment_tenders
  DROP CONSTRAINT IF EXISTS billing_payment_tenders_channel_check;
ALTER TABLE public.billing_payment_tenders
  ADD CONSTRAINT billing_payment_tenders_channel_check
  CHECK (channel IS NULL OR channel = ANY (ARRAY[
    'stripe_checkout'::text, 'terminal_tap_to_pay'::text, 'terminal_reader'::text,
    'manual_cash'::text, 'bank'::text, 'coupon'::text, 'clarity_credit'::text, 'pass'::text
  ]));
ALTER TABLE public.billing_payment_tenders
  ADD COLUMN IF NOT EXISTS card_brand TEXT;
ALTER TABLE public.billing_payment_tenders
  ADD COLUMN IF NOT EXISTS card_last4 TEXT;

COMMENT ON COLUMN public.billing_payment_tenders.channel IS
  'How this tender was collected. The payment method stays Clarity Pay whichever way a card arrived.';

-- The sale's own copy of how its card part arrived, so a transaction list can
-- say "Tap to Pay" without a second read per row. The tenders stay the record.
ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS payment_channel TEXT;

CREATE TABLE IF NOT EXISTS public.billing_terminal_payments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  -- Null only for the moment between claiming the slot and Stripe answering.
  payment_intent_id TEXT UNIQUE,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  livemode BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'succeeded', 'canceled')),
  channel TEXT NOT NULL DEFAULT 'terminal_tap_to_pay'
    CHECK (channel IN ('terminal_tap_to_pay', 'terminal_reader')),
  device_id TEXT,
  device_name TEXT,
  actor_id TEXT,
  clarity_location_id TEXT,
  stripe_terminal_location_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_terminal_payments_one_open
  ON public.billing_terminal_payments (account_id, transaction_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS billing_terminal_payments_transaction_idx
  ON public.billing_terminal_payments (account_id, transaction_id, created_at DESC);

ALTER TABLE public.billing_terminal_payments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.billing_terminal_locations (
  account_id TEXT NOT NULL,
  clarity_location_id TEXT NOT NULL,
  livemode BOOLEAN NOT NULL,
  stripe_terminal_location_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, clarity_location_id, livemode)
);

ALTER TABLE public.billing_terminal_locations ENABLE ROW LEVEL SECURITY;
