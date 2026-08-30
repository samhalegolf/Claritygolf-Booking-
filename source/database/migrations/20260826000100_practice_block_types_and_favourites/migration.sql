-- The Practice Block Builder, on top of the two tables from 20260825.
--
-- Three things the original pair could not hold:
--
--   block_type  -- the five kinds a block can be (drill / skill test / game /
--                  routine / custom). A label and a colour, not a rule: it
--                  changes nothing about how a block behaves, so an
--                  unrecognised value reads back as 'custom' rather than
--                  failing a check constraint on an older row.
--   dose        -- "20 balls", "10 min", "9 holes". The one number a coach
--                  says out loud with the drill, kept out of the prose so it
--                  can be shown beside a title without parsing the content.
--   sort_order  -- the favourites rail is hand-ordered by drag. That order is
--                  a decision the coach made, not a side effect of when they
--                  happened to save each one, so it is stored.
--
-- Steps deliberately get NO column. A block's body is still `content`, and a
-- step is a line of it -- so the player portal, the suggestion grouping and
-- every already-assigned block keep working unchanged, and there is no second
-- representation of the same text to drift.
--
-- Additive only: every column has a default, so rows written before this
-- migration are valid the moment it lands.

ALTER TABLE public.practice_blocks
  ADD COLUMN IF NOT EXISTS block_type TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE public.practice_blocks
  ADD COLUMN IF NOT EXISTS dose TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN public.practice_blocks.block_type IS
  'drill | skill | game | routine | custom. Presentation only -- carried through the composer tab, the rail tile and the brick on the wall. No CHECK: an unknown value degrades to custom on read rather than rejecting the row.';

COMMENT ON COLUMN public.practice_blocks.dose IS
  'The block''s one quantity ("20 balls", "10 min"), shown beside the title. Free text; empty when the coach did not give one.';

ALTER TABLE public.practice_block_presets
  ADD COLUMN IF NOT EXISTS block_type TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE public.practice_block_presets
  ADD COLUMN IF NOT EXISTS dose TEXT NOT NULL DEFAULT '';
ALTER TABLE public.practice_block_presets
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.practice_block_presets.sort_order IS
  'Hand-ordered by drag in the favourites rail, ascending. A new favourite claims 0 and pushes the rest down, so it lands at the top where the coach is looking. Ties break on created_at DESC.';

-- The rail's only read is "this account's favourites, in rail order", so the
-- account+created_at index from 20260825 is replaced by one that leads with
-- sort_order.
DROP INDEX IF EXISTS public.practice_block_presets_account_idx;
CREATE INDEX IF NOT EXISTS practice_block_presets_account_idx
  ON public.practice_block_presets (account_id, sort_order, created_at DESC);

NOTIFY pgrst, 'reload schema';
