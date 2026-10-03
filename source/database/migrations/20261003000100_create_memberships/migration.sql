-- Memberships and subscriptions: a recurring payments engine whose
-- entitlements are passes.
--
-- Three tables:
--
--   membership_plans    what is for sale: price, billing period, term, and
--                       the entitlements each paid period grants
--   memberships         a person on a plan, with the plan snapshotted
--   membership_charges  one row per billing period: what was owed for it,
--                       and whether it was paid
--
-- WHY THE ENTITLEMENTS ARE PASSES
--
-- The pass ledger (20260915000100_create_pass_system) was built for this: a
-- recurring pass is one `passes` row with one `pass_allocations` row per
-- period. What it lacked was an answer to "is this still being paid for", and
-- that is the only thing this migration adds. Credits are appended when a
-- period's charge is PAID -- never on a timer -- so a membership that stops
-- paying stops granting, and nothing here can print credits on its own.
--
-- Each entitlement on a plan becomes one pass per membership, identified by
-- source = 'membership', source_ref = 'membership:<membership id>:<entitlement id>'
-- (unique via passes_source_ref_idx). Each paid period appends one allocation
-- to it (unique via pass_allocations_period_idx), so a retried webhook, a
-- double-clicked Mark paid and the billing job racing each other all land one
-- allocation.
--
-- NOTHING STORES A BALANCE here either, and no money is stored as a float:
-- every amount is integer minor units.
--
-- Re-runnable: see the two-ledger note in the repo memory -- this may be
-- applied ahead of a deploy and then run again by scripts/migrate.mjs.


-- ===========================================================================
-- membership_plans
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.membership_plans (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',

  -- Retired plans keep existing members billing on their snapshot; they just
  -- cannot be joined.
  active BOOLEAN NOT NULL DEFAULT TRUE,
  -- Offered in the player portal. Clarity Pay only, enforced in code.
  sell_online BOOLEAN NOT NULL DEFAULT FALSE,

  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('week', 'month', 'year')),
  billing_interval_count INTEGER NOT NULL DEFAULT 1
    CHECK (billing_interval_count BETWEEN 1 AND 52),

  -- 'signup': periods run from the day someone joins.
  -- 'day_of_month': monthly plans bill on one day for everybody; the first
  -- period runs short to that day and (when prorate_first) is charged pro rata.
  billing_anchor TEXT NOT NULL DEFAULT 'signup'
    CHECK (billing_anchor IN ('signup', 'day_of_month')),
  anchor_day INTEGER CHECK (anchor_day IS NULL OR anchor_day BETWEEN 1 AND 28),
  prorate_first BOOLEAN NOT NULL DEFAULT TRUE,

  signup_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (signup_fee_cents >= 0),
  trial_days INTEGER NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),

  -- NULL = until cancelled. Otherwise the membership ends by itself after this
  -- many paid periods (a "12 payments" plan).
  term_cycles INTEGER CHECK (term_cycles IS NULL OR term_cycles >= 1),
  -- Minimum commitment: a member cannot cancel before this many periods.
  -- A coach can always end one.
  min_cycles INTEGER NOT NULL DEFAULT 0 CHECK (min_cycles >= 0),

  -- What happens when card retries run out.
  failed_payment_action TEXT NOT NULL DEFAULT 'pause'
    CHECK (failed_payment_action IN ('pause', 'cancel')),

  -- [{ id, name, serviceIds[], credits, rollover, maxBalance }]
  -- Validated in _shared/memberships.mts; jsonb because it is always read and
  -- written whole, and snapshotted whole onto every membership.
  entitlements JSONB NOT NULL DEFAULT '[]'::jsonb,

  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT membership_plans_anchor_day
    CHECK (billing_anchor <> 'day_of_month' OR (anchor_day IS NOT NULL AND billing_interval = 'month'))
);

CREATE INDEX IF NOT EXISTS membership_plans_account_idx
  ON public.membership_plans (account_id, sort_order, created_at)
  WHERE archived_at IS NULL;

