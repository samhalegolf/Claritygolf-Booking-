-- The Pass system: one shape of entitlement, many sources.
--
-- A Pass is a named person holding credits, valid for certain services, until
-- it expires. Optix sold it, you sold it at the counter, or you gave it away --
-- once issued it behaves identically. That is the whole point of owning it.
--
-- Three tables, and the split between the second and third is the design:
--
--   passes            what someone is entitled to
--   pass_allocations  credits being added        (append-only)
--   pass_redemptions  credits being used         (append-only)
--
-- WHY ALLOCATIONS ARE A SEPARATE TABLE
--
-- The obvious shape is `passes.credits_total` and count the redemptions against
-- it. That works for a five-lesson package and breaks the moment anything tops
-- a pass up -- a monthly membership, a second purchase, a goodwill credit --
-- because the only way to express "two more" is to overwrite the number, and an
-- overwritten number cannot say why it is what it is.
--
-- With allocations, "why does Sam have 3 reviews?" is answerable from the rows:
-- September +2, used -1, October +2. Nothing was ever rewritten. A recurring
-- pass looks to the player like a balance that refills; underneath, each period
-- is a new row that can be audited, dated, and attributed to whatever paid for
-- it.
--
-- NOTHING STORES A BALANCE. Not on the pass, not on the allocation. Balance is
-- always allocations minus live redemptions, computed by the two views at the
-- bottom of this file. A stored balance is a number that can drift from the
-- ledger, and when it drifts you have no way to tell which one is wrong.
--
-- WHAT DOES NOT EXIST HERE, DELIBERATELY
--
--   * No credit_type column. A swing review is a booking of a service whose
--     lessonFormat is 'video-review' (booking-core.mts:346) -- it already flows
--     through the normal booking path with a server-set deadline instead of a
--     slot. So a "swing review credit" is just a pass covering a video-review
--     service id, and one pass covering four lessons and two reviews is one
--     coverage list, not a second entitlement taxonomy.
--   * No swing_review_request_id on redemptions. Same reason: there is one
--     thing a credit is spent on, a booking, and one nullable FK means the
--     partial unique index below actually guards every redemption.
--
-- Service-role only, like every other table in this app: RLS enabled, no client
-- policy. The browser never talks to Postgres directly.


-- ===========================================================================
-- passes -- an issued entitlement, living under a person
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.passes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,

  -- Nullable on purpose. An Optix new_sale carries a display name and no email,
  -- so a purchase that cannot be matched to a person with confidence is issued
  -- unassigned and waits in the Pass Inbox. A pass with no owner is honest; a
  -- pass attached to the wrong owner is found out at the counter.
  --
  -- ON DELETE SET NULL rather than CASCADE: deleting a person must not silently
  -- destroy a ledger that recorded money. The pass falls back to the unassigned
  -- state, which already has a meaning and a screen.
  --
  -- The key is people.id alone, so this constraint does NOT stop a pass
  -- pointing at a person in another account. Account scoping is the query's
  -- job, in the SQL and not in a filter afterwards, as everywhere else here.
  person_id TEXT REFERENCES public.people(id) ON DELETE SET NULL,

  -- Snapshots, not references. Services live inside the settings blob
  -- (servicesJson, booking-core.mts:5428), not a table, so there is no
  -- referential integrity available here and a service can vanish from the JSON
  -- entirely. These columns must keep working when it does -- and must not
  -- change under a pass someone already holds when the template is edited.
  name TEXT NOT NULL,
  template_service_id TEXT,
  covers_service_ids TEXT[] NOT NULL DEFAULT '{}',

  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,

  -- The ONLY stored state. Everything else a pass can be -- expired, exhausted,
  -- not started yet -- is a fact about the clock and the ledger, derived in
  -- pass_balances below.
  --
  -- This matters more than it did before allocations: a recurring pass goes
  -- from exhausted back to active at midnight on the 1st with no write
  -- anywhere, so a cached status column would be wrong for as long as nobody
  -- touched the pass.
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'void')),
  voided_at TIMESTAMPTZ,
  void_reason TEXT,

  -- Where the entitlement came from and what keeps it funded. One pair of
  -- columns, not two: a Stripe subscription is a source like any other, and
  -- giving it its own funding_type/funding_ref would mean every read path has
  -- to check both.
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN (
      'manual',
      'clarity_pos',
      'clarity_invoice',
      'clarity_checkout',
      'optix',
      'stripe_subscription',
      'promotion'
    )),
  source_ref TEXT,

  -- The allocation policy, snapshotted at issue time for the same reason
  -- coverage is. Editing "2 reviews a month" to "1 a month" on the template
  -- must change what new passes do, not quietly halve what existing members
  -- are already paying for.
  allocation_mode TEXT NOT NULL DEFAULT 'one_off'
    CHECK (allocation_mode IN ('one_off', 'recurring')),
  allocation_interval TEXT
    CHECK (allocation_interval IS NULL OR allocation_interval IN ('week', 'month', 'year')),
  allocation_interval_count INTEGER NOT NULL DEFAULT 1
    CHECK (allocation_interval_count >= 1),
  credits_per_period INTEGER NOT NULL DEFAULT 1
    CHECK (credits_per_period >= 1),

  rollover_policy TEXT NOT NULL DEFAULT 'rollover'
    CHECK (rollover_policy IN ('expire_each_period', 'rollover', 'rollover_capped')),
  max_balance INTEGER
    CHECK (max_balance IS NULL OR max_balance >= 1),

  amount_paid_cents INTEGER,
  currency TEXT,
  note TEXT,

  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A recurring pass with no interval would have no way to date its periods.
  CONSTRAINT passes_recurring_needs_interval
    CHECK (allocation_mode <> 'recurring' OR allocation_interval IS NOT NULL),
  -- A cap is only meaningful for the one policy that reads it.
  CONSTRAINT passes_capped_needs_max
    CHECK (rollover_policy <> 'rollover_capped' OR max_balance IS NOT NULL)
);

