create table if not exists public.video_transfer_sessions (
  transfer_id text primary key,
  saved_video_id text not null,
  account_id text not null,
  player_id text not null,
  lesson_id text,
  analysis_id text not null,
  status text not null check (
    status in (
      'preparing',
      'uploading',
      'paused',
      'verifying',
      'ready',
      'failed',
      'cancelled',
      'expired'
    )
  ),
  expected_size_bytes bigint not null check (expected_size_bytes > 0),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-fA-F0-9]{64}$'),
  accepted_offset_bytes bigint not null default 0 check (accepted_offset_bytes >= 0),
  chunk_size_bytes integer not null check (chunk_size_bytes > 0),
  drive_asset_folder_id text not null,
  drive_video_file_id text,
  drive_manifest_file_id text,
  drive_analysis_file_id text,
  resumable_session_url text not null,
  resumable_session_created_at timestamptz not null,
  resumable_session_expires_at timestamptz,
  source_device_id text,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists video_transfer_sessions_one_active_saved_video
  on public.video_transfer_sessions (account_id, saved_video_id)
  where status in ('preparing', 'uploading', 'paused', 'verifying');

create index if not exists video_transfer_sessions_account_status_idx
  on public.video_transfer_sessions (account_id, status, updated_at desc);

create index if not exists video_transfer_sessions_saved_video_idx
  on public.video_transfer_sessions (account_id, saved_video_id, updated_at desc);

alter table public.video_transfer_sessions enable row level security;

drop policy if exists "Service role manages video transfer sessions" on public.video_transfer_sessions;

-- Netlify preview Postgres does not expose Supabase's auth schema, so this
-- migration intentionally creates no Supabase-auth-helper client policy.
-- RLS remains enabled; normal RLS-bound clients have no table policy, and all
-- access is owned by service-role server paths.

comment on table public.video_transfer_sessions is
  'Server-owned Google Drive resumable upload session state. resumable_session_url is secret and must only be accessed with the service role.';
