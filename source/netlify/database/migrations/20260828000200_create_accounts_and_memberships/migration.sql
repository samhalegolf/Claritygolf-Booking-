-- Migration A: Tenancy backbone — accounts and account_memberships
--
-- Supabase Auth proves identity (auth.users). These tables decide
-- authorization: an auth user must have an active account_memberships row to
-- act on behalf of a business. No membership = no access. Role/account are
-- deliberately NOT read from Supabase user_metadata, which the user can
-- influence; the membership row is the only authority.
--
-- The original workspace is seeded here so existing production data stays
-- attached to it. Its id is taken from the data itself (the account_id already
-- stamped on the most calendar rows) rather than from a settings string that
-- may have been edited since, falling back to settings and finally to the
-- well-known legacy id.

create table if not exists public.accounts (
  id text primary key,
  slug text not null unique,
  business_name text not null,
  status text not null default 'active' check (status = any (array['active'::text, 'suspended'::text, 'closed'::text])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.account_memberships (
  id text primary key,
  account_id text not null references public.accounts(id) on delete cascade,
  auth_user_id uuid not null,
  role text not null check (role = any (array['owner'::text, 'admin'::text, 'coach'::text])),
  coach_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One membership row per (business, user). Role changes update in place.
create unique index if not exists idx_account_memberships_account_auth_user
  on public.account_memberships (account_id, auth_user_id);

-- The hot path: resolve an authenticated user's membership on every request.
create index if not exists idx_account_memberships_auth_user
  on public.account_memberships (auth_user_id, active);

create index if not exists idx_account_memberships_account
  on public.account_memberships (account_id, active);

-- Seed the original workspace.
insert into public.accounts (id, slug, business_name, status)
select
  original.id,
  original.id as slug,
  coalesce(
    nullif((select value from public.settings where key = 'accountBusinessName' limit 1), ''),
    nullif((select value from public.settings where key = 'coachName' limit 1), ''),
    'Sam Hale Golf'
  ) as business_name,
  'active'
from (
  select coalesce(
    (
      select ci.account_id
      from public.calendar_items ci
      where ci.account_id is not null and btrim(ci.account_id) <> ''
      group by ci.account_id
      order by count(*) desc, ci.account_id asc
      limit 1
    ),
    nullif((select value from public.settings where key = 'accountCalendarSlug' limit 1), ''),
    nullif((select value from public.settings where key = 'accountId' limit 1), ''),
    'sam-hale-golf'
  ) as id
) as original
on conflict (id) do nothing;

notify pgrst, 'reload schema';
