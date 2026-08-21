-- 'guest-submission' -- someone with no account sending the coach a video.
--
-- Same transfer engine as the other two directions: same resumable Drive
-- sessions, same checksum verification, same manifests, same catalogue. What
-- differs:
--   * authorised by a guest_senders token, never a player session
--   * ownership is guest_sender_id, never email/phone candidate matching --
--     a guest picks their own email, so every candidate form is guessable
--   * carries its own no-login coach view token, emailed with the notification
--   * ephemeral until claimed: cleanup_after is set at finalize, and the
--     purge job deletes the Drive folder once it passes

ALTER TABLE public.video_transfer_sessions
  ADD COLUMN IF NOT EXISTS guest_sender_id TEXT,
  ADD COLUMN IF NOT EXISTS submitted_by_email TEXT,
  ADD COLUMN IF NOT EXISTS coach_view_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS coach_view_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- 20260813000400 added this constraint under an "IF NOT EXISTS" guard, so it
-- will not re-create itself with the new value. Drop and re-add.
ALTER TABLE public.video_transfer_sessions
  DROP CONSTRAINT IF EXISTS video_transfer_sessions_direction_check;

ALTER TABLE public.video_transfer_sessions
  ADD CONSTRAINT video_transfer_sessions_direction_check
  CHECK (direction IN ('coach-device', 'player-submission', 'guest-submission'));

CREATE INDEX IF NOT EXISTS video_transfer_sessions_guest_sender_idx
  ON public.video_transfer_sessions (account_id, guest_sender_id, created_at DESC)
  WHERE direction = 'guest-submission';

CREATE INDEX IF NOT EXISTS video_transfer_sessions_coach_view_token_idx
  ON public.video_transfer_sessions (coach_view_token_hash)
  WHERE coach_view_token_hash IS NOT NULL;

-- The purge job's only query. Strictly scoped: guest, unclaimed, due. It must
-- never widen -- cleanup_after is also written by handleImportReceipt for
-- coach-device rows the coach has already imported, and sweeping those would
-- delete the coach's own videos out of their Drive.
CREATE INDEX IF NOT EXISTS video_transfer_sessions_guest_purge_idx
  ON public.video_transfer_sessions (cleanup_after)
  WHERE direction = 'guest-submission' AND claimed_at IS NULL;

COMMENT ON COLUMN public.video_transfer_sessions.direction IS
  'coach-device = coach library sync. player-submission = portal player sending a video to the coach. guest-submission = someone with no account sending one.';

COMMENT ON COLUMN public.video_transfer_sessions.guest_sender_id IS
  'guest_senders.id. The only ownership check for a guest submission.';

COMMENT ON COLUMN public.video_transfer_sessions.claimed_at IS
  'Set when the coach adds this guest as a player. A claimed submission is no longer ephemeral: cleanup_after is cleared and the purge job ignores it.';

COMMENT ON COLUMN public.video_transfer_sessions.coach_view_token_hash IS
  'sha256 of the no-login coach view token emailed with the submission. The raw token is never stored, and the purge job nulls this so the link dies with the bytes.';

NOTIFY pgrst, 'reload schema';
