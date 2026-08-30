-- Migration C: Strict calendar + people ownership
--
-- calendar_items and people both carry account_id already, but the column was
-- nullable and production still has DEFAULT 'sam-hale-golf' on calendar_items,
-- so a write that lost its tenant was silently stamped into the original
-- business. After this migration:
--
--   * account_id is NOT NULL with no default on both tables.
--   * A write missing the owner fails loudly instead of joining Sam Hale Golf.
--   * Legacy NULL rows are backfilled once, here, rather than being assigned
--     dynamically by whichever account happens to be reading them.
--
-- notification_history is promoted the same way: it had no account column at
-- all and was leaning on a calendar-item join as its tenant boundary.

-- calendar_items -----------------------------------------------------------

update public.calendar_items
set account_id = coalesce(
  (select id from public.accounts order by created_at asc, id asc limit 1),
  'sam-hale-golf'
)
where account_id is null or btrim(account_id) = '';

alter table public.calendar_items alter column account_id drop default;
alter table public.calendar_items alter column account_id set not null;

-- people ------------------------------------------------------------------

update public.people
set account_id = coalesce(
  (select id from public.accounts order by created_at asc, id asc limit 1),
  'sam-hale-golf'
)
where account_id is null or btrim(account_id) = '';

alter table public.people alter column account_id drop default;
alter table public.people alter column account_id set not null;

-- notification_history ----------------------------------------------------
--
-- Rows that can be traced to a calendar item inherit that item's owner; the
-- rest go to the original workspace, which is where they were raised.

alter table public.notification_history add column if not exists account_id text;

update public.notification_history nh
set account_id = ci.account_id
from public.calendar_items ci
where ci.id = nh.calendar_item_id
  and (nh.account_id is null or btrim(nh.account_id) = '')
  and ci.account_id is not null;

update public.notification_history
set account_id = coalesce(
  (select id from public.accounts order by created_at asc, id asc limit 1),
  'sam-hale-golf'
)
where account_id is null or btrim(account_id) = '';

alter table public.notification_history alter column account_id set not null;

create index if not exists idx_notification_history_account
  on public.notification_history (account_id, created_at desc);

-- Cross-account uniqueness audit ------------------------------------------
--
-- people already has idx_people_account_email_unique (account_id, lower(email))
-- from 20260704000100, and the globally-unique idx_people_email_unique was
-- dropped there. Two businesses can each hold the same client email, which is
-- the behaviour the boundary needs. Nothing to change here — recorded so the
-- audit is visible rather than assumed.

notify pgrst, 'reload schema';