-- The checkout lookup: "active passes for this person", run every time a lesson
-- card opens a till.
CREATE INDEX IF NOT EXISTS passes_person_active_idx
  ON public.passes (account_id, person_id, expires_at)
  WHERE status = 'active';

-- The Pass Inbox: everything issued but not yet attached to anyone.
CREATE INDEX IF NOT EXISTS passes_unassigned_idx
  ON public.passes (account_id, issued_at DESC)
  WHERE person_id IS NULL AND status = 'active';

-- Issuing is idempotent on the thing that paid for it, so a redelivered Optix
-- webhook or a double-submitted invoice cannot mint a second pass.
CREATE UNIQUE INDEX IF NOT EXISTS passes_source_ref_idx
  ON public.passes (account_id, source, source_ref)
  WHERE source_ref IS NOT NULL AND source_ref <> '';

ALTER TABLE public.passes ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- pass_allocations -- credits being added. Append-only.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.pass_allocations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- CASCADE is safe here only because a pass is voided, never deleted. And a
  -- pass that has actually been spent cannot be deleted even by accident: the
  -- cascade reaches these rows, and the RESTRICT on pass_redemptions.
  -- allocation_id then refuses to let them go.
  pass_id TEXT NOT NULL REFERENCES public.passes(id) ON DELETE CASCADE,

  credits INTEGER NOT NULL CHECK (credits > 0),

  -- What the policy asked for, before max_balance capped it. Only differs under
  -- rollover_capped, and exists so that the one allocation mode which is not a
  -- pure function of the ledger still explains itself: without it, a top-up job
  -- that ran late is indistinguishable from one that ran on time.
  credits_requested INTEGER CHECK (credits_requested IS NULL OR credits_requested > 0),

  available_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = follows the pass. This is where rollover policy actually lives:
  -- expire_each_period sets this to allocation_period_end, rollover leaves it
  -- NULL. Neither needs a branch at spend time.
  expires_at TIMESTAMPTZ,

  -- NULL for a one-off. Set for each period of a recurring pass, and the reason
  -- a membership never has to overwrite a number: September is a row, October
  -- is another row.
  allocation_period_start TIMESTAMPTZ,
  allocation_period_end TIMESTAMPTZ,

  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN (
      'manual',
      'purchase',
      'clarity_pos',
      'clarity_invoice',
      'clarity_checkout',
      'optix',
      'stripe_subscription',
      'promotion',
      'reversal'
    )),
  source_ref TEXT,

  note TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pass_allocations_period_pairs
    CHECK (
      (allocation_period_start IS NULL AND allocation_period_end IS NULL)
      OR (allocation_period_start IS NOT NULL AND allocation_period_end IS NOT NULL)
    )
);

