-- Value-backed pass exchange.
--
-- Existing allocations remain strict/native-only: acquisition value is NULL
-- unless it can be taken from the transaction that issued the lot. Nothing in
-- this migration guesses historical value from today's service catalogue.

ALTER TABLE public.passes
  ADD COLUMN IF NOT EXISTS cross_redeemable BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.pass_allocations
  ADD COLUMN IF NOT EXISTS entitlement_service_id TEXT,
  ADD COLUMN IF NOT EXISTS total_value_cents BIGINT,
  ADD COLUMN IF NOT EXISTS currency TEXT;

ALTER TABLE public.pass_allocations
  DROP CONSTRAINT IF EXISTS pass_allocations_value_shape;

ALTER TABLE public.pass_allocations
  ADD CONSTRAINT pass_allocations_value_shape CHECK (
    (total_value_cents IS NULL AND currency IS NULL)
    OR (
      total_value_cents IS NOT NULL
      AND total_value_cents >= 0
      AND currency IS NOT NULL
      AND currency ~ '^[A-Z]{3}$'
    )
  );

ALTER TABLE public.pass_redemptions
  ADD COLUMN IF NOT EXISTS value_cents BIGINT,
  ADD COLUMN IF NOT EXISTS redemption_kind TEXT NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS value_transaction_id TEXT;

ALTER TABLE public.pass_redemptions
  DROP CONSTRAINT IF EXISTS pass_redemptions_kind_check;

ALTER TABLE public.pass_redemptions
  ADD CONSTRAINT pass_redemptions_kind_check
  CHECK (redemption_kind IN ('native', 'cross_redemption'));

CREATE TABLE IF NOT EXISTS public.pass_value_transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES public.people(id) ON DELETE RESTRICT,
  booking_id TEXT,
  target_service_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('cross_redemption', 'purchase_tender', 'refund', 'reversal')),
  target_value_cents BIGINT NOT NULL CHECK (target_value_cents >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_ref TEXT,
  settled_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  reversed_by TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live value settlement per booking. A cross settlement can consume more
-- than one entitlement lot, so the transaction groups those rows.
CREATE UNIQUE INDEX IF NOT EXISTS pass_value_transactions_live_booking_idx
  ON public.pass_value_transactions (account_id, booking_id)
  WHERE booking_id IS NOT NULL AND reversed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pass_value_transactions_source_ref_idx
  ON public.pass_value_transactions (account_id, source_ref)
  WHERE source_ref IS NOT NULL AND source_ref <> '';

CREATE TABLE IF NOT EXISTS public.pass_value_movements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES public.people(id) ON DELETE RESTRICT,
  transaction_id TEXT NOT NULL REFERENCES public.pass_value_transactions(id) ON DELETE RESTRICT,
  pass_id TEXT REFERENCES public.passes(id) ON DELETE RESTRICT,
  allocation_id TEXT REFERENCES public.pass_allocations(id) ON DELETE RESTRICT,
  redemption_id TEXT REFERENCES public.pass_redemptions(id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  movement_kind TEXT NOT NULL CHECK (movement_kind IN (
    'residual_created',
    'flexible_spent',
    'refund_credit',
    'reversal'
  )),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.pass_redemptions
  DROP CONSTRAINT IF EXISTS pass_redemptions_value_transaction_id_fkey;

ALTER TABLE public.pass_redemptions
  ADD CONSTRAINT pass_redemptions_value_transaction_id_fkey
  FOREIGN KEY (value_transaction_id)
  REFERENCES public.pass_value_transactions(id)
  ON DELETE RESTRICT;

DROP INDEX IF EXISTS public.pass_redemptions_live_booking_idx;
CREATE UNIQUE INDEX pass_redemptions_live_booking_idx
  ON public.pass_redemptions (booking_id)
  WHERE reversed_at IS NULL
    AND booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pass_value_movements_balance_idx
  ON public.pass_value_movements (account_id, person_id, currency, created_at);

ALTER TABLE public.pass_value_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pass_value_movements ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.billing_payment_tenders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  purchase_ref TEXT NOT NULL,
  tender_kind TEXT NOT NULL CHECK (tender_kind IN (
    'clarity_credit', 'card', 'cash', 'bank', 'invoice_credit', 'gift_value'
  )),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  pass_value_transaction_id TEXT REFERENCES public.pass_value_transactions(id) ON DELETE RESTRICT,
  external_payment_ref TEXT,
  refunded_cents BIGINT NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, purchase_ref, tender_kind)
);

CREATE INDEX IF NOT EXISTS billing_payment_tenders_purchase_idx
  ON public.billing_payment_tenders (account_id, purchase_ref);

