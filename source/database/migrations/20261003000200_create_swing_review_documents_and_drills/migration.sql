-- A swing review gets a page of its own, and coaches get a drill library.
--
-- Until now a review was only a lesson id -- `swing-review-<ms>` -- stamped on
-- every video and note from one sitting and re-gathered at both ends. That
-- still holds for the parts: videos keep their lesson id, practice still hangs
-- off its videos. What it could never hold is an *order*, or anything that is
-- not one of those parts: a link, a drill, a note written into the page rather
-- than into the lesson notes. So the review now has a document: an ordered
-- list of blocks the coach lays out like the finished thing, the way the
-- invoice and email templates are edited on the sheet itself.
--
-- A video block points at a saved video by id; it does not copy it. The bytes,
-- the snapshots and the timestamped notes stay on the video, where the
-- analysis workspace already keeps them.
--
-- Service-role only, like every other table here: RLS on, no client policy.

CREATE TABLE IF NOT EXISTS public.swing_review_documents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- The `swing-review-<ms>` id stamped on the review's videos and notes.
  lesson_id TEXT NOT NULL,
  -- people.id of the player the review is about.
  player_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  -- Ordered blocks: video, note, link, drill. Shape is owned by
  -- netlify/functions/_shared/review-document.mts, which cleans every write.
  blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT NOT NULL DEFAULT '',
  -- Stamped by the review send. A player only ever sees a document that has
  -- been sent; until then it is the coach's working page.
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT swing_review_documents_lesson_key UNIQUE (account_id, lesson_id)
);

-- The coach's Reviews tab and the player's portal both read "this player's
-- reviews".
CREATE INDEX IF NOT EXISTS swing_review_documents_player_idx
  ON public.swing_review_documents (account_id, player_id, updated_at DESC);

ALTER TABLE public.swing_review_documents ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.swing_review_documents IS
  'The laid-out page of a swing review: an ordered list of video, note, link and drill blocks. Videos are referenced by saved video id, never copied. Service-role only.';

-- A drill or exercise a coach keeps to drop into reviews: a video (YouTube or
-- their own upload) and notes. Shared with every coach in the business so the
-- team can use each other's drills; only the coach who made one may change or
-- delete it. Dropping a drill into a review copies it into the review, so the
-- copy can be snapshotted and re-worded without touching the original.
CREATE TABLE IF NOT EXISTS public.coach_drills (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- Supabase auth user id of the coach who made it. The only one who may edit.
  created_by TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  -- A YouTube drill: the video id plus the part of it that matters.
  youtube_id TEXT NOT NULL DEFAULT '',
  start_seconds NUMERIC NOT NULL DEFAULT 0,
  end_seconds NUMERIC,
  -- A drill with its own video: the saved video (in Clarity Cloud) it lives in.
  saved_video_id TEXT NOT NULL DEFAULT '',
  thumbnail_data_url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS coach_drills_account_idx
  ON public.coach_drills (account_id, lower(title));

ALTER TABLE public.coach_drills ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.coach_drills IS
  'Drill and exercise library. Business-wide to read, author-only to change. Dropped into a review as a copy. Service-role only.';

NOTIFY pgrst, 'reload schema';
