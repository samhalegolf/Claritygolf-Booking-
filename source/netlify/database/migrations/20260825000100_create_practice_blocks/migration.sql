-- A Practice Block is a coach-authored practice prescription assigned
-- directly to a player: a title, the prescription itself, and an optional
-- expiry the coach doesn't have to think about (resolved once at assignment
-- time, then frozen -- see expiry_date below).
--
-- Replaces the category/subcategory "Practice" feature (settings-blob keys
-- practiceCategories.v1.*/practiceBlocks.v1.* in booking-core.mts) wholesale.
-- That feature has zero production rows, so this is a clean swap, not a
-- migration of data -- the old settings rows are left in place, inert.
--
-- A real table, not a settings blob, because this needs indexed per-player
-- lookups (the player portal reads it on every profile load) and a status
-- that transitions server-side (active -> completed/expired/archived) rather
-- than being read-and-rewritten as one JSON document each time.
--
-- Service-role only, like every other table here: RLS on, no client policy.

CREATE TABLE IF NOT EXISTS public.practice_blocks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL DEFAULT '',

  title TEXT NOT NULL,
  content TEXT NOT NULL,

  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  expiry_type TEXT NOT NULL DEFAULT 'none'
    CHECK (expiry_type IN ('next_lesson', 'set_date', 'none')),
  -- Resolved once, at assignment time, and never re-resolved. For
  -- next_lesson this is the player's next future booking's start time at the
  -- moment the block was saved; a later reschedule of that booking must not
  -- silently move this block's expiry. NULL when expiry_type = 'none', or
  -- when next_lesson was picked but the player had no upcoming booking (the
  -- assignment falls back to no expiry -- see the create route below).
  expiry_date TIMESTAMPTZ,
  -- The calendar_items row expiry_date was resolved from, kept only so a
  -- support/debug read can explain *why* a block expired when it did. Not
  -- used by any read path -- expiry_date alone drives expiry.
  resolved_from_calendar_item_id TEXT,

  -- video_transfer_sessions.saved_video_id. No FK: that table's rows are
  -- retained/removed on their own lifecycle, and a Practice Block must keep
  -- working even if the video it once pointed at is gone.
  linked_video_id TEXT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'expired', 'archived')),
  completed_at TIMESTAMPTZ,

  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- History: "all blocks for player X, newest first."
CREATE INDEX IF NOT EXISTS practice_blocks_player_history_idx
  ON public.practice_blocks (account_id, player_id, created_at DESC);

-- "Active blocks for player X" -- the common-case read on both the coach's
-- player profile tool and the player portal's Practice tab.
CREATE INDEX IF NOT EXISTS practice_blocks_player_active_idx
  ON public.practice_blocks (account_id, player_id)
  WHERE status = 'active';

-- Feeds the lazy expiry sweep: "every active block in this account whose
-- expiry has passed," scanned on every read before status filtering happens.
CREATE INDEX IF NOT EXISTS practice_blocks_expiry_sweep_idx
  ON public.practice_blocks (account_id, expiry_date)
  WHERE status = 'active' AND expiry_date IS NOT NULL;

ALTER TABLE public.practice_blocks ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.practice_blocks IS
  'Coach-assigned practice prescriptions, one per player. Replaces the old category/subcategory practice feature entirely. Service-role only; RLS enabled with no client policy by design.';

COMMENT ON COLUMN public.practice_blocks.expiry_date IS
  'Resolved once at assignment time (frozen), never re-derived from the player''s current bookings. NULL means no expiry.';

COMMENT ON COLUMN public.practice_blocks.status IS
  'active -> completed (player action) or expired (lazy, on read, when expiry_date has passed) or archived (coach removal, soft-delete only -- history is never hard-deleted).';

NOTIFY pgrst, 'reload schema';
