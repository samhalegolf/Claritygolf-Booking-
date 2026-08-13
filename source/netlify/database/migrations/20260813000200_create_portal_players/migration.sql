-- Portal players. A person becomes a portal user only when the coach promotes
-- them in Player Profiles -- this is deliberately not every row in `people`.
--
-- The credential lives in Supabase Auth (auth.users), which Clarity Caddy
-- already uses, so a player who has a Caddy account signs in to both products
-- with the same email and password. This table is the link between that auth
-- user and the booking app's `people` row, and it is the only thing that makes
-- a Supabase Auth user a valid portal login for this account.
--
-- Service-role only, like every other table in this app: the browser never
-- talks to Postgres directly, so RLS is enabled with no client policy.

CREATE TABLE IF NOT EXISTS public.portal_players (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  auth_user_id UUID NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited',
  -- The set-password invite is ours, not GoTrue's. Supabase's own invite link
  -- bounces through a redirect that hands the browser a Supabase session, and
  -- this app deliberately never gives the browser one. Issuing our own token
  -- keeps the flow identical in shape to the existing admin password reset.
  invite_token_hash TEXT,
  invite_expires_at TIMESTAMPTZ,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT portal_players_status_check
    CHECK (status IN ('invited', 'active', 'disabled'))
);

-- One portal login per person per account, and one person per auth user.
CREATE UNIQUE INDEX IF NOT EXISTS portal_players_account_person_idx
  ON public.portal_players (account_id, person_id);

CREATE UNIQUE INDEX IF NOT EXISTS portal_players_auth_user_idx
  ON public.portal_players (auth_user_id);

CREATE INDEX IF NOT EXISTS portal_players_account_status_idx
  ON public.portal_players (account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS portal_players_invite_token_idx
  ON public.portal_players (invite_token_hash);

CREATE INDEX IF NOT EXISTS portal_players_email_idx
  ON public.portal_players (lower(email));

ALTER TABLE public.portal_players ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.portal_players IS
  'Coach-granted portal access. Links a Supabase Auth user to a people row. Service-role only; RLS is enabled with no client policy by design.';

NOTIFY pgrst, 'reload schema';
