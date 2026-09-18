-- A swing review, addressed to the player as one thing.
--
-- Until now a review had no record anywhere. It is a lesson id --
-- `swing-review-<ms>` -- stamped onto every part the coach touches in one
-- sitting, and both ends re-gather the parts wearing it (playerSwingReviewGroups
-- on the coach's side, groupSwingReviews on the player's). That is still true,
-- and this table does not change it: a share is not the review, it is one act
-- of sending the review somewhere.
--
-- Why the review needs a record at all when its parts do not:
--
--   * A link that works without a login has to be a row. The token is the whole
--     credential, so it must be revocable, expiring and countable, and none of
--     those can be derived from the parts.
--   * "Has this review been sent, and when, and to whom" is a question about
--     the review, not about any one video in it. A coach who sent three angles
--     sent one review.
--
-- The token is stored hashed, never raw, exactly as video_transfer_sessions
-- stores coach_view_token_hash. The raw token lives only long enough to reach
-- the email.

CREATE TABLE IF NOT EXISTS public.swing_review_shares (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  portal_player_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  recipient_email TEXT NOT NULL DEFAULT '',
  coach_message TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  first_opened_at TIMESTAMPTZ,
  last_opened_at TIMESTAMPTZ,
  open_count INTEGER NOT NULL DEFAULT 0
);

-- The lookup the public page does on every request, and the uniqueness that
-- makes a token address exactly one review.
CREATE UNIQUE INDEX IF NOT EXISTS swing_review_shares_token_hash_idx
  ON public.swing_review_shares (token_hash);

-- "Has this review been sent?" -- the question the coach's button asks before
-- it decides whether it is sending or re-sending.
CREATE INDEX IF NOT EXISTS swing_review_shares_review_idx
  ON public.swing_review_shares (account_id, lesson_id, created_at DESC);

COMMENT ON TABLE public.swing_review_shares IS
  'One act of sending a swing review to the player it is about. The review itself is still just a lesson id stamped on its parts.';

COMMENT ON COLUMN public.swing_review_shares.token_hash IS
  'sha256 of the link token. The raw token is never stored -- it exists only between minting and the email.';

COMMENT ON COLUMN public.swing_review_shares.portal_player_id IS
  'portal_players.id the review was addressed to, resolved server-side from the coach session. A review is only ever sent to someone who also has a portal to keep it in.';

-- One review, one email.
--
-- Every video in a review is returned to the player as its own coach-return,
-- and deliverCoachReturn emails the player about each one. That is right for a
-- single video sent from the Videos tab and wrong for a review: a coach who
-- sent three angles would send three "your coach sent you a video" emails, and
-- then the review email on top.
--
-- So the review send asks for the per-video emails to be held, and sends one
-- email naming the whole review instead. A column rather than inferring it from
-- the lesson id, because a coach sending one review video by itself from the
-- Videos tab still deserves the per-video email.
ALTER TABLE public.video_transfer_sessions
  ADD COLUMN IF NOT EXISTS suppress_return_email BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.video_transfer_sessions.suppress_return_email IS
  'Set when this return is part of a swing review send, which sends one email for the whole review. returnedAt is still stamped -- the video is delivered, it is just not announced on its own.';

NOTIFY pgrst, 'reload schema';