ALTER TABLE public.billing_payment_tenders ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE VIEW public.pass_flexible_value_balances
WITH (security_invoker = true) AS
SELECT
  account_id,
  person_id,
  currency,
  SUM(amount_cents)::BIGINT AS value_cents
FROM public.pass_value_movements
GROUP BY account_id, person_id, currency
HAVING SUM(amount_cents) <> 0;

-- Extend the canonical allocation balance without moving balance arithmetic
-- into application code. Exact per-unit value is deterministic: any division
-- remainder belongs to the earliest units in the lot, so all unit values sum
-- exactly to the transaction value.
DROP VIEW IF EXISTS public.pass_balances;
DROP VIEW IF EXISTS public.pass_allocation_balances;

CREATE VIEW public.pass_allocation_balances
WITH (security_invoker = true) AS
SELECT
  a.id AS allocation_id,
  a.account_id,
  a.pass_id,
  a.credits AS credits_allocated,
  COALESCE(r.credits_redeemed, 0) AS credits_redeemed,
  a.credits - COALESCE(r.credits_redeemed, 0) AS credits_available,
  a.entitlement_service_id,
  a.total_value_cents,
  CASE
    WHEN a.total_value_cents IS NULL THEN NULL
    ELSE (a.total_value_cents / a.credits)::BIGINT
  END AS base_unit_value_cents,
  CASE
    WHEN a.total_value_cents IS NULL THEN NULL
    ELSE (a.total_value_cents % a.credits)::INTEGER
  END AS higher_value_unit_count,
  a.currency,
  a.available_from,
  a.expires_at,
  a.allocation_period_start,
  a.allocation_period_end,
  a.source,
  a.note,
  a.created_at,
  (
    a.available_from <= NOW()
    AND (a.expires_at IS NULL OR a.expires_at > NOW())
  ) AS is_live
FROM public.pass_allocations a
LEFT JOIN (
  SELECT allocation_id, SUM(credits) AS credits_redeemed
  FROM public.pass_redemptions
  WHERE reversed_at IS NULL
  GROUP BY allocation_id
) r ON r.allocation_id = a.id;

CREATE VIEW public.pass_balances
WITH (security_invoker = true) AS
SELECT
  p.id AS pass_id,
  p.account_id,
  p.person_id,
  p.name,
  p.template_service_id,
  p.covers_service_ids,
  p.cross_redeemable,
  p.status AS stored_status,
  p.starts_at,
  p.expires_at,
  p.allocation_mode,
  p.allocation_interval,
  p.rollover_policy,
  p.max_balance,
  COALESCE(live.credits_available, 0) AS credits_available,
  COALESCE(all_time.credits_allocated, 0) AS credits_allocated_all_time,
  COALESCE(all_time.credits_redeemed, 0) AS credits_redeemed_all_time,
  live.next_expiry,
  CASE
    WHEN p.status = 'void' THEN 'void'
    WHEN p.expires_at IS NOT NULL AND p.expires_at <= NOW() THEN 'expired'
    WHEN p.starts_at IS NOT NULL AND p.starts_at > NOW() THEN 'scheduled'
    WHEN COALESCE(live.credits_available, 0) <= 0 THEN 'exhausted'
    ELSE 'active'
  END AS effective_status
FROM public.passes p
LEFT JOIN (
  SELECT
    pass_id,
    SUM(credits_available) AS credits_available,
    MIN(expires_at) FILTER (WHERE expires_at IS NOT NULL AND credits_available > 0) AS next_expiry
  FROM public.pass_allocation_balances
  WHERE is_live AND credits_available > 0
  GROUP BY pass_id
) live ON live.pass_id = p.id
LEFT JOIN (
  SELECT
    pass_id,
    SUM(credits_allocated) AS credits_allocated,
    SUM(credits_redeemed) AS credits_redeemed
  FROM public.pass_allocation_balances
  GROUP BY pass_id
) all_time ON all_time.pass_id = p.id;

COMMENT ON COLUMN public.passes.cross_redeemable IS
  'Snapshot of the package setting at issue time. FALSE preserves strict legacy behavior.';
COMMENT ON COLUMN public.pass_allocations.total_value_cents IS
  'Exact economic consideration for this allocation lot. NULL means unknown and therefore native-only; never backfilled from current catalogue price.';
COMMENT ON COLUMN public.pass_allocations.entitlement_service_id IS
  'The original service identity bought by this allocation. It remains unchanged when a unit is cross-redeemed.';
COMMENT ON TABLE public.pass_value_movements IS
  'Append-only monetary residual movements belonging to the Pass ledger. Positive creates flexible value; negative spends it; reversals append compensating rows.';

NOTIFY pgrst, 'reload schema';