ALTER TABLE public.membership_plans ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- memberships
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memberships (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- No foreign key, like pass_redemptions.booking_id: a billing record must
  -- outlive a deleted client. The billing job ends any membership whose person
  -- has gone rather than charging a card nobody can see.
  person_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  -- The plan as it was when they joined. Editing a plan's price or
  -- entitlements changes what new members get, never what existing members
  -- are already paying for.
  plan_snapshot JSONB NOT NULL,

  status TEXT NOT NULL DEFAULT 'incomplete'
    CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'cancelled', 'ended')),

  -- 'card': charged automatically to a saved card on the business's Clarity
  -- Pay account. 'manual': a charge is raised each period and a coach marks
  -- it paid (cash, bank transfer, ...).
  collection TEXT NOT NULL DEFAULT 'manual' CHECK (collection IN ('card', 'manual')),

  stripe_customer_id TEXT,
  stripe_payment_method_id TEXT,
  card_label TEXT,
  -- The Stripe Checkout session currently collecting a card, if any.
  checkout_session_id TEXT,

  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trial_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  -- When the billing job next has something to do for this membership: the
  -- end of the current period, or the next retry of a failed charge.
  next_action_at TIMESTAMPTZ,
  -- Highest cycle number raised so far (0 = trial).
  cycles_raised INTEGER NOT NULL DEFAULT 0,

  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_requested_at TIMESTAMPTZ,
  cancel_reason TEXT,
  ended_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,

  failed_attempts INTEGER NOT NULL DEFAULT 0,

  -- A claim, so two overlapping billing runs never work the same membership.
  locked_until TIMESTAMPTZ,

  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The billing job's one query.
CREATE INDEX IF NOT EXISTS memberships_due_idx
  ON public.memberships (next_action_at)
  WHERE status IN ('trialing', 'active', 'past_due');

CREATE INDEX IF NOT EXISTS memberships_person_idx
  ON public.memberships (account_id, person_id, created_at DESC);

CREATE INDEX IF NOT EXISTS memberships_account_status_idx
  ON public.memberships (account_id, status);

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- membership_charges -- one per billing period
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.membership_charges (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  membership_id TEXT NOT NULL REFERENCES public.memberships(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,

  -- 0 is a trial period, 1 the first paid period.
  cycle_number INTEGER NOT NULL CHECK (cycle_number >= 0),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,

  -- amount_cents is the whole charge; signup_fee_cents is the part of it that
  -- was the joining fee, kept so reporting can tell the two apart.
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  signup_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (signup_fee_cents >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description TEXT NOT NULL DEFAULT '',

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'requires_action', 'waived', 'void', 'refunded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  stripe_payment_intent_id TEXT,

  paid_at TIMESTAMPTZ,
  -- 'card', 'trial', 'free', or what a coach typed (Cash, Bank transfer...).
  paid_via TEXT,
  note TEXT NOT NULL DEFAULT '',
  -- Set once the period's entitlements have been appended to the passes.
  granted_at TIMESTAMPTZ,

  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT membership_charges_period_order CHECK (period_end > period_start)
);

-- One charge per period, ever. This is what makes raising a charge safe to
-- retry from any number of overlapping runs.
CREATE UNIQUE INDEX IF NOT EXISTS membership_charges_cycle_idx
  ON public.membership_charges (membership_id, cycle_number);

CREATE UNIQUE INDEX IF NOT EXISTS membership_charges_payment_intent_idx
  ON public.membership_charges (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS membership_charges_account_idx
  ON public.membership_charges (account_id, status, period_start DESC);

ALTER TABLE public.membership_charges ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- Passes learn one new source
-- ===========================================================================
--
-- The live constraints have drifted from the pass-system migration file (the
-- database has 'stripe' and lacks 'reversal' on allocations), so both are
-- rebuilt here as the union of everything either has ever allowed, plus
-- 'membership'. Nothing that exists today can fail the new check.

ALTER TABLE public.passes DROP CONSTRAINT IF EXISTS passes_source_check;
ALTER TABLE public.passes ADD CONSTRAINT passes_source_check CHECK (source IN (
  'manual', 'clarity_pos', 'clarity_invoice', 'clarity_checkout', 'optix',
  'stripe', 'stripe_subscription', 'promotion', 'membership'
));

ALTER TABLE public.pass_allocations DROP CONSTRAINT IF EXISTS pass_allocations_source_check;
ALTER TABLE public.pass_allocations ADD CONSTRAINT pass_allocations_source_check CHECK (source IN (
  'manual', 'purchase', 'clarity_pos', 'clarity_invoice', 'clarity_checkout', 'optix',
  'stripe', 'stripe_subscription', 'promotion', 'reversal', 'membership'
));

COMMENT ON TABLE public.membership_plans IS
  'Recurring plans: price, billing period, term and the pass entitlements each paid period grants. Snapshotted onto memberships at join time.';
COMMENT ON TABLE public.memberships IS
  'A person on a plan. Billed by netlify/functions/memberships-billing.mts; entitlements are recurring passes (source membership) topped up only when a period is paid.';
COMMENT ON TABLE public.membership_charges IS
  'One row per billing period. Unique on (membership_id, cycle_number). Entitlements for the period are appended to passes when status becomes paid (granted_at).';

NOTIFY pgrst, 'reload schema';
