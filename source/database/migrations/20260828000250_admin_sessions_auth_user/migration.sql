-- Coach sessions must resolve back to a Supabase Auth identity.
--
-- admin_sessions stays as the app-issued HttpOnly session store (the calendar
-- UI depends on the clarity_session cookie), but it is no longer the authority
-- on who the user is. It now records the Supabase auth.users id that proved the
-- password, and requireCoachActor() resolves that id through
-- account_memberships to get the account. The legacy user_id column remains for
-- the transition so existing sessions keep working until they expire.

alter table public.admin_sessions add column if not exists auth_user_id uuid;

create index if not exists idx_admin_sessions_auth_user
  on public.admin_sessions (auth_user_id);

notify pgrst, 'reload schema';
