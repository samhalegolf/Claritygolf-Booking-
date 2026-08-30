-- Player sessions are now minted after a Supabase Auth password login instead
-- of an email + phone match. Recording which auth user the session belongs to
-- lets a session be revoked when portal access is revoked, and keeps the
-- session row meaningful without re-reading portal_players on every request.
--
-- The email + phone login route is removed in the same change. A phone number
-- is not a credential for a surface that holds lesson notes and video.

ALTER TABLE public.player_sessions
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS portal_player_id TEXT;

CREATE INDEX IF NOT EXISTS idx_player_sessions_auth_user
  ON public.player_sessions (auth_user_id);

CREATE INDEX IF NOT EXISTS idx_player_sessions_portal_player
  ON public.player_sessions (portal_player_id);

-- Phone is no longer collected at login. Existing rows keep their value; new
-- rows written by the Supabase Auth path leave it empty.
ALTER TABLE public.player_sessions
  ALTER COLUMN phone DROP NOT NULL;

COMMENT ON COLUMN public.player_sessions.auth_user_id IS
  'auth.users.id of the Supabase Auth user this session was minted for.';

NOTIFY pgrst, 'reload schema';
