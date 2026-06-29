-- Run this once in the Supabase project used by Clarity Booking before
-- deploying the Supabase-backed booking functions.

create table if not exists public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.calendar_items (
  id text primary key,
  account_id text,
  kind text not null,
  week integer not null default 0,
  day integer not null,
  start integer not null,
  duration integer not null,
  coach_id text,
  location_id text,
  service_id text,
  client text,
  title text not null,
  phone text,
  email text,
  note text,
  coach jsonb,
  location jsonb,
  custom_group jsonb,
  status text not null default 'booked'
    check (status in ('booked', 'completed', 'cancelled', 'no_show')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_calendar_items_slot
  on public.calendar_items (week, day, start);

create index if not exists idx_calendar_items_account_slot
  on public.calendar_items (account_id, week, day, start);

create table if not exists public.people (
  id text primary key,
  name text not null,
  email text,
  phone text,
  notes text,
  source text,
  caddy_profile_id text,
  caddy_profile_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Email is a contact channel, not a person identity. Families, schools and
-- organisations may legitimately share one address.
drop index if exists public.idx_people_email_unique;

create index if not exists idx_people_email_lookup
  on public.people (lower(email))
  where email is not null and email <> '';

create index if not exists idx_people_name_phone_lookup
  on public.people (lower(name), phone)
  where phone is not null and phone <> '';

create table if not exists public.admin_users (
  id text primary key,
  email text unique not null,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_sessions (
  id text primary key,
  token_hash text unique not null,
  user_id text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_password_resets (
  id text primary key,
  token_hash text unique not null,
  user_id text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.notification_history (
  id text primary key,
  person_key text,
  calendar_item_id text,
  recipient text not null,
  subject text not null,
  kind text not null,
  status text not null,
  provider text,
  provider_id text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_notification_history_person
  on public.notification_history (person_key, created_at desc);

create index if not exists idx_notification_history_item
  on public.notification_history (calendar_item_id, created_at desc);

create index if not exists idx_notification_history_provider
  on public.notification_history (provider_id)
  where provider_id is not null and provider_id <> '';

create table if not exists public.notification_webhook_events (
  id text primary key,
  provider_id text,
  event_type text not null,
  payload text,
  received_at timestamptz not null default now()
);

alter table public.settings enable row level security;
alter table public.calendar_items enable row level security;
alter table public.people enable row level security;
alter table public.admin_users enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.admin_password_resets enable row level security;
alter table public.notification_history enable row level security;
alter table public.notification_webhook_events enable row level security;
