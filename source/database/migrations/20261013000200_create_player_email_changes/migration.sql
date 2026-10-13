-- A player changing the email they sign in with.
--
-- The email is the shared Clarity Booking + Clarity Caddy login, so a change
-- only happens once the new address has proved it can receive mail: the player
-- asks from the Account tab, a link goes to the new address, and nothing moves
-- until that link is used. A row is the request; confirmed_at says it went
-- through, and old_email keeps the history.

CREATE TABLE IF NOT EXISTS public.player_email_changes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  portal_player_id TEXT,
  auth_user_id UUID NOT NULL,
  old_email TEXT NOT NULL,
  new_email TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS player_email_changes_auth_user_idx
  ON public.player_email_changes (auth_user_id, created_at DESC);

-- Server-only, like player_sessions: the app reaches it with the service role.
ALTER TABLE public.player_email_changes ENABLE ROW LEVEL SECURITY;
