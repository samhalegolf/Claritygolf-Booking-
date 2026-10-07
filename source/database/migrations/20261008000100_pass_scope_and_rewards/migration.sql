-- Passes that cover every service, and a rewards programme that earns them.
--
-- 1. passes.covers_all_services
--
-- Until now a pass covered exactly the services listed in covers_service_ids,
-- and an empty list covered nothing (deliberately: an empty list is what a
-- half-filled form looks like, and it must not mean "anything"). A pass that
-- is meant to pay for anything the business sells needs to say so in its own
-- column, so "site wide" is a decision somebody made rather than an absence.
-- It is a snapshot like the list beside it: changing a pass type later never
-- re-scopes a pass already in somebody's hands.
--
-- 2. 'reward' as a pass source
--
-- 3. reward_programs
--
-- A rewards programme grants pass credits for activity -- every N completed
-- lessons, or every $X spent at the till. It is wired the way memberships are:
-- what a person has earned is one `passes` row per (programme, person)
-- identified by source = 'reward', source_ref = 'reward:<programme>:<person>',
-- and each milestone reached appends one allocation with
-- source_ref = 'milestone:<n>' (unique via pass_allocations_source_ref_idx).
--
-- NOTHING STORES PROGRESS. How far somebody is towards their next reward is
-- always recounted from the activity itself (calendar_items, billing_pos_
-- transactions) since the programme's counts_from date, and the milestones
-- already paid are the allocations already written. A rerun, two overlapping
-- sweeps or a coach pressing Run now all land each milestone exactly once.
--
-- Re-runnable: see the two-ledger note -- this may be applied ahead of a deploy
-- and then run again by scripts/migrate.mjs.

ALTER TABLE public.passes
  ADD COLUMN IF NOT EXISTS covers_all_services BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.passes.covers_all_services IS
  'True: the pass pays for any service, and covers_service_ids is ignored. False: only the listed services, and an empty list covers nothing.';

ALTER TABLE public.passes DROP CONSTRAINT IF EXISTS passes_source_check;
ALTER TABLE public.passes ADD CONSTRAINT passes_source_check CHECK (source IN (
  'manual', 'clarity_pos', 'clarity_invoice', 'clarity_checkout', 'optix',
  'stripe', 'stripe_subscription', 'promotion', 'membership', 'reward'
));

ALTER TABLE public.pass_allocations DROP CONSTRAINT IF EXISTS pass_allocations_source_check;
ALTER TABLE public.pass_allocations ADD CONSTRAINT pass_allocations_source_check CHECK (source IN (
  'manual', 'purchase', 'clarity_pos', 'clarity_invoice', 'clarity_checkout', 'optix',
  'stripe', 'stripe_subscription', 'promotion', 'reversal', 'membership', 'reward'
));


CREATE TABLE IF NOT EXISTS public.reward_programs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,

  -- What earns a reward.
  --   'lessons_completed'  every `threshold` completed bookings
  --   'amount_spent'       every `threshold` minor units paid at the till
  trigger TEXT NOT NULL CHECK (trigger IN ('lessons_completed', 'amount_spent')),
  threshold BIGINT NOT NULL CHECK (threshold >= 1),
  -- Which bookings count towards a lessons_completed programme. Ignored when
  -- counts_all_services is true, and for amount_spent.
  counts_service_ids TEXT[] NOT NULL DEFAULT '{}',
  counts_all_services BOOLEAN NOT NULL DEFAULT TRUE,
  -- Only activity on or after this moment counts, so starting a programme
  -- does not pay out for years of history nobody decided to reward.
  counts_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- What a reward is.
  reward_credits INTEGER NOT NULL CHECK (reward_credits BETWEEN 1 AND 100),
  reward_covers_service_ids TEXT[] NOT NULL DEFAULT '{}',
  reward_covers_all_services BOOLEAN NOT NULL DEFAULT FALSE,
  -- Months each reward's credits stay spendable. NULL = no expiry.
  reward_expiry_months INTEGER CHECK (reward_expiry_months IS NULL OR reward_expiry_months BETWEEN 1 AND 120),
  -- NULL = no limit. Otherwise a person earns at most this many rewards.
  max_rewards_per_person INTEGER CHECK (max_rewards_per_person IS NULL OR max_rewards_per_person >= 1),

  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT reward_programs_reward_scope
    CHECK (reward_covers_all_services OR cardinality(reward_covers_service_ids) > 0)
);

CREATE INDEX IF NOT EXISTS reward_programs_account_idx
  ON public.reward_programs (account_id, sort_order, created_at)
  WHERE archived_at IS NULL;

-- The sweep's one query.
CREATE INDEX IF NOT EXISTS reward_programs_active_idx
  ON public.reward_programs (account_id)
  WHERE active AND archived_at IS NULL;

ALTER TABLE public.reward_programs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.reward_programs IS
  'Rewards: pass credits earned by activity. Earned rewards are passes (source reward, source_ref reward:<programme>:<person>); each milestone is one allocation (source_ref milestone:<n>). Progress is recounted from activity, never stored.';

NOTIFY pgrst, 'reload schema';
