-- A Practice Block Preset is a coach's own saved template: the title and
-- content of a block they assign often, kept so the next assignment is one
-- click instead of retyping. Account-scoped, not player-scoped -- a preset is
-- the coach's phrasing, not anybody's prescription.
--
-- Deliberately NOT a flag on practice_blocks. A preset has no player, no
-- expiry, no status and no lifecycle; folding it into that table would mean a
-- nullable player_id and a status the expiry sweep has to keep skipping.
--
-- The composer's other half -- "used often" suggestions -- has no table at
-- all. Those are derived on read from practice_blocks itself (most-assigned
-- titles across the account), so they cannot go stale against what the coach
-- has actually been assigning.
--
-- Service-role only, like every other table here: RLS on, no client policy.

CREATE TABLE IF NOT EXISTS public.practice_block_presets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,

  title TEXT NOT NULL,
  content TEXT NOT NULL,

  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The only read: "this account's presets, newest first."
CREATE INDEX IF NOT EXISTS practice_block_presets_account_idx
  ON public.practice_block_presets (account_id, created_at DESC);

-- Saving a preset whose title already exists overwrites that preset's content
-- rather than adding a near-duplicate beside it -- the coach means "this is
-- what that preset says now." Case-insensitive so "Start Line" and "start
-- line" are one preset, which is what a coach glancing at the list assumes.
CREATE UNIQUE INDEX IF NOT EXISTS practice_block_presets_title_key
  ON public.practice_block_presets (account_id, lower(title));

ALTER TABLE public.practice_block_presets ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.practice_block_presets IS
  'Coach-saved practice block templates (title + content), account-scoped. Hard-deletable: a preset is a convenience, not history -- the blocks assigned from it are the record. Service-role only; RLS enabled with no client policy by design.';

NOTIFY pgrst, 'reload schema';
