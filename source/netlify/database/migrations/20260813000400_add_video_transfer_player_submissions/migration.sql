-- Player-to-coach video submissions reuse the existing Clarity Cloud transfer
-- engine rather than getting a parallel one: same resumable Drive sessions,
-- same checksum verification, same manifests, same import path on the coach
-- side. `direction` is the only thing that distinguishes them.
--
-- 'coach-device'     -- the original flow: coach's device to coach's Drive to
--                       coach's other device.
-- 'player-submission'-- a portal player sending a video to the coach. The
--                       upload is authorised by a player session, but the
--                       Drive account is always the coach's, reached with the
--                       service role. The player never touches Google.

ALTER TABLE public.video_transfer_sessions
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'coach-device',
  ADD COLUMN IF NOT EXISTS submitted_by_portal_player_id TEXT,
  ADD COLUMN IF NOT EXISTS submitted_by_name TEXT,
  ADD COLUMN IF NOT EXISTS player_message TEXT,
  ADD COLUMN IF NOT EXISTS coach_seen_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_transfer_sessions_direction_check'
  ) THEN
    ALTER TABLE public.video_transfer_sessions
      ADD CONSTRAINT video_transfer_sessions_direction_check
      CHECK (direction IN ('coach-device', 'player-submission'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS video_transfer_sessions_player_submissions_idx
  ON public.video_transfer_sessions (account_id, created_at DESC)
  WHERE direction = 'player-submission';

CREATE INDEX IF NOT EXISTS video_transfer_sessions_unseen_submissions_idx
  ON public.video_transfer_sessions (account_id, player_id)
  WHERE direction = 'player-submission' AND coach_seen_at IS NULL;

COMMENT ON COLUMN public.video_transfer_sessions.direction IS
  'coach-device = coach library sync. player-submission = portal player sending a video to the coach.';

COMMENT ON COLUMN public.video_transfer_sessions.coach_seen_at IS
  'Set the first time the coach opens a player submission. NULL means unseen.';

NOTIFY pgrst, 'reload schema';