-- One allocation per pass per period. This is what makes a recurring top-up
-- safe to compute lazily on read: whoever gets there first inserts the row, and
-- a concurrent request, a retried webhook, or a job that fires twice all lose
-- the race harmlessly instead of doubling someone's credits.
CREATE UNIQUE INDEX IF NOT EXISTS pass_allocations_period_idx
  ON public.pass_allocations (pass_id, allocation_period_start)
  WHERE allocation_period_start IS NOT NULL;

-- The same guarantee for one-off funding. Scoped to the pass as well as the
-- reference, because one invoice can legitimately contain two pass line items.
CREATE UNIQUE INDEX IF NOT EXISTS pass_allocations_source_ref_idx
  ON public.pass_allocations (account_id, pass_id, source, source_ref)
  WHERE source_ref IS NOT NULL AND source_ref <> '';

-- Spend order (earliest expiry first) and the balance views.
CREATE INDEX IF NOT EXISTS pass_allocations_spend_order_idx
  ON public.pass_allocations (pass_id, expires_at NULLS LAST, available_from);

ALTER TABLE public.pass_allocations ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- pass_redemptions -- credits being used. Append-only.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.pass_redemptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  pass_id TEXT NOT NULL REFERENCES public.passes(id) ON DELETE CASCADE,

  -- Which credits were actually spent. RESTRICT, not CASCADE: an allocation
  -- with a redemption against it is history and cannot be removed.
  --
  -- Recording this is what makes expire_each_period possible at all -- without
  -- it there is no way to say whether a spend came out of September's credits
  -- or October's, and a balance that cannot answer that is back to being a
  -- number you have to trust.
  allocation_id TEXT NOT NULL REFERENCES public.pass_allocations(id) ON DELETE RESTRICT,

  -- calendar_items.id. No foreign key, on purpose: a ledger line has to survive
  -- the booking it refers to being deleted. The application reverses the
  -- redemption when a lesson is cancelled or deleted; if it ever fails to, the
  -- fix is to find the orphan, not to have lost the row.
  booking_id TEXT,

  -- Normally 1. Lets a 60-minute lesson burn two credits off a 30-minute pass
  -- if that is ever wanted.
  credits INTEGER NOT NULL DEFAULT 1 CHECK (credits > 0),

  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redeemed_by TEXT NOT NULL DEFAULT '',
  -- The $0 sale that recorded it, so the booking settles through the existing
  -- paid-lesson machinery rather than a parallel notion of "paid".
  pos_transaction_id TEXT,

  -- Set, never deleted. A reversal is a fact about the ledger, not an absence.
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  reversed_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The guard that makes double-spending structurally impossible instead of
-- something the checkout has to remember: one live redemption per booking, ever.
-- Two coaches on two devices settling the same lesson at the same moment is a
-- real thing in a busy bay, and the second one gets a unique violation rather
-- than a silently negative balance.
CREATE UNIQUE INDEX IF NOT EXISTS pass_redemptions_live_booking_idx
  ON public.pass_redemptions (booking_id)
  WHERE reversed_at IS NULL AND booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pass_redemptions_allocation_idx
  ON public.pass_redemptions (allocation_id)
  WHERE reversed_at IS NULL;

CREATE INDEX IF NOT EXISTS pass_redemptions_pass_history_idx
  ON public.pass_redemptions (account_id, pass_id, redeemed_at DESC);

ALTER TABLE public.pass_redemptions ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- Views -- the one place balance arithmetic is allowed to exist
-- ===========================================================================

