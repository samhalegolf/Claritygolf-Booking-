-- A person with no account who has sent the coach a video.
--
-- Deliberately NOT a player_sessions row with a null portal_player_id. That
-- table's readers resolve a player's bookings and lesson notes from the
-- session's *email string* (readPlayerProfile -> readPublicAppointmentsForContact
-- and playerProfileIdCandidates, booking-core.mts), and readPlayerSession only
-- checks portal_player_id when one is set. A guest row there would hand anyone
-- who typed someone else's address that person's real lessons on the first
-- /api/player/profile call. Every existing caller assumes "has a player session
-- => is a real player"; sharing the table makes each of them a vulnerability by
-- omission. A separate table with its own token and its own request header is
-- fail-closed: code that does not know guests exist cannot authenticate one.
--
-- account_id is the recipient seam. Today it is always the single workspace
-- account (resolveWorkspaceAccount, booking-core.mts). It is a column rather
-- than a constant so multi-coach later is a migration, not a rewrite.
--
-- Service-role only, like every other table here: RLS on, no client policy.

CREATE TABLE IF NOT EXISTS public.guest_senders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  -- Soft signal only. localStorage-backed and trivially rotated, so it is
  -- recorded for support and never used as a limit anchor.
  source_device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Claim bookkeeping. Set when the coach presses "Add as player".
  claimed_person_id TEXT,
  claimed_portal_player_id TEXT,
  claimed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS guest_senders_token_idx
  ON public.guest_senders (token_hash);

CREATE INDEX IF NOT EXISTS guest_senders_account_created_idx
  ON public.guest_senders (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS guest_senders_account_email_idx
  ON public.guest_senders (account_id, lower(email));

CREATE INDEX IF NOT EXISTS guest_senders_unclaimed_idx
  ON public.guest_senders (account_id, created_at DESC)
  WHERE claimed_at IS NULL;

ALTER TABLE public.guest_senders ENABLE ROW LEVEL SECURITY;

-- There is deliberately no unique index on (account_id, lower(email)). It
-- matches 20260714000200_allow_shared_client_emails -- two people share an
-- inbox -- and de-duping here would let anyone inherit an existing guest's
-- row, their remaining quota and their pending videos by retyping that
-- address.

COMMENT ON TABLE public.guest_senders IS
  'Accountless senders of coach-bound videos. Holds no login: the token authorises upload and status only, never profile reads. Service-role only; RLS enabled with no client policy by design.';

COMMENT ON COLUMN public.guest_senders.account_id IS
  'Recipient coach. Single-workspace today; a column so multi-coach is a migration.';

COMMENT ON COLUMN public.guest_senders.claimed_at IS
  'Set when the coach adds this guest as a player. Their submissions stop being ephemeral at that moment.';

NOTIFY pgrst, 'reload schema';
