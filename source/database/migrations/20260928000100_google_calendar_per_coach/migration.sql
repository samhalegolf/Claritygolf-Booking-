-- Google Calendar, per coach.
--
-- Until now a business had one Google connection, and every coach's lessons
-- went into that one calendar. Each coach now connects their own Google
-- Calendar from their coach profile, and their calendar carries only their
-- own lessons, blocks and unavailable hours.
--
-- google_provider_connections gains coach_id:
--   ''        the business's own connection — Google Drive, for lesson video.
--   <coach>   that coach's own Google Calendar.
--
-- Existing calendar connections were made by the business owner for their own
-- diary, so they move to the owner's coach profile: the coach id on the
-- owner's membership, or the account id (the id of the coach seeded with the
-- business) when the membership names none. That is the same rule as
-- ownCoachIdFor in booking-core.mts. Nobody has to reconnect.
--
-- The per-business calendar settings (event maps, chosen calendar, import
-- rules, sync status) move with the connection, to keys suffixed ":<coachId>".

alter table public.google_provider_connections
  add column if not exists coach_id text not null default '';

-- One connection per business becomes one per (business, coach), and the
-- business's own (Drive) row is coach ''.
drop index if exists public.idx_google_provider_connections_account_provider;
create unique index if not exists idx_google_provider_connections_account_provider_coach
  on public.google_provider_connections (account_id, provider, coach_id);

create temporary table google_calendar_owner_coach on commit drop as
select
  accounts.account_id,
  coalesce(
    (
      select nullif(m.coach_id, '')
      from public.account_memberships m
      where m.account_id = accounts.account_id and m.role = 'owner' and m.active
      order by m.created_at
      limit 1
    ),
    accounts.account_id
  ) as coach_id
from (
  select account_id from public.google_provider_connections
  union
  select account_id from public.settings where key like 'googleCalendar%'
) accounts;

-- A connection that also carried Drive keeps Drive on the business row and
-- hands the calendar to a new coach row with the same grant.
insert into public.google_provider_connections (
  id, account_id, provider, coach_id, provider_user_id, provider_email,
  encrypted_refresh_token_json, encrypted_refresh_token_version, granted_scopes_json,
  calendar_enabled, drive_enabled, connection_status, connected_at, updated_at,
  last_token_refresh_at, last_successful_use_at, revoked_at, last_error_code, last_error_at
)
select
  gen_random_uuid()::text, g.account_id, g.provider, o.coach_id, g.provider_user_id, g.provider_email,
  g.encrypted_refresh_token_json, g.encrypted_refresh_token_version, g.granted_scopes_json,
  true, false, g.connection_status, g.connected_at, now(),
  g.last_token_refresh_at, g.last_successful_use_at, g.revoked_at, g.last_error_code, g.last_error_at
from public.google_provider_connections g
join google_calendar_owner_coach o on o.account_id = g.account_id
where g.coach_id = '' and g.calendar_enabled and g.drive_enabled;

update public.google_provider_connections
set calendar_enabled = false, updated_at = now()
where coach_id = '' and calendar_enabled and drive_enabled;

-- A calendar-only connection simply becomes the owner's.
update public.google_provider_connections g
set coach_id = o.coach_id, updated_at = now()
from google_calendar_owner_coach o
where o.account_id = g.account_id and g.coach_id = '' and not g.drive_enabled;

-- Settings that belong to a coach's calendar move to that coach's keys.
insert into public.settings (account_id, key, value, updated_at)
select s.account_id, s.key || ':' || o.coach_id, s.value, now()
from public.settings s
join google_calendar_owner_coach o on o.account_id = s.account_id
where s.key in (
  'googleCalendarId',
  'googleCalendarEventMapJson',
  'googleCalendarEventHashMapJson',
  'googleCalendarAutoSync',
  'googleCalendarImportRulesJson',
  'googleCalendarImportBusy',
  'googleCalendarLastSyncAt',
  'googleCalendarLastSyncStatus',
  'googleCalendarLastSyncError',
  'googleCalendarAccountEmail',
  'googleCalendarConnectedAt'
)
on conflict (account_id, key) do nothing;

-- The old per-business keys, plus ones nothing reads any more: the in-flight
-- OAuth state (now per coach), the account id it duplicated, and the
-- pre-encryption refresh token, which is empty everywhere.
delete from public.settings
where key in (
  'googleCalendarId',
  'googleCalendarEventMapJson',
  'googleCalendarEventHashMapJson',
  'googleCalendarAutoSync',
  'googleCalendarImportRulesJson',
  'googleCalendarImportBusy',
  'googleCalendarLastSyncAt',
  'googleCalendarLastSyncStatus',
  'googleCalendarLastSyncError',
  'googleCalendarAccountEmail',
  'googleCalendarConnectedAt',
  'googleCalendarOAuthState',
  'googleCalendarOAuthAccountId',
  'googleCalendarOAuthStartedAt',
  'googleCalendarRefreshToken'
);

-- The nightly reconcile used to pass its trigger name as the business id, so
-- it logged under a business called "scheduled_reconcile". Not a business.
delete from public.settings where account_id = 'scheduled_reconcile';

notify pgrst, 'reload schema';
