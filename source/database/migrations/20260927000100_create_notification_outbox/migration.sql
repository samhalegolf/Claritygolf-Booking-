-- Durable, booking-scoped notification delivery.
--
-- Calendar writes only create/update an intent in this table. A scheduled
-- worker atomically claims due rows and owns provider delivery/retry. The
-- partial unique index keeps one unsettled intent per booking while retaining
-- completed rows as an audit trail.

create table if not exists public.notification_outbox (
  id text primary key,
  account_id text not null,
  calendar_item_id text not null,
  action text not null check (action in ('booking', 'rescheduled', 'updated', 'cancelled')),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry', 'sent', 'cancelled')),
  source text not null default 'calendar-state',
  appointment jsonb not null,
  previous_appointment jsonb,
  original_position_signature text,
  target_signature text,
  queued_at timestamptz not null default now(),
  due_at timestamptz not null,
  first_attempted_at timestamptz,
  attempted_at timestamptz,
  sent_at timestamptz,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  claim_token text,
  claim_expires_at timestamptz,
  provider_result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists notification_outbox_one_active_booking
  on public.notification_outbox (account_id, calendar_item_id)
  where status in ('queued', 'processing', 'retry');

create index if not exists notification_outbox_due
  on public.notification_outbox (
    coalesce(next_attempt_at, due_at),
    queued_at
  )
  where status in ('queued', 'retry');

create index if not exists notification_outbox_expired_claim
  on public.notification_outbox (claim_expires_at)
  where status = 'processing';

alter table public.notification_history
  add column if not exists notification_job_id text;

create index if not exists idx_notification_history_job
  on public.notification_history (notification_job_id, created_at asc)
  where notification_job_id is not null and notification_job_id <> '';

-- These are server-owned delivery records. Browser roles do not need direct
-- Data API access; all reads and writes go through authenticated functions.
alter table public.notification_outbox enable row level security;
revoke all on table public.notification_outbox from anon, authenticated;

notify pgrst, 'reload schema';
