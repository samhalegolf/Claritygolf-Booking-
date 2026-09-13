-- 'coach-return' -- the coach sending an annotated video back to a player.
--
-- The fourth direction on the same engine. Everything structural is already
-- there: resumable Drive sessions, checksums, manifests, and a player route
-- that lists whatever is filed under the player's own id. What a return adds
-- is intent and a way back.
--
-- Why it is not just a 'coach-device' row filed under the player:
--
--   * A coach-device transfer is the coach's library syncing between their own
--     devices. It happens constantly and means nothing to the player. Emailing
--     them about each one, or dotting each one unread, would be noise.
--   * handleImportReceipt schedules cleanup_after on a coach-device row once
--     the coach's own device has taken custody. A return is not the coach's to
--     retire -- the player may not have downloaded it yet.
--   * The player needs to be able to mark one seen. Nothing else on the player
--     route may be written by a player, so "which rows may they touch" has to
--     be answerable from the direction alone.
--
-- The columns mirror the player-submission ones rather than inventing a second
-- vocabulary: player_message/coach_seen_at going one way, coach_message/
-- player_seen_at coming back.

ALTER TABLE public.video_transfer_sessions
  ADD COLUMN IF NOT EXISTS coach_message TEXT,
  ADD COLUMN IF NOT EXISTS player_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS returned_to_portal_player_id TEXT,
  ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;

-- Both earlier migrations guarded this with IF NOT EXISTS / DROP, so it will
-- not re-create itself with the new value. Drop and re-add, as 20260821000200
-- did for 'guest-submission'.
ALTER TABLE public.video_transfer_sessions
  DROP CONSTRAINT IF EXISTS video_transfer_sessions_direction_check;

ALTER TABLE public.video_transfer_sessions
  ADD CONSTRAINT video_transfer_sessions_direction_check
  CHECK (direction IN ('coach-device', 'player-submission', 'guest-submission', 'coach-return'));

-- The portal's unread dot. Narrow on purpose: one player, unseen only.
CREATE INDEX IF NOT EXISTS video_transfer_sessions_unseen_returns_idx
  ON public.video_transfer_sessions (account_id, player_id)
  WHERE direction = 'coach-return' AND player_seen_at IS NULL;

CREATE INDEX IF NOT EXISTS video_transfer_sessions_coach_returns_idx
  ON public.video_transfer_sessions (account_id, returned_to_portal_player_id, created_at DESC)
  WHERE direction = 'coach-return';

COMMENT ON COLUMN public.video_transfer_sessions.direction IS
  'coach-device = coach library sync. player-submission = portal player sending a video to the coach. guest-submission = someone with no account doing the same. coach-return = the coach sending an annotated video back to a player.';

COMMENT ON COLUMN public.video_transfer_sessions.coach_message IS
  'The note the coach sent with a returned video. Mirror of player_message.';

COMMENT ON COLUMN public.video_transfer_sessions.player_seen_at IS
  'Set the first time the player opens a returned video. NULL means unseen. Mirror of coach_seen_at.';

COMMENT ON COLUMN public.video_transfer_sessions.returned_to_portal_player_id IS
  'portal_players.id the return was addressed to, resolved server-side from the coach session. A return is only ever issued to a person who already has portal access.';

NOTIFY pgrst, 'reload schema';