-- Per allocation: what it granted, what has been spent out of it, what is left.
--
-- Netting per allocation rather than per pass is not a detail. Spend is tied to
-- the allocation it came from, so a credit used in September must reduce
-- September's row and not October's -- otherwise an expired allocation's
-- history would quietly eat a fresh month's credits.
--
-- This is also the query the checkout selects from: earliest expiry first, so
-- credits are never left to expire while newer ones get spent.
--
-- security_invoker = true is not optional. A Postgres view defaults to running
-- as its owner, which means it reads straight past the row level security on
-- the tables underneath it -- so a view over an RLS-protected ledger becomes
-- the hole in that protection the moment anon or authenticated has SELECT on
-- it. Every table here has RLS on with no policy, and these views have to
-- inherit that rather than quietly undo it.
CREATE OR REPLACE VIEW public.pass_allocation_balances
WITH (security_invoker = true) AS
SELECT
  a.id                AS allocation_id,
  a.account_id,
  a.pass_id,
  a.credits           AS credits_allocated,
  COALESCE(r.credits_redeemed, 0)              AS credits_redeemed,
  a.credits - COALESCE(r.credits_redeemed, 0)  AS credits_available,
  a.available_from,
  a.expires_at,
  a.allocation_period_start,
  a.allocation_period_end,
  a.source,
  -- "Spendable right now", which is what every caller actually wants.
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

COMMENT ON VIEW public.pass_allocation_balances IS
  'Per-allocation netting: credits granted minus live redemptions against that same allocation. is_live answers "spendable now". Ordered by (expires_at NULLS LAST, available_from) this is the credit-consumption order -- oldest-expiring first.';


-- Per pass: the number a human is shown, and the status nothing stores.
-- security_invoker = true for the same reason as above.
CREATE OR REPLACE VIEW public.pass_balances
WITH (security_invoker = true) AS
SELECT
  p.id AS pass_id,
  p.account_id,
  p.person_id,
  p.name,
  p.template_service_id,
  p.covers_service_ids,
  p.status AS stored_status,
  p.starts_at,
  p.expires_at,
  p.allocation_mode,
  p.allocation_interval,
  p.rollover_policy,
  p.max_balance,

  COALESCE(live.credits_available, 0)   AS credits_available,
  COALESCE(all_time.credits_allocated, 0) AS credits_allocated_all_time,
  COALESCE(all_time.credits_redeemed, 0)  AS credits_redeemed_all_time,
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
    SUM(credits_redeemed)  AS credits_redeemed
  FROM public.pass_allocation_balances
  GROUP BY pass_id
) all_time ON all_time.pass_id = p.id;

COMMENT ON VIEW public.pass_balances IS
  'The canonical balance. Every surface -- player portal, client profile, checkout, booking -- reads this rather than doing its own arithmetic. effective_status is derived on every read because a recurring pass stops being exhausted at the start of a period without anything writing to it.';


COMMENT ON TABLE public.passes IS
  'An issued entitlement under a person. Holds no balance: see pass_balances. status stores only what cannot be derived (void); expired/exhausted/scheduled are computed. Coverage and allocation policy are snapshots taken at issue time, so editing a template never re-scopes a pass someone already holds.';

COMMENT ON TABLE public.pass_allocations IS
  'Append-only: credits being added. A one-off package is one row; a recurring pass is one row per period, never an overwritten number. Unique on (pass_id, allocation_period_start) so a retried webhook or a doubled job cannot mint credits twice.';

COMMENT ON TABLE public.pass_redemptions IS
  'Append-only: credits being used. Never deleted -- a reversal sets reversed_at. Unique on (booking_id) where live, which is what makes spending the same credit twice impossible rather than merely unlikely.';

COMMENT ON COLUMN public.passes.source IS
  'Where the entitlement came from, and what keeps it funded. Deliberately one column rather than a separate funding_type: a Stripe subscription is a source like any other and must not need its own read path.';

COMMENT ON COLUMN public.passes.allocation_mode IS
  'one_off grants once. recurring grants credits_per_period each interval. NOTE: the write path only issues one_off until a funding source exists that can be checked for "is this still paid for" -- a recurring pass must never be a job that adds credits forever on its own.';

COMMENT ON COLUMN public.pass_allocations.credits_requested IS
  'What the policy asked for before max_balance capped it. Only set under rollover_capped. Exists so the one allocation mode that is not a pure function of the ledger still records the decision it made.';

COMMENT ON COLUMN public.pass_redemptions.booking_id IS
  'calendar_items.id, intentionally without a foreign key: the ledger line must outlive the booking. Includes video reviews, which are ordinary bookings of a video-review service.';

NOTIFY pgrst, 'reload schema';
