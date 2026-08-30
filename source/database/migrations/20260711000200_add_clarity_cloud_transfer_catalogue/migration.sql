alter table public.video_transfer_sessions
  add column if not exists provider_id text not null default 'google-drive',
  add column if not exists catalogue_status text not null default 'uploading',
  add column if not exists ready_to_import_at timestamptz,
  add column if not exists destination_device_id text,
  add column if not exists destination_device_name text,
  add column if not exists destination_platform text,
  add column if not exists imported_at timestamptz,
  add column if not exists import_verified_at timestamptz,
  add column if not exists cleanup_scheduled_at timestamptz,
  add column if not exists cleanup_after timestamptz,
  add column if not exists cleanup_status text not null default 'not_scheduled',
  add column if not exists import_receipt_json text not null default '{}',
  add column if not exists provider_folder_link text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'video_transfer_sessions_provider_id_check'
  ) then
    alter table public.video_transfer_sessions
      add constraint video_transfer_sessions_provider_id_check
      check (provider_id in ('google-drive'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'video_transfer_sessions_catalogue_status_check'
  ) then
    alter table public.video_transfer_sessions
      add constraint video_transfer_sessions_catalogue_status_check
      check (
        catalogue_status in (
          'uploading',
          'ready_to_import',
          'importing',
          'imported',
          'cleanup_scheduled',
          'complete',
          'repair_required',
          'failed',
          'cancelled',
          'expired'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'video_transfer_sessions_cleanup_status_check'
  ) then
    alter table public.video_transfer_sessions
      add constraint video_transfer_sessions_cleanup_status_check
      check (cleanup_status in ('not_scheduled', 'scheduled', 'complete', 'failed'));
  end if;
end $$;

create index if not exists video_transfer_sessions_catalogue_status_idx
  on public.video_transfer_sessions (account_id, catalogue_status, updated_at desc);

create index if not exists video_transfer_sessions_ready_to_import_idx
  on public.video_transfer_sessions (account_id, ready_to_import_at desc)
  where catalogue_status in ('ready_to_import', 'importing', 'imported', 'cleanup_scheduled', 'complete', 'repair_required');

comment on column public.video_transfer_sessions.catalogue_status is
  'Clarity Cloud product lifecycle state. Upload completion becomes ready_to_import; imported/complete require a verified Local Storage import receipt.';

comment on column public.video_transfer_sessions.import_receipt_json is
  'Server-owned import receipt from the destination device after Local Storage write and verification.';
